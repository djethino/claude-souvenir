import { logger } from '../utils/logger.js';
import { getConfig } from '../config.js';
import { getOrCreateProvider } from '../tools/helpers.js';
import { buildIndex } from '../db/indexer.js';
import { buildDocsIndex } from '../docs/indexer.js';
import { docsDbExists, getDocSources } from '../docs/store.js';

// Debounce state
let _indexing = false;
let _lastIndexTime = 0;
const MIN_INTERVAL_MS = 30_000; // Don't index more than once per 30s

/**
 * Schedule a background index of the current project.
 * Indexes both transcripts (global DB) and project docs (local DB) if configured.
 * Debounced: skips if already running or if last run was < 30s ago.
 * Uses the singleton provider (already loaded in memory → fast).
 * Fire-and-forget: errors are logged, not thrown.
 */
export function scheduleBackgroundIndex(): void {
  const now = Date.now();

  // Skip if already running or too recent
  if (_indexing || (now - _lastIndexTime) < MIN_INTERVAL_MS) {
    return;
  }

  const config = getConfig();
  const projectDir = config.currentProject;
  if (!projectDir) return;

  _indexing = true;
  _lastIndexTime = now;

  // Fire and forget
  (async () => {
    try {
      const provider = getOrCreateProvider(config);
      if (!provider.isReady()) {
        await provider.initialize();
      }

      // 1. Index transcripts (global DB)
      const result = await buildIndex(provider, [projectDir], { rebuild: false });
      if (result.totalEmbedded > 0) {
        logger.info(`Background index: ${result.totalEmbedded} new transcript chunks for current project`);
      }

      // 2. Index docs (local DB) if sources are configured
      const projectRoot = config.cwd;
      if (projectRoot && docsDbExists(projectRoot)) {
        const sources = getDocSources(projectRoot);
        if (sources.length > 0) {
          const docsResult = await buildDocsIndex(projectRoot, provider, { rebuild: false });
          if (docsResult.totalEmbedded > 0) {
            logger.info(`Background index: ${docsResult.totalEmbedded} new doc chunks for current project`);
          }
        }
      }
    } catch (err) {
      logger.warn('Background index failed:', err);
    } finally {
      _indexing = false;
    }
  })();
}
