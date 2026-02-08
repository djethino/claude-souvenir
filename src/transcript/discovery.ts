import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { getProjectsDir, getProjectTranscriptDir } from '../utils/paths.js';
import type { SessionIndex, SessionIndexEntry } from './types.js';

// Cache session indexes in memory (small data, read frequently)
const indexCache = new Map<string, { data: SessionIndex; mtime: number }>();

/**
 * List all project directory names under ~/.claude/projects/.
 */
export function listProjectDirs(): string[] {
  const projectsDir = getProjectsDir();
  if (!existsSync(projectsDir)) return [];

  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Load the sessions-index.json for a project (with caching).
 */
export function loadSessionIndex(projectDir: string): SessionIndex | null {
  const indexPath = join(getProjectTranscriptDir(projectDir), 'sessions-index.json');

  if (!existsSync(indexPath)) {
    logger.debug(`No sessions-index.json for ${projectDir}`);
    return null;
  }

  try {
    const stat = statSync(indexPath);
    const cached = indexCache.get(projectDir);

    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.data;
    }

    const raw = readFileSync(indexPath, 'utf-8');
    const data = JSON.parse(raw) as SessionIndex;

    indexCache.set(projectDir, { data, mtime: stat.mtimeMs });
    return data;
  } catch (err) {
    logger.error(`Failed to read session index for ${projectDir}:`, err);
    return null;
  }
}

/**
 * Get sessions for a project, optionally filtered and sorted.
 */
export function getSessions(
  projectDir: string,
  options: {
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    sort?: 'newest' | 'oldest' | 'messages';
    includeSidechains?: boolean;
  } = {},
): SessionIndexEntry[] {
  const index = loadSessionIndex(projectDir);
  if (!index) return [];

  let entries = [...index.entries];

  // Filter sidechains
  if (!options.includeSidechains) {
    entries = entries.filter((e) => !e.isSidechain);
  }

  // Search filter
  if (options.search) {
    const term = options.search.toLowerCase();
    entries = entries.filter(
      (e) =>
        (e.summary || '').toLowerCase().includes(term) ||
        (e.firstPrompt || '').toLowerCase().includes(term),
    );
  }

  // Date filters
  if (options.dateFrom) {
    const from = new Date(options.dateFrom).getTime();
    entries = entries.filter((e) => new Date(e.created).getTime() >= from);
  }
  if (options.dateTo) {
    const to = new Date(options.dateTo).getTime();
    entries = entries.filter((e) => new Date(e.created).getTime() <= to);
  }

  // Sort
  const sort = options.sort || 'newest';
  entries.sort((a, b) => {
    switch (sort) {
      case 'newest':
        return new Date(b.modified).getTime() - new Date(a.modified).getTime();
      case 'oldest':
        return new Date(a.created).getTime() - new Date(b.created).getTime();
      case 'messages':
        return b.messageCount - a.messageCount;
      default:
        return 0;
    }
  });

  return entries;
}

/**
 * Find a session's JSONL file path.
 */
export function getSessionFilePath(
  sessionId: string,
  projectDir?: string,
): { filePath: string; projectDir: string } | null {
  const projectDirs = projectDir ? [projectDir] : listProjectDirs();

  for (const dir of projectDirs) {
    const index = loadSessionIndex(dir);
    if (!index) continue;

    const session = index.entries.find((e) => e.sessionId === sessionId);
    if (session) {
      // Use fullPath from index if available, otherwise construct it
      const filePath = session.fullPath || join(getProjectTranscriptDir(dir), `${sessionId}.jsonl`);
      if (existsSync(filePath)) {
        return { filePath, projectDir: dir };
      }
    }

    // Also try direct file path
    const directPath = join(getProjectTranscriptDir(dir), `${sessionId}.jsonl`);
    if (existsSync(directPath)) {
      return { filePath: directPath, projectDir: dir };
    }
  }

  return null;
}

/**
 * Get session metadata from the index.
 */
export function getSessionMetadata(
  sessionId: string,
  projectDir?: string,
): { entry: SessionIndexEntry; projectDir: string } | null {
  const projectDirs = projectDir ? [projectDir] : listProjectDirs();

  for (const dir of projectDirs) {
    const index = loadSessionIndex(dir);
    if (!index) continue;

    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry) return { entry, projectDir: dir };
  }

  return null;
}

/**
 * List all JSONL transcript files for a project.
 */
export function listTranscriptFiles(projectDir: string): string[] {
  const dir = getProjectTranscriptDir(projectDir);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f));
}

/**
 * Get project info: original path and session count.
 */
export function getProjectInfo(projectDir: string): {
  dirName: string;
  originalPath: string;
  sessionCount: number;
  latestDate: string | null;
  oldestDate: string | null;
} | null {
  const index = loadSessionIndex(projectDir);
  if (!index) return null;

  const nonSidechain = index.entries.filter((e) => !e.isSidechain);
  const dates = nonSidechain.map((e) => new Date(e.created).getTime()).filter((d) => !isNaN(d));

  return {
    dirName: projectDir,
    originalPath: index.originalPath || projectDir.replace(/--/g, '/'),
    sessionCount: nonSidechain.length,
    latestDate: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    oldestDate: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
  };
}
