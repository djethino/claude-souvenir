import { logger } from '../utils/logger.js';
import { getConfig } from '../config.js';
import { getOrCreateProvider } from '../tools/helpers.js';
import { buildIndex } from '../db/indexer.js';
import { buildDocsIndex } from '../docs/indexer.js';
import { docsDbExists, getDocSources } from '../docs/store.js';

// Debounce state
let _indexing = false;
let _indexingPromise: Promise<void> | null = null;
let _lastIndexTime = 0;
const MIN_INTERVAL_MS = 30_000; // Don't index more than once per 30s

// Shutdown coordination
const _abortController = new AbortController();

/**
 * Signal all background indexing to stop.
 * Does NOT wait for completion — use waitForIndexing() after this.
 */
export function abortBackgroundIndex(): void {
  _abortController.abort();
}

/**
 * Wait for any in-progress background indexing to finish.
 * Returns immediately if nothing is running.
 * Respects a timeout to avoid hanging on shutdown.
 */
export async function waitForIndexing(timeoutMs = 5_000): Promise<void> {
  if (!_indexingPromise) return;

  try {
    await Promise.race([
      _indexingPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // Indexing error during shutdown — ignore
  }
}

/**
 * Check if background indexing is currently running.
 */
export function isIndexing(): boolean {
  return _indexing;
}

/**
 * Schedule a background index of the current project.
 * Indexes both transcripts (global DB) and project docs (local DB) if configured.
 * Debounced: skips if already running or if last run was < 30s ago.
 * Uses the singleton provider (already loaded in memory → fast).
 * Fire-and-forget: errors are logged, not thrown.
 */
export function scheduleBackgroundIndex(): void {
  const now = Date.now();

  // Skip if already running, too recent, or shutting down
  if (_indexing || (now - _lastIndexTime) < MIN_INTERVAL_MS || _abortController.signal.aborted) {
    return;
  }

  const config = getConfig();
  const projectDir = config.currentProject;
  if (!projectDir) return;

  _indexing = true;
  _lastIndexTime = now;
  const signal = _abortController.signal;

  // Fire and forget — but keep the promise for shutdown coordination
  _indexingPromise = (async () => {
    try {
      if (signal.aborted) return;

      const provider = getOrCreateProvider(config);
      if (!provider.isReady()) {
        await provider.initialize();
      }

      if (signal.aborted) return;

      // 1. Index transcripts (global DB)
      const result = await buildIndex(provider, [projectDir], {
        rebuild: false,
        signal,
      });
      if (result.totalEmbedded > 0) {
        logger.info(`Background index: ${result.totalEmbedded} new transcript chunks for current project`);
      }

      if (signal.aborted) return;

      // 2. Index docs (local DB) if sources are configured
      const projectRoot = config.cwd;
      if (projectRoot && docsDbExists(projectRoot)) {
        const sources = getDocSources(projectRoot);
        if (sources.length > 0) {
          const docsResult = await buildDocsIndex(projectRoot, provider, {
            rebuild: false,
            signal,
          });
          if (docsResult.totalEmbedded > 0) {
            logger.info(`Background index: ${docsResult.totalEmbedded} new doc chunks for current project`);
          }
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        logger.warn('Background index failed:', err);
      }
    } finally {
      _indexing = false;
      _indexingPromise = null;
    }
  })();
}
