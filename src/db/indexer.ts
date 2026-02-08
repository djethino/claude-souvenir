import { statSync } from 'fs';
import { basename } from 'path';
import { logger } from '../utils/logger.js';
import { listTranscriptFiles, loadSessionIndex } from '../transcript/discovery.js';
import { chunkTranscript } from '../embedding/chunker.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import {
  getDb,
  insertChunks,
  getIndexState,
  setIndexState,
  clearProject,
  clearAll,
  getStoredProvider,
  setStoredProvider,
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
 */
export async function buildIndex(
  provider: EmbeddingProvider,
  projectDirs: string[],
  options: {
    sessionId?: string;
    rebuild?: boolean;
    onProgress?: (progress: IndexProgress) => void;
  } = {},
): Promise<{
  totalChunks: number;
  totalEmbedded: number;
  filesProcessed: number;
  skipped: number;
}> {
  const { sessionId, rebuild = false, onProgress } = options;

  // Initialize database
  getDb(provider.dimensions);

  // Check for provider mismatch
  const storedProvider = getStoredProvider();
  if (storedProvider && !rebuild) {
    if (storedProvider.dimensions !== provider.dimensions) {
      throw new Error(
        `Embedding dimensions mismatch: index was built with ${storedProvider.dimensions}d ` +
        `but current provider uses ${provider.dimensions}d. ` +
        `Use action="rebuild" to re-index with the new provider.`,
      );
    }
  }

  // Initialize embedding provider
  if (!provider.isReady()) {
    onProgress?.({ phase: 'Initializing embedding model', current: 0, total: 1 });
    await provider.initialize();
  }

  // Handle rebuild
  if (rebuild) {
    logger.info('Rebuilding index from scratch...');
    for (const dir of projectDirs) {
      clearProject(dir);
    }
  }

  // Store provider info
  setStoredProvider(provider.name, provider.dimensions);

  let totalChunks = 0;
  let totalEmbedded = 0;
  let filesProcessed = 0;
  let skipped = 0;

  for (const projectDir of projectDirs) {
    let files = listTranscriptFiles(projectDir);

    // Filter to specific session if requested
    if (sessionId) {
      files = files.filter((f) => basename(f, '.jsonl') === sessionId);
    }

    const totalFiles = files.length;
    onProgress?.({ phase: `Processing ${projectDir}`, current: 0, total: totalFiles });

    for (let fi = 0; fi < files.length; fi++) {
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
        logger.error(`Error processing ${filePath}:`, err);
      }
    }
  }

  logger.info(`Indexing complete: ${totalChunks} chunks, ${totalEmbedded} embedded, ${filesProcessed} files, ${skipped} skipped`);

  return { totalChunks, totalEmbedded, filesProcessed, skipped };
}
