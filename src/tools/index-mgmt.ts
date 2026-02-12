import { getConfig } from '../config.js';
import { resolveProjectDir } from '../utils/paths.js';
import { listProjectDirs, loadSessionIndex } from '../transcript/discovery.js';
import { buildIndex } from '../db/indexer.js';
import { getDb, getIndexStatus, getStoredProvider, clearAll } from '../db/store.js';
import { getOrCreateProvider } from './helpers.js';

export async function handleSouvenirIndex(params: {
  action: 'status' | 'build' | 'rebuild';
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

    default:
      return `Unknown action: "${params.action}". Use "status", "build", or "rebuild".`;
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
