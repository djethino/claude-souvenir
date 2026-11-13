import { existsSync } from 'fs';
import { listProjectDirs, getProjectInfo } from '../transcript/discovery.js';
import { getConfig } from '../config.js';
import { getIndexStatus, clearProject } from '../db/store.js';
import { logger } from '../utils/logger.js';
import { DECLINED, type Confirm } from './confirm.js';

export async function handleSouvenirProjects(params: {
  search?: string;
  action?: 'list' | 'clean';
}, confirm: Confirm): Promise<string> {
  if (params.action === 'clean') {
    return handleClean(confirm);
  }

  const config = getConfig();
  const allDirs = listProjectDirs();

  const projects = allDirs
    .map((dir) => getProjectInfo(dir))
    .filter((p): p is NonNullable<typeof p> => p !== null && p.sessionCount > 0);

  // Filter by search term
  let filtered = projects;
  if (params.search) {
    const term = params.search.toLowerCase();
    filtered = projects.filter(
      (p) =>
        (p.originalPath ?? '').toLowerCase().includes(term) ||
        p.dirName.toLowerCase().includes(term),
    );
  }

  // Sort by latest date
  filtered.sort((a, b) => {
    const dateA = a.latestDate ? new Date(a.latestDate).getTime() : 0;
    const dateB = b.latestDate ? new Date(b.latestDate).getTime() : 0;
    return dateB - dateA;
  });

  if (filtered.length === 0) {
    return params.search
      ? `No projects found matching "${params.search}".`
      : 'No projects with transcripts found.';
  }

  const lines = [`Found ${filtered.length} project(s):\n`];

  for (let i = 0; i < filtered.length; i++) {
    const p = filtered[i];
    const latest = p.latestDate ? p.latestDate.slice(0, 10) : '???';
    const oldest = p.oldestDate ? p.oldestDate.slice(0, 10) : '???';

    const isCurrent = p.dirName === config.currentProject;
    const statusTag = isCurrent ? ' [current]'
      : p.originalPath === null ? ' [path unknown]'
      : existsSync(p.originalPath) ? '' : ' [orphan]';

    lines.push(`${i + 1}. ${p.originalPath ?? p.dirName}${statusTag}`);
    lines.push(`   Dir: ${p.dirName}`);
    lines.push(`   Sessions: ${p.sessionCount} | Latest: ${latest} | Oldest: ${oldest}`);
    lines.push('');
  }

  // Check for index-only orphans (projects in DB but not in ~/.claude/projects/)
  try {
    const indexStatus = getIndexStatus();
    const knownDirs = new Set(allDirs.map((d) => d.toLowerCase()));
    const indexOnlyOrphans = indexStatus.projects.filter((p) => !knownDirs.has(p.projectDir.toLowerCase()));

    if (indexOnlyOrphans.length > 0) {
      lines.push(`--- Index-only orphans (${indexOnlyOrphans.length}) ---`);
      lines.push('These projects have indexed data but no transcripts in ~/.claude/projects/:');
      for (const p of indexOnlyOrphans) {
        lines.push(`  - ${p.projectDir}: ${p.chunkCount} chunks`);
      }
      lines.push('');
      lines.push('Use souvenir_projects action="clean" to remove orphaned index data.');
    }
  } catch (err) {
    logger.debug('Could not check index for orphans:', err);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Clean orphaned project data
// ---------------------------------------------------------------------------

async function handleClean(confirm: Confirm): Promise<string> {
  const allDirs = listProjectDirs();
  // Case-insensitive: on Windows one project can be stored as "D--…" and "d--…"
  const knownDirs = new Set(allDirs.map((d) => d.toLowerCase()));

  let indexStatus;
  try {
    indexStatus = getIndexStatus();
  } catch {
    return 'No index database found. Nothing to clean.';
  }

  // Find orphans: projects in the index but not in ~/.claude/projects/
  const indexOrphans = indexStatus.projects.filter((p) => !knownDirs.has(p.projectDir.toLowerCase()));

  // Find orphans: projects whose real path no longer exists on disk (never one whose path is unknown)
  const pathOrphans: Array<{ dirName: string; originalPath: string; chunkCount: number }> = [];
  for (const dir of allDirs) {
    const info = getProjectInfo(dir);
    if (!info?.originalPath) continue;
    if (!existsSync(info.originalPath)) {
      const dbProject = indexStatus.projects.find((p) => p.projectDir.toLowerCase() === dir.toLowerCase());
      if (dbProject && dbProject.chunkCount > 0) {
        pathOrphans.push({
          dirName: dir,
          originalPath: info.originalPath,
          chunkCount: dbProject.chunkCount,
        });
      }
    }
  }

  if (indexOrphans.length === 0 && pathOrphans.length === 0) {
    return 'No orphaned project data found. Everything is clean.';
  }

  const question = [
    `souvenir: remove the search index data of ${indexOrphans.length + pathOrphans.length} orphaned project(s)?`,
  ];
  if (indexOrphans.length > 0) {
    question.push('', `No transcripts left (Claude Code deleted them): the index is the only remaining copy of these conversations.`);
    question.push(...indexOrphans.map((p) => `- ${p.projectDir} (${p.chunkCount} chunks)`));
  }
  if (pathOrphans.length > 0) {
    question.push('', 'Folder deleted, transcripts kept (the index can be rebuilt from them):');
    question.push(...pathOrphans.map((p) => `- ${p.originalPath} (${p.chunkCount} chunks)`));
  }
  if (!confirm(question.join('\n'))) {
    return DECLINED;
  }

  const lines: string[] = [];
  let totalCleaned = 0;

  // Clean index-only orphans
  for (const p of indexOrphans) {
    try {
      clearProject(p.projectDir);
      totalCleaned += p.chunkCount;
      lines.push(`Cleaned ${p.projectDir}: ${p.chunkCount} chunks removed (no transcript dir)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`Error cleaning ${p.projectDir}: ${msg}`);
    }
  }

  // Clean path orphans (project dir exists in ~/.claude/projects/ but real path is gone)
  for (const p of pathOrphans) {
    // Skip if already cleaned as index orphan
    if (indexOrphans.some((io) => io.projectDir === p.dirName)) continue;

    try {
      clearProject(p.dirName);
      totalCleaned += p.chunkCount;
      lines.push(`Cleaned ${p.originalPath}: ${p.chunkCount} chunks removed (path no longer exists)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`Error cleaning ${p.dirName}: ${msg}`);
    }
  }

  lines.push('');
  lines.push(`Total: ${totalCleaned} chunks cleaned from ${indexOrphans.length + pathOrphans.length} orphaned project(s).`);
  lines.push('Note: Transcript files in ~/.claude/projects/ are preserved (managed by Claude Code).');

  return lines.join('\n');
}
