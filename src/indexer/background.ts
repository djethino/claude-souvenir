import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import { getConfig } from '../config.js';
import { getOrCreateProvider } from '../tools/helpers.js';
import { buildIndex } from '../db/indexer.js';

const TRIGGER_DIR = join(homedir(), '.claude', 'claude-recall');
const TRIGGER_FILE = join(TRIGGER_DIR, 'index-trigger');

// Debounce state
let _indexing = false;
let _lastIndexTime = 0;
const MIN_INTERVAL_MS = 30_000; // Don't index more than once per 30s

/**
 * Check if a trigger file exists (written by Stop hook or external signal).
 * If found, consume it and return true.
 */
export function consumeTriggerFlag(): boolean {
  try {
    if (existsSync(TRIGGER_FILE)) {
      unlinkSync(TRIGGER_FILE);
      return true;
    }
  } catch {
    // Ignore errors (race condition, permissions)
  }
  return false;
}

/**
 * Write the trigger flag file (used by the Stop hook script).
 */
export function writeTriggerFlag(): void {
  try {
    mkdirSync(TRIGGER_DIR, { recursive: true });
    writeFileSync(TRIGGER_FILE, String(Date.now()), 'utf-8');
  } catch {
    // Ignore errors
  }
}

/**
 * Schedule a background index of the current project.
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

      const result = await buildIndex(provider, [projectDir], { rebuild: false });
      if (result.totalEmbedded > 0) {
        logger.info(`Background index: ${result.totalEmbedded} new chunks indexed for current project`);
      }
    } catch (err) {
      logger.warn('Background index failed:', err);
    } finally {
      _indexing = false;
    }
  })();
}
