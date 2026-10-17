import { statSync } from 'fs';
import { basename } from 'path';
import { logger } from '../utils/logger.js';
import { listTranscriptFiles, loadSessionIndex } from '../transcript/discovery.js';
import { chunkTranscript } from '../embedding/chunker.js';
import { type EmbeddingProvider, sameIdentity } from '../embedding/provider.js';
import {
  insertChunks,
  getIndexState,
  setIndexState,
  clearProject,
  getIndexIdentity,
  prepareVectorIndex,
} from './store.js';

const EMBED_BATCH_SIZE = 32;

export interface IndexProgress {
  phase: string;
  current: number;
  total: number;
  detail?: string;
}

/**
 * Build the semantic index for one or more projects.
 *
 * A rebuild after an embedding model change resets the whole index (all projects share one vector
 * space) and re-indexes the requested projects; the others are re-indexed on their next search
 * or with project="all". resetAll reports it.
 */
export async function buildIndex(
  provider: EmbeddingProvider,
  projectDirs: string[],
  options: {
    sessionId?: string;
    includeSubagents?: boolean;
    rebuild?: boolean;
    onProgress?: (progress: IndexProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{
  totalChunks: number;
  totalEmbedded: number;
  filesProcessed: number;
  skipped: number;
  errors: string[];
  resetAll: boolean;
}> {
  const { sessionId, includeSubagents = true, rebuild = false, onProgress, signal } = options;

  // The provider's identity (model, vector size) decides how the index is prepared
  if (!provider.isReady()) {
    onProgress?.({ phase: 'Initializing embedding model', current: 0, total: 1 });
    await provider.initialize();
  }

  const stored = getIndexIdentity();
  const resetAll = rebuild && stored !== null && !sameIdentity(stored, provider.identity);
  if (resetAll) {
    logger.info('Embedding model changed: resetting the whole index');
  }
  // Throws IndexMismatchError when the model changed and this is not a rebuild
  prepareVectorIndex(provider.identity, { resetAll });

  if (rebuild && !resetAll) {
    logger.info('Rebuilding index from scratch...');
    for (const dir of projectDirs) {
      clearProject(dir);
    }
  }

  let totalChunks = 0;
  let totalEmbedded = 0;
  let filesProcessed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const projectDir of projectDirs) {
    let files = listTranscriptFiles(projectDir, {
      includeSubagents,
      sessionId,
    });

    // Filter to specific session if requested (for main transcripts only, subagents already filtered by discovery)
    if (sessionId && !includeSubagents) {
      files = files.filter((f) => basename(f, '.jsonl') === sessionId);
    }

    const totalFiles = files.length;
    onProgress?.({ phase: `Processing ${projectDir}`, current: 0, total: totalFiles });

    for (let fi = 0; fi < files.length; fi++) {
      if (signal?.aborted) break;

      const filePath = files[fi];
      const fileSessionId = basename(filePath, '.jsonl');

      onProgress?.({
        phase: `Processing ${projectDir}`,
        current: fi + 1,
        total: totalFiles,
        detail: `Session ${fileSessionId.slice(0, 8)}...`,
      });

      // Check if file needs indexing
      try {
        const stat = statSync(filePath);
        const indexState = getIndexState(filePath);

        if (indexState && !rebuild) {
          if (indexState.file_size === stat.size) {
            // File unchanged
            skipped++;
            continue;
          }
        }

        // Chunk the file
        const fromLine = !rebuild && indexState ? indexState.last_line + 1 : 1;
        const { chunks, lastLine } = await chunkTranscript(
          filePath,
          fileSessionId,
          projectDir,
          { fromLine },
        );

        if (chunks.length === 0) {
          setIndexState(filePath, stat.size, lastLine || fromLine);
          skipped++;
          continue;
        }

        totalChunks += chunks.length;

        // Embed in batches
        for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
          const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
          const texts = batch.map((c) => c.embed_text);

          const embeddings = await provider.embed(texts);
          const inserted = insertChunks(batch, embeddings);
          totalEmbedded += inserted;
        }

        // Update index state
        setIndexState(filePath, stat.size, lastLine);
        filesProcessed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error processing ${filePath}:`, msg);
        if (errors.length < 5) {
          errors.push(`${basename(filePath, '.jsonl').slice(0, 8)}...: ${msg.slice(0, 200)}`);
        }
      }
    }
  }

  logger.info(`Indexing complete: ${totalChunks} chunks, ${totalEmbedded} embedded, ${filesProcessed} files, ${skipped} skipped`);

  return { totalChunks, totalEmbedded, filesProcessed, skipped, errors, resetAll };
}
