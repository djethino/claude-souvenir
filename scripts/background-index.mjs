#!/usr/bin/env node

/**
 * Background indexation script for claude-souvenir hooks.
 * Called async by Stop, PostToolUse, UserPromptSubmit, PreCompact hooks.
 *
 * Uses a lock file + timestamp to debounce across hook invocations
 * (each hook = new process, so debounce must be file-based).
 *
 * With Ollama provider: initialization is a simple HTTP check (~2ms).
 * The embedding model stays loaded in Ollama, shared across all processes.
 * - Debounced at 30s → max once per 30s
 * - Async hook → never blocks Claude
 * - Incremental → only indexes new content
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const SOUVENIR_DIR = join(homedir(), '.claude', 'claude-souvenir');
const LOCK_FILE = join(SOUVENIR_DIR, 'bg-index.lock');
const MIN_INTERVAL_MS = 30_000; // 30s debounce

// ── Debounce check ──────────────────────────────────────────────────────────
mkdirSync(SOUVENIR_DIR, { recursive: true });

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
  const { getConfig } = await import(pathToFileURL(join(buildDir, 'config.js')).href);
  const { createEmbeddingProvider } = await import(pathToFileURL(join(buildDir, 'tools', 'helpers.js')).href);
  const { buildIndex } = await import(pathToFileURL(join(buildDir, 'db', 'indexer.js')).href);
  const { buildDocsIndex } = await import(pathToFileURL(join(buildDir, 'docs', 'indexer.js')).href);
  const { docsDbExists, getDocSources } = await import(pathToFileURL(join(buildDir, 'docs', 'store.js')).href);

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
      process.stderr.write(`[claude-souvenir] Background index: ${result.totalEmbedded} new transcript chunks\n`);
    }

    // 2. Index docs (local DB) if sources are configured
    const projectRoot = config.cwd;
    if (projectRoot && docsDbExists(projectRoot)) {
      const sources = getDocSources(projectRoot);
      if (sources.length > 0) {
        const docsResult = await buildDocsIndex(projectRoot, provider, { rebuild: false });
        if (docsResult.totalEmbedded > 0) {
          process.stderr.write(`[claude-souvenir] Background index: ${docsResult.totalEmbedded} new doc chunks\n`);
        }
      }
    }
  } finally {
    await provider.dispose();
  }
}

run().catch((err) => {
  process.stderr.write(`[claude-souvenir] Background index error: ${err?.message || err}\n`);
}).finally(() => {
  // Clean lock when done (allow next run)
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
});
