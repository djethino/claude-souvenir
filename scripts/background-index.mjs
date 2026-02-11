#!/usr/bin/env node

/**
 * Background indexation script for claude-recall hooks.
 * Called async by Stop, PostToolUse, UserPromptSubmit, PreCompact hooks.
 *
 * Uses a lock file + timestamp to debounce across hook invocations
 * (each hook = new process, so debounce must be file-based).
 *
 * Loads the embedding model each time (~2-5s), but:
 * - Debounced at 30s → max once per 30s
 * - Async hook → never blocks Claude
 * - Incremental → only indexes new content
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const RECALL_DIR = join(homedir(), '.claude', 'claude-recall');
const LOCK_FILE = join(RECALL_DIR, 'bg-index.lock');
const MIN_INTERVAL_MS = 30_000; // 30s debounce

// ── Debounce check ──────────────────────────────────────────────────────────
mkdirSync(RECALL_DIR, { recursive: true });

try {
  if (existsSync(LOCK_FILE)) {
    const content = readFileSync(LOCK_FILE, 'utf-8').trim();
    const lastRun = parseInt(content, 10);
    if (!isNaN(lastRun) && (Date.now() - lastRun) < MIN_INTERVAL_MS) {
      process.exit(0); // Too recent, skip
    }
  }
} catch {
  // Ignore read errors, proceed
}

// Write lock immediately (before async work starts)
writeFileSync(LOCK_FILE, String(Date.now()), 'utf-8');

// ── Resolve current project from hook stdin ─────────────────────────────────
let cwd;
try {
  const input = readFileSync(0, 'utf-8');
  const data = JSON.parse(input);
  cwd = data.cwd;
} catch {
  cwd = process.cwd();
}

if (!cwd) {
  process.exit(0);
}

// ── Build import paths ──────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, '..', 'build');

// Set CWD env so getConfig() detects the project
process.env.CWD = cwd;

// ── Run indexation ──────────────────────────────────────────────────────────
async function run() {
  const { getConfig } = await import(`file:///${join(buildDir, 'config.js').replace(/\\/g, '/')}`);
  const { createEmbeddingProvider } = await import(`file:///${join(buildDir, 'tools', 'helpers.js').replace(/\\/g, '/')}`);
  const { buildIndex } = await import(`file:///${join(buildDir, 'db', 'indexer.js').replace(/\\/g, '/')}`);

  const config = getConfig();
  if (!config.currentProject) {
    return; // CWD doesn't match any known project
  }

  const provider = createEmbeddingProvider(config);
  try {
    await provider.initialize();
    const result = await buildIndex(provider, [config.currentProject], { rebuild: false });
    if (result.totalEmbedded > 0) {
      process.stderr.write(`[claude-recall] Background index: ${result.totalEmbedded} new chunks\n`);
    }
  } finally {
    await provider.dispose();
  }
}

run().catch((err) => {
  process.stderr.write(`[claude-recall] Background index error: ${err?.message || err}\n`);
}).finally(() => {
  // Clean lock when done (allow next run)
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
});
