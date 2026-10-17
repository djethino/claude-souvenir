import { existsSync, statSync } from 'fs';
import { getConfig } from '../config.js';
import { resolveProjectDir, getDbPath } from '../utils/paths.js';
import { listProjectDirs, loadSessionIndex } from '../transcript/discovery.js';
import { buildIndex } from '../db/indexer.js';
import { getDb, getIndexStatus, getIndexIdentity, fullVacuum } from '../db/store.js';
import { docsDbExists, getDocsIndexIdentity, getDocsChunkCount } from '../docs/store.js';
import { describeIdentity, sameIdentity } from '../embedding/provider.js';
import { findModelPrompts } from '../embedding/models.js';
import { getOrCreateProvider, createProgressNotifier, errorMessage } from './helpers.js';
import type { ToolExtra } from './helpers.js';

export async function handleSouvenirIndex(params: {
  action: 'status' | 'build' | 'rebuild' | 'vacuum' | 'check';
  project?: string;
  session_id?: string;
}, extra?: ToolExtra): Promise<string> {
  let config: ReturnType<typeof getConfig>;
  try {
    config = getConfig();
  } catch (err) {
    return `Configuration error: ${errorMessage(err)}\nFix it with /plugin configure asymptomatik-souvenir, then /reload-plugins.`;
  }

  switch (params.action) {
    case 'status':
      return getStatusReport(params.project);

    case 'check':
      return await runCheck(config);

    case 'build':
    case 'rebuild':
      return await runBuild(config, { ...params, action: params.action as 'build' | 'rebuild' }, extra);

    case 'vacuum':
      return runVacuum();

    default:
      return `Unknown action: "${params.action}". Use "status", "check", "build", "rebuild", or "vacuum".`;
  }
}

function getStatusReport(projectFilter?: string): string {
  // Opening the DB reads the status without loading any embedding provider
  getDb();
  const identity = getIndexIdentity();
  const status = getIndexStatus(projectFilter ? resolveProjectDir(projectFilter) : undefined);

  const lines = ['Semantic Index Status:'];
  lines.push(`  Built with: ${identity ? describeIdentity(identity) : 'not built yet'}`);
  lines.push(`  Total chunks: ${status.totalChunks}`);
  lines.push(`  Files indexed: ${status.totalFiles}`);
  lines.push('');

  if (status.projects.length === 0) {
    lines.push('  No projects indexed yet. Run souvenir_index with action="build".');
  } else {
    for (const p of status.projects) {
      const index = loadSessionIndex(p.projectDir);
      const totalSessions = index ? index.entries.filter((e) => !e.isSidechain).length : '?';
      lines.push(`  ${p.projectDir}:`);
      lines.push(`    Chunks: ${p.chunkCount} | Sessions available: ${totalSessions}`);
      if (p.lastIndexed) lines.push(`    Last indexed: ${p.lastIndexed}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Check the effective configuration end to end: settings, embedding server, a real embedding,
 * and whether the existing indexes were built with the same model.
 */
async function runCheck(config: ReturnType<typeof getConfig>): Promise<string> {
  const { embedding } = config;
  const lines = ['Souvenir configuration check:', ''];
  const prompts = findModelPrompts(embedding.model);

  lines.push(`  Provider: ${embedding.provider} at ${embedding.url}`);
  lines.push(`  Model: ${embedding.model} (${prompts ? 'known model: its input prefixes are applied' : 'unknown model: texts are embedded without prefixes'})`);
  lines.push(`  Dimensions: ${embedding.dimensions ? `${embedding.dimensions} requested` : 'native size of the model'}`);
  if (embedding.provider === 'openai') {
    lines.push(`  API key: ${embedding.apiKey ? 'set' : 'not set (fine for local servers)'}`);
  }

  const dbPath = getDbPath();
  lines.push(`  Transcript database: ${dbPath} (${existsSync(dbPath) ? formatSize(databaseSize(dbPath)) : 'not created yet'})`);
  lines.push('');

  const provider = getOrCreateProvider(config);
  const started = Date.now();
  try {
    await provider.initialize();
    await provider.embedQuery('souvenir configuration check');
  } catch (err) {
    lines.push(`  Embedding: FAILED — ${errorMessage(err)}`);
    if (embedding.provider === 'ollama') {
      lines.push('  Make sure Ollama is installed and running (https://ollama.com), or change embedding_url.');
    } else {
      lines.push('  Check embedding_url (base URL ending in /v1), embedding_model and embedding_api_key.');
    }
    lines.push('  Settings: /plugin configure asymptomatik-souvenir, then /reload-plugins.');
    return lines.join('\n');
  }
  const identity = provider.identity;
  lines.push(`  Embedding: OK — ${identity.dimensions}-dimension vectors (${Date.now() - started} ms including model load)`);

  const transcripts = getIndexIdentity();
  if (!transcripts) {
    lines.push('  Transcript index: not built yet — run souvenir_index action="build" (or project="all").');
  } else if (sameIdentity(transcripts, identity)) {
    lines.push(`  Transcript index: compatible (${getIndexStatus().totalChunks} chunks)`);
  } else {
    lines.push(`  Transcript index: INCOMPATIBLE — built with ${describeIdentity(transcripts)}.`);
    lines.push('    Restore the previous settings, or re-embed everything: souvenir_index action="rebuild" project="all".');
  }

  if (docsDbExists(config.cwd)) {
    const docs = getDocsIndexIdentity(config.cwd);
    if (!docs) {
      lines.push('  Docs index (this project): no indexed files yet.');
    } else if (sameIdentity(docs, identity)) {
      lines.push(`  Docs index (this project): compatible (${getDocsChunkCount(config.cwd)} chunks)`);
    } else {
      lines.push(`  Docs index (this project): INCOMPATIBLE — built with ${describeIdentity(docs)}.`);
      lines.push('    Re-embed it: souvenir_docs action="build" rebuild=true.');
    }
  }

  return lines.join('\n');
}

async function runBuild(
  config: ReturnType<typeof getConfig>,
  params: { action: 'build' | 'rebuild'; project?: string; session_id?: string },
  extra?: ToolExtra,
): Promise<string> {
  // Resolve project dirs
  let projectDirs: string[];
  if (params.project === 'all') {
    projectDirs = listProjectDirs();
  } else if (params.project) {
    projectDirs = [resolveProjectDir(params.project)];
  } else if (config.currentProject) {
    projectDirs = [config.currentProject];
  } else {
    return 'Error: No project specified and could not detect current project.';
  }

  // Get singleton embedding provider
  const provider = getOrCreateProvider(config);

  const isRebuild = params.action === 'rebuild';

  try {
    const result = await buildIndex(provider, projectDirs, {
      sessionId: params.session_id,
      rebuild: isRebuild,
      onProgress: createProgressNotifier(extra),
    });

    const lines = [
      `Indexing ${isRebuild ? '(rebuild) ' : ''}complete!`,
      `  Chunks processed: ${result.totalChunks}`,
      `  Chunks embedded: ${result.totalEmbedded}`,
      `  Files processed: ${result.filesProcessed}`,
      `  Files skipped (unchanged): ${result.skipped}`,
    ];

    if (result.resetAll) {
      lines.push('');
      lines.push(`  The embedding model changed, so the whole index was reset and rebuilt with ${describeIdentity(provider.identity)}.`);
      if (params.project !== 'all') {
        lines.push('  Other projects are re-indexed on their next search, or now with project="all".');
      }
    }

    if (result.errors.length > 0) {
      lines.push('');
      lines.push(`  Errors (${result.errors.length}${result.errors.length >= 5 ? '+' : ''}):`);
      for (const err of result.errors) {
        lines.push(`    - ${err}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    return `Indexing error: ${errorMessage(err)}`;
  }
}

/** Size of the database including its write-ahead log. */
function databaseSize(dbPath: string): number {
  const size = (path: string) => (existsSync(path) ? statSync(path).size : 0);
  return size(dbPath) + size(`${dbPath}-wal`);
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function runVacuum(): string {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    return 'No index database found. Nothing to vacuum.';
  }

  const db = getDb();
  const sizeBefore = databaseSize(dbPath);
  fullVacuum();
  // VACUUM goes through the WAL: fold it back into the database file before measuring
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const sizeAfter = databaseSize(dbPath);

  return `Index database vacuumed: ${formatSize(sizeBefore)} → ${formatSize(sizeAfter)} ` +
    `(${formatSize(Math.max(0, sizeBefore - sizeAfter))} reclaimed).`;
}
