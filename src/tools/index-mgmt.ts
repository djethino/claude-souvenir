import { statSync as fsStatSync } from 'fs';
import { getConfig } from '../config.js';
import { resolveProjectDir, getDbPath } from '../utils/paths.js';
import { listProjectDirs, loadSessionIndex } from '../transcript/discovery.js';
import { buildIndex } from '../db/indexer.js';
import { getDb, getIndexStatus, getStoredProvider, clearAll, fullVacuum } from '../db/store.js';
import { getOrCreateProvider } from './helpers.js';

export async function handleSouvenirIndex(params: {
  action: 'status' | 'build' | 'rebuild' | 'vacuum';
  project?: string;
  session_id?: string;
}): Promise<string> {
  const config = getConfig();

  switch (params.action) {
    case 'status':
      return getStatusReport(config, params.project);

    case 'build':
    case 'rebuild':
      return await runBuild(config, { ...params, action: params.action as 'build' | 'rebuild' });

    case 'vacuum':
      return runVacuum(config);

    default:
      return `Unknown action: "${params.action}". Use "status", "build", "rebuild", or "vacuum".`;
  }
}

function getStatusReport(config: ReturnType<typeof getConfig>, projectFilter?: string): string {
  try {
    // Initialize DB just to read status (no embedding provider needed)
    getDb(config.embeddingDimensions);
  } catch (err) {
    return 'No semantic index found. Run souvenir_index with action="build" to create one.';
  }

  const stored = getStoredProvider();
  const status = getIndexStatus(projectFilter ? resolveProjectDir(projectFilter) : undefined);

  const lines = ['Semantic Index Status:'];

  if (stored) {
    lines.push(`  Provider: ${stored.name} (${stored.dimensions} dimensions)`);
  } else {
    lines.push('  Provider: Not configured yet');
  }

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

async function runBuild(
  config: ReturnType<typeof getConfig>,
  params: { action: 'build' | 'rebuild'; project?: string; session_id?: string },
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
    });

    const lines = [
      `Indexing ${isRebuild ? '(rebuild) ' : ''}complete!`,
      `  Chunks processed: ${result.totalChunks}`,
      `  Chunks embedded: ${result.totalEmbedded}`,
      `  Files processed: ${result.filesProcessed}`,
      `  Files skipped (unchanged): ${result.skipped}`,
    ];

    if (result.errors.length > 0) {
      lines.push('');
      lines.push(`  Errors (${result.errors.length}${result.errors.length >= 5 ? '+' : ''}):`);
      for (const err of result.errors) {
        lines.push(`    - ${err}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    return `Indexing error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function runVacuum(config: ReturnType<typeof getConfig>): string {
  try {
    getDb(config.embeddingDimensions);
  } catch {
    return 'No index database found. Nothing to vacuum.';
  }

  const dbPath = getDbPath();
  let sizeBefore = 0;
  try { sizeBefore = fsStatSync(dbPath).size; } catch { /* ignore */ }

  fullVacuum();

  let sizeAfter = 0;
  try { sizeAfter = fsStatSync(dbPath).size; } catch { /* ignore */ }

  const savedMb = ((sizeBefore - sizeAfter) / 1024 / 1024).toFixed(1);
  const beforeMb = (sizeBefore / 1024 / 1024).toFixed(1);
  const afterMb = (sizeAfter / 1024 / 1024).toFixed(1);

  return `Index database vacuumed: ${beforeMb} MB → ${afterMb} MB (${savedMb} MB reclaimed).`;
}
