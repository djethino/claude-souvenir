/**
 * Background indexation entry point for souvenir hooks.
 * Called async by Stop, PostToolUse, UserPromptSubmit, PreCompact hooks.
 *
 * Each hook is a new process, so coordination is file-based:
 * - bg-index.lock holds the PID of the run in progress: one indexation at a time across all
 *   sessions; a lock whose process no longer exists is stale and taken over.
 * - bg-index.last holds when the last run finished: runs are at least 30s apart.
 *
 * With Ollama provider: initialization is a simple HTTP check (~2ms).
 * The embedding model stays loaded in Ollama, shared across all processes.
 * - Async hook → never blocks Claude
 * - Incremental → only indexes new content
 */

import { readFileSync, writeFileSync, writeSync, mkdirSync, unlinkSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import { getSouvenirDir } from './utils/paths.js';
import { getConfig } from './config.js';
import { createEmbeddingProvider } from './tools/helpers.js';
import { buildIndex } from './db/indexer.js';
import { buildDocsIndex } from './docs/indexer.js';
import { docsDbExists, getDocSources } from './docs/store.js';

const SOUVENIR_DIR = getSouvenirDir();
const LOCK_FILE = join(SOUVENIR_DIR, 'bg-index.lock');
const LAST_RUN_FILE = join(SOUVENIR_DIR, 'bg-index.last');
const MIN_INTERVAL_MS = 30_000; // 30s debounce

mkdirSync(SOUVENIR_DIR, { recursive: true });

// ── Debounce: skip if the last run finished less than 30s ago ───────────────
try {
  const lastRun = parseInt(readFileSync(LAST_RUN_FILE, 'utf-8'), 10);
  if (!isNaN(lastRun) && Date.now() - lastRun < MIN_INTERVAL_MS) {
    process.exit(0);
  }
} catch {
  // No previous run recorded
}

/** Whether a process with this PID is running. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Create the lock atomically (O_EXCL); take over a stale lock once. Returns false if another run holds it. */
function acquireLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = parseInt(readFileSync(LOCK_FILE, 'utf-8'), 10);
      if (!isNaN(holder) && isRunning(holder)) return false;
      // Stale lock (its process exited without cleaning up): remove it and retry
      try { unlinkSync(LOCK_FILE); } catch { /* another process took it over first */ }
    }
  }
  return false;
}

// ── Resolve current project from hook stdin ─────────────────────────────────
let cwd: string | undefined;
try {
  const data = JSON.parse(readFileSync(0, 'utf-8')) as { cwd?: string };
  cwd = data.cwd;
} catch {
  cwd = process.cwd();
}

if (!cwd || !acquireLock()) {
  process.exit(0);
}

// Set CWD env so getConfig() detects the project
process.env.CWD = cwd;

// ── Run indexation ──────────────────────────────────────────────────────────
async function run(): Promise<void> {
  const config = getConfig();
  if (!config.currentProject) {
    return; // CWD doesn't match any known project
  }

  const provider = createEmbeddingProvider(config);
  try {
    await provider.initialize();

    // 1. Index transcripts (global DB)
    const result = await buildIndex(provider, [config.currentProject], { rebuild: false });
    if (result.totalEmbedded > 0) {
      process.stderr.write(`[souvenir] Background index: ${result.totalEmbedded} new transcript chunks\n`);
    }

    // 2. Index docs (local DB) if sources are configured
    const projectRoot = config.cwd;
    if (projectRoot && docsDbExists(projectRoot)) {
      const sources = getDocSources(projectRoot);
      if (sources.length > 0) {
        const docsResult = await buildDocsIndex(projectRoot, provider, { rebuild: false });
        if (docsResult.totalEmbedded > 0) {
          process.stderr.write(`[souvenir] Background index: ${docsResult.totalEmbedded} new doc chunks\n`);
        }
      }
    }
  } finally {
    await provider.dispose();
  }
}

run().catch((err) => {
  process.stderr.write(`[souvenir] Background index error: ${err?.message || err}\n`);
}).finally(() => {
  // Record the end of this run for the debounce, then let the next run take the lock
  writeFileSync(LAST_RUN_FILE, String(Date.now()));
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
});
