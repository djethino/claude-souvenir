import { logger } from '../utils/logger.js';
import { serialized } from '../utils/serial.js';
import { CHUNK_TEXT_FORMAT, chunkTranscript } from '../embedding/chunker.js';
import { withChunkText } from '../embedding/chunk-text.js';
import { type EmbeddingProvider, sameIdentity } from '../embedding/provider.js';
import { archiveProjects, type ArchiveReport } from '../archive/archiver.js';
import { getArchivedFiles, type ArchivedFileRow } from '../archive/store.js';
import {
  appendChunks,
  markProjectIndexed,
  setIndexStateIfAbsent,
  rangeNeedsReindex,
  type NewChunk,
  getIndexState,
  setIndexState,
  replaceTranscriptChunks,
  getTranscriptsWithOldChunks,
  getIndexIdentity,
  prepareVectorIndex,
  hasPendingVectors,
  getChunksWithoutVectors,
  insertVectors,
  clearPendingVectors,
} from './store.js';

const EMBED_BATCH_SIZE = 32;
/** Chunks re-indexed per transaction when replacing a transcript's chunks (seconds of embedding). */
const REINDEX_BATCH_CHUNKS = 256;
/** Chunks scanned per page when giving vectors back to kept chunks after a model change. */
const PENDING_PAGE_SIZE = 2000;

export interface IndexProgress {
  phase: string;
  current: number;
  total: number;
  detail?: string;
}

interface BuildIndexOptions {
  sessionId?: string;
  includeSubagents?: boolean;
  rebuild?: boolean;
  onProgress?: (progress: IndexProgress) => void;
  signal?: AbortSignal;
}

interface BuildIndexResult {
  totalChunks: number;
  totalEmbedded: number;
  filesProcessed: number;
  skipped: number;
  errors: string[];
  resetAll: boolean;
  /** Archiving done before indexing (the index is built from the archive) */
  archive: ArchiveReport;
}

/**
 * Build the semantic index for one or more projects, from the archive: what Claude Code wrote
 * since the last copy is archived first, then the new archived lines are chunked and embedded.
 *
 * Builds in this process run one after the other: read-only tools are called in parallel
 * (searches auto-index before searching, tools schedule a background index), and two concurrent
 * builds would embed the same new chunks twice. A queued build finds the transcripts the previous
 * one indexed unchanged and skips them.
 *
 * A rebuild cuts the chunks of archived transcripts again from the archive, one transcript at a
 * time, each replacing the old ones in one transaction (searches stay complete meanwhile); the
 * chunks of partial sessions (transcripts deleted before souvenir archived them) are the only
 * trace of those sessions and are never deleted. After an embedding model change, a rebuild
 * resets the vectors of every project (they share one vector space) and re-indexes the requested
 * projects; the others are re-indexed on their next search or with project="all". resetAll
 * reports it.
 */
export function buildIndex(...args: Parameters<typeof runBuildIndex>): ReturnType<typeof runBuildIndex> {
  return exclusive(() => runBuildIndex(...args));
}

/** Index work of this process runs one task at a time (builds, upgrades of old chunks). */
const exclusive = serialized(<T>(task: () => Promise<T>): Promise<T> => task()) as <T>(task: () => Promise<T>) => Promise<T>;


async function runBuildIndex(
  provider: EmbeddingProvider,
  projectDirs: string[],
  options: BuildIndexOptions = {},
): Promise<BuildIndexResult> {
  const { sessionId, includeSubagents = true, rebuild = false, onProgress, signal } = options;

  const archive = await archiveProjects(projectDirs, { onProgress, signal });

  // The provider's identity (model, vector size) decides how the index is prepared
  if (!provider.isReady()) {
    onProgress?.({ phase: 'Initializing embedding model', current: 0, total: 1 });
    await provider.initialize();
  }

  const stored = getIndexIdentity();
  const resetAll = rebuild && stored !== null && !sameIdentity(stored, provider.identity);
  if (resetAll) {
    logger.info('Embedding model changed: resetting the vectors of every project');
  }
  // Throws IndexMismatchError when the model changed and this is not a rebuild
  prepareVectorIndex(provider.identity, { resetAll });

  if (rebuild && !resetAll) {
    logger.info('Rebuilding index from the archive...');
  }

  let totalChunks = 0;
  let totalEmbedded = 0;
  let filesProcessed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const projectDir of projectDirs) {
    let complete = !sessionId; // only a build of the whole project ends its first indexation
    const files = getArchivedFiles(projectDir).filter((f) => {
      if (f.parent_session_id !== null && !includeSubagents) return false;
      return !sessionId || f.session_id === sessionId || f.parent_session_id === sessionId;
    });

    const totalFiles = files.length;
    onProgress?.({ phase: `Indexing ${projectDir}`, current: 0, total: totalFiles });

    for (let fi = 0; fi < files.length; fi++) {
      if (signal?.aborted) {
        complete = false;
        break;
      }

      const file = files[fi];
      onProgress?.({
        phase: `Indexing ${projectDir}`,
        current: fi + 1,
        total: totalFiles,
        detail: `Session ${file.session_id.slice(0, 8)}...`,
      });

      try {
        // Rebuild: cut what was indexed again, replacing its chunks; the new lines follow below
        let replaced = 0;
        if (rebuild && !resetAll) {
          const outcome = await reindexTranscript(provider, file, { onlyOutdated: false, signal });
          replaced = outcome.embedded;
          totalEmbedded += outcome.embedded;
          totalChunks += outcome.embedded;
          if (!outcome.done) break; // aborted
        }

        const indexState = getIndexState(file.file_key);
        if (indexState && indexState.last_line >= file.line_count) {
          if (replaced > 0) filesProcessed++;
          else skipped++;
          continue;
        }

        const fromLine = indexState ? indexState.last_line + 1 : 1;
        const { chunks, lastLine } = chunkTranscript(file, fromLine);

        // Batches of whole texts, each written with the index progress up to its last line: an
        // interrupted or late build keeps what it did, the next one goes on from there
        let expected = indexState?.last_line ?? null;
        let added = 0;
        let stopped = false;
        for (const batch of textBatches(chunks, lastLine)) {
          if (signal?.aborted) {
            stopped = true;
            break;
          }
          const embeddings = await embedAll(provider, batch.chunks, signal);
          if (!embeddings) {
            stopped = true;
            break;
          }
          // Written only if no other process indexed these lines meanwhile (the MCP server and a
          // hook can index the same transcript at once, and would cut the same lines differently)
          const inserted = appendChunks(file, expected, batch.upToLine, batch.chunks, embeddings);
          if (inserted === null) break;
          added += inserted;
          totalChunks += batch.chunks.length;
          expected = batch.upToLine;
        }
        totalEmbedded += added;
        if (stopped) {
          if (added > 0) filesProcessed++;
          complete = false;
          break; // aborted
        }
        if (added > 0 || replaced > 0) filesProcessed++;
        else skipped++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error indexing ${file.file_key}:`, msg);
        if (errors.length < 5) {
          errors.push(`${file.session_id.slice(0, 8)}...: ${msg.slice(0, 200)}`);
        }
      }
    }

    if (complete && !signal?.aborted) markProjectIndexed(projectDir);

    if (!signal?.aborted && hasPendingVectors(projectDir)) {
      try {
        totalEmbedded += await embedPendingChunks(provider, projectDir, onProgress, signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error re-embedding the kept chunks of ${projectDir}:`, msg);
        if (errors.length < 5) errors.push(`${projectDir} (kept chunks): ${msg.slice(0, 200)}`);
      }
    }
  }

  logger.info(`Indexing complete: ${totalChunks} chunks, ${totalEmbedded} embedded, ${filesProcessed} files, ${skipped} skipped`);

  return { totalChunks, totalEmbedded, filesProcessed, skipped, errors, resetAll, archive };
}

/**
 * Split the new chunks of a transcript (in chunker order: a text, then the tool results inside it)
 * into batches that end after a whole text and what lies inside it, each with the line the index
 * progress can be set to once it is written: the next build cuts from the line after. The last
 * batch goes up to `lastLine`, the last line read. No chunks: one empty batch, to record progress.
 */
function textBatches(chunks: NewChunk[], lastLine: number): Array<{ chunks: NewChunk[]; upToLine: number }> {
  const batches: Array<{ chunks: NewChunk[]; upToLine: number }> = [];
  let current: NewChunk[] = [];
  let coveredTo = 0;
  for (const chunk of chunks) {
    // A chunk starting after every line covered so far begins a new text: a batch may end before it
    if (current.length >= REINDEX_BATCH_CHUNKS && chunk.line_number > coveredTo) {
      batches.push({ chunks: current, upToLine: chunk.line_number - 1 });
      current = [];
    }
    current.push(chunk);
    coveredTo = Math.max(coveredTo, chunk.end_line);
  }
  batches.push({ chunks: current, upToLine: lastLine });
  return batches;
}

/** Embeddings of chunks, in batches; null when aborted. */
async function embedAll(provider: EmbeddingProvider, chunks: NewChunk[], signal?: AbortSignal): Promise<Float32Array[] | null> {
  const embeddings: Float32Array[] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    if (signal?.aborted) return null;
    embeddings.push(...await provider.embed(chunks.slice(i, i + EMBED_BATCH_SIZE).map((c) => c.content_text)));
  }
  return embeddings;
}

/** Whether an archived transcript holds fewer lines than its index progress says were indexed. */
function archiveBehindIndex(file: ArchivedFileRow): boolean {
  const indexed = getIndexState(file.file_key);
  return indexed !== null && indexed.last_line > file.line_count;
}

/**
 * Cut the indexed lines of an archived transcript again (current chunker) and replace its chunks,
 * a range of lines at a time (about REINDEX_BATCH_CHUNKS chunks), each range in one transaction:
 * searches stay complete, and the work done before an interruption is kept. `onlyOutdated`: skip
 * the ranges whose chunks are all current, so that a run interrupted earlier resumes where it
 * stopped. Stops before a range once `deadline` has passed or `signal` is aborted (done: false).
 * A transcript never indexed is indexed whole. Throws when the archive holds fewer lines than
 * were indexed: its old chunks would be deleted without being made again.
 */
async function reindexTranscript(
  provider: EmbeddingProvider,
  file: ArchivedFileRow,
  options: { onlyOutdated: boolean; deadline?: number; signal?: AbortSignal },
): Promise<{ embedded: number; done: boolean }> {
  const indexed = getIndexState(file.file_key);
  if (indexed && indexed.last_line > file.line_count) {
    throw new Error(`${indexed.last_line} lines were indexed but the archive holds ${file.line_count}: not re-indexed until the archive catches up`);
  }
  const upToLine = indexed ? indexed.last_line : file.line_count;
  const { chunks } = chunkTranscript({ ...file, line_count: upToLine }, 1);

  // Ranges that hold whole texts (a turn with the tool results inside it): every chunk the
  // incremental runs made inside a turn is in the turn's range, replaced with it
  let embedded = 0;
  let fromLine = 1;
  for (const batch of textBatches(chunks, upToLine)) {
    const toLine = batch.upToLine;
    if (!options.onlyOutdated || rangeNeedsReindex(file, fromLine, toLine, CHUNK_TEXT_FORMAT)) {
      if (options.signal?.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)) {
        return { embedded, done: false };
      }
      const embeddings = await embedAll(provider, batch.chunks, options.signal);
      if (!embeddings) return { embedded, done: false };
      embedded += replaceTranscriptChunks(file, fromLine, toLine, batch.chunks, embeddings);
    }
    fromLine = toLine + 1;
  }
  // Only if no other process recorded progress meanwhile: it may have indexed further
  if (!indexed) setIndexStateIfAbsent(file.file_key, file.archived_bytes, upToLine);
  return { embedded, done: true };
}

export interface UpgradeResult {
  transcripts: number;
  chunks: number;
  /** Transcripts still holding chunks made before 0.6.0 */
  remaining: number;
  errors: string[];
}

/**
 * Re-index, in the background, the archived transcripts whose chunks are outdated: made before
 * 0.6.0 (text cut at 2,000 characters, first reply entry only) or by another chunker format, most
 * recently active first, until `deadline` (checked between ranges of lines). Each range's chunks
 * are replaced in one transaction, so searches stay complete while it runs, and the next run
 * resumes where this one stopped. Partial sessions are not touched.
 */
export function upgradeOldChunks(
  provider: EmbeddingProvider,
  options: { deadline: number; signal?: AbortSignal },
): Promise<UpgradeResult> {
  return exclusive(async () => {
    prepareVectorIndex(provider.identity); // throws on a model change: the user must rebuild
    const pending = getTranscriptsWithOldChunks(CHUNK_TEXT_FORMAT);
    const result: UpgradeResult = { transcripts: 0, chunks: 0, remaining: pending.length, errors: [] };
    for (const file of pending) {
      if (Date.now() >= options.deadline || options.signal?.aborted) break;
      // Waits for the archive to catch up (a later copy): re-indexing now would lose old chunks
      if (archiveBehindIndex(file)) continue;
      try {
        const outcome = await reindexTranscript(provider, file, { onlyOutdated: true, deadline: options.deadline, signal: options.signal });
        result.chunks += outcome.embedded;
        if (!outcome.done) break;
        result.transcripts++;
        result.remaining--;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error re-indexing ${file.file_key}:`, msg);
        result.errors.push(`${file.file_key}: ${msg}`);
      }
    }
    if (result.transcripts > 0) {
      logger.info(`Old index format: ${result.transcripts} transcripts re-indexed (${result.chunks} chunks), ${result.remaining} left`);
    }
    return result;
  });
}

/**
 * Give vectors back to the chunks kept through an embedding model change (partial sessions).
 * Returns how many were embedded.
 */
async function embedPendingChunks(
  provider: EmbeddingProvider,
  projectDir: string,
  onProgress: BuildIndexOptions['onProgress'],
  signal: AbortSignal | undefined,
): Promise<number> {
  let embedded = 0;
  for (let after = 0; ;) {
    // Aborted: the chunks still without vectors are found again by the next build
    if (signal?.aborted) return embedded;
    const { missing, lastChunkId } = getChunksWithoutVectors(projectDir, after, PENDING_PAGE_SIZE);
    if (lastChunkId === null) break;
    for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
      const { chunks: batch, problems } = withChunkText(missing.slice(i, i + EMBED_BATCH_SIZE));
      if (problems.length > 0) throw new Error(problems.join(' '));
      insertVectors(batch, await provider.embed(batch.map((c) => c.content_text)));
      embedded += batch.length;
    }
    onProgress?.({ phase: `Re-embedding kept excerpts of ${projectDir}`, current: embedded, total: 0 });
    after = lastChunkId;
  }
  clearPendingVectors(projectDir);
  return embedded;
}
