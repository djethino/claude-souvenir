import { logger } from '../utils/logger.js';
import { serialized } from '../utils/serial.js';
import { chunkTranscript } from '../embedding/chunker.js';
import { type EmbeddingProvider, sameIdentity } from '../embedding/provider.js';
import { archiveProjects, type ArchiveReport } from '../archive/archiver.js';
import { getArchivedFiles } from '../archive/store.js';
import {
  insertChunks,
  getIndexState,
  setIndexState,
  clearArchivedChunks,
  getIndexIdentity,
  prepareVectorIndex,
  hasPendingVectors,
  getChunksWithoutVectors,
  insertVectors,
  clearPendingVectors,
} from './store.js';

const EMBED_BATCH_SIZE = 32;
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
 * A rebuild re-creates the chunks of archived transcripts from the archive; the chunks of partial
 * sessions (transcripts deleted before souvenir archived them) are the only trace of those
 * sessions and are never deleted. After an embedding model change, a rebuild resets the vectors
 * of every project (they share one vector space) and re-indexes the requested projects; the
 * others are re-indexed on their next search or with project="all". resetAll reports it.
 */
export const buildIndex = serialized(runBuildIndex);

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
    for (const dir of projectDirs) {
      clearArchivedChunks(dir, sessionId);
    }
  }

  let totalChunks = 0;
  let totalEmbedded = 0;
  let filesProcessed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const projectDir of projectDirs) {
    const files = getArchivedFiles(projectDir).filter((f) => {
      if (f.parent_session_id !== null && !includeSubagents) return false;
      return !sessionId || f.session_id === sessionId || f.parent_session_id === sessionId;
    });

    const totalFiles = files.length;
    onProgress?.({ phase: `Indexing ${projectDir}`, current: 0, total: totalFiles });

    for (let fi = 0; fi < files.length; fi++) {
      if (signal?.aborted) break;

      const file = files[fi];
      onProgress?.({
        phase: `Indexing ${projectDir}`,
        current: fi + 1,
        total: totalFiles,
        detail: `Session ${file.session_id.slice(0, 8)}...`,
      });

      try {
        const indexState = getIndexState(file.file_key);
        if (indexState && indexState.last_line >= file.line_count) {
          skipped++;
          continue;
        }

        const fromLine = indexState ? indexState.last_line + 1 : 1;
        const { chunks, lastLine } = await chunkTranscript(file, fromLine);

        for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
          const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
          const embeddings = await provider.embed(batch.map((c) => c.content_text));
          totalEmbedded += insertChunks(batch, embeddings);
        }

        totalChunks += chunks.length;
        setIndexState(file.file_key, file.archived_bytes, lastLine);
        if (chunks.length > 0) filesProcessed++;
        else skipped++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error indexing ${file.file_key}:`, msg);
        if (errors.length < 5) {
          errors.push(`${file.session_id.slice(0, 8)}...: ${msg.slice(0, 200)}`);
        }
      }
    }

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
    if (signal?.aborted) return embedded;
    const { missing, lastChunkId } = getChunksWithoutVectors(projectDir, after, PENDING_PAGE_SIZE);
    if (lastChunkId === null) break;
    for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
      const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
      insertVectors(batch, await provider.embed(batch.map((c) => c.content_text)));
      embedded += batch.length;
    }
    onProgress?.({ phase: `Re-embedding kept excerpts of ${projectDir}`, current: embedded, total: 0 });
    after = lastChunkId;
  }
  clearPendingVectors(projectDir);
  return embedded;
}
