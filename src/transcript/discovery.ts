import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';
import { logger } from '../utils/logger.js';
import { getProjectsDir, getProjectTranscriptDir, isProjectPath } from '../utils/paths.js';
import { countTranscriptEntries } from './entry-count.js';
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
  const indexedEntries = index?.entries ?? [];

  // Merge indexed sessions with orphan sessions
  const orphans = discoverOrphanSessions(projectDir);
  let entries = [...indexedEntries, ...orphans];

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

  entries = entries.map((e) => withEntryCount(e, projectDir));

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
 * The session with its real entry count. Neither source has it: sessions-index.json (no longer
 * written by Claude Code) holds a count frozen when it was written, and the metadata of sessions
 * missing from it comes from the file's first 64 KB only.
 */
function withEntryCount(entry: SessionIndexEntry, projectDir: string): SessionIndexEntry {
  const filePath = entry.fullPath && existsSync(entry.fullPath)
    ? entry.fullPath
    : join(getProjectTranscriptDir(projectDir), `${entry.sessionId}.jsonl`);
  if (!existsSync(filePath)) return entry; // transcript deleted: keep what the index recorded
  return { ...entry, messageCount: countTranscriptEntries(filePath) };
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
    // Check index first (may be null if sessions-index.json doesn't exist or is locked)
    const index = loadSessionIndex(dir);
    if (index) {
      const session = index.entries.find((e) => e.sessionId === sessionId);
      if (session) {
        // Use fullPath from index if available, otherwise construct it
        const filePath = session.fullPath || join(getProjectTranscriptDir(dir), `${sessionId}.jsonl`);
        if (existsSync(filePath)) {
          return { filePath, projectDir: dir };
        }
      }
    }

    // Also try direct file path (works for orphan sessions or when index is unavailable)
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
    // Check index first
    const index = loadSessionIndex(dir);
    if (index) {
      const entry = index.entries.find((e) => e.sessionId === sessionId);
      if (entry) return { entry: withEntryCount(entry, dir), projectDir: dir };
    }

    // Check orphan files
    const filePath = join(getProjectTranscriptDir(dir), `${sessionId}.jsonl`);
    if (existsSync(filePath)) {
      const meta = extractMinimalMetadata(filePath, sessionId, dir);
      if (meta) return { entry: withEntryCount(meta, dir), projectDir: dir };
    }
  }

  return null;
}

/**
 * List all JSONL transcript files for a project.
 * When includeSubagents is true, also includes subagent transcripts
 * (excludes prompt_suggestion agents which are just input prediction noise).
 */
export function listTranscriptFiles(
  projectDir: string,
  options: { includeSubagents?: boolean; sessionId?: string } = {},
): string[] {
  const dir = getProjectTranscriptDir(projectDir);
  if (!existsSync(dir)) return [];

  // Main session transcripts
  const mainFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f));

  if (!options.includeSubagents) return mainFiles;

  // Also collect subagent files
  const subagentFiles: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Session directories are UUIDs (skip others)
    if (!entry.name.match(/^[0-9a-f]{8}-/)) continue;
    // Filter by sessionId if specified
    if (options.sessionId && entry.name !== options.sessionId) continue;

    const subagentDir = join(dir, entry.name, 'subagents');
    if (!existsSync(subagentDir)) continue;

    try {
      const agentFiles = readdirSync(subagentDir)
        .filter((f) => {
          if (!f.endsWith('.jsonl')) return false;
          // Skip prompt_suggestion agents - they're just input prediction noise
          if (f.includes('aprompt_suggestion')) return false;
          return true;
        })
        .map((f) => join(subagentDir, f));

      subagentFiles.push(...agentFiles);
    } catch (err) {
      logger.debug(`Error reading subagents for ${entry.name}:`, err);
    }
  }

  return [...mainFiles, ...subagentFiles];
}

/**
 * Discover orphan sessions: .jsonl files not present in sessions-index.json.
 * Reads the first bytes of each orphan to build minimal metadata.
 */
export function discoverOrphanSessions(projectDir: string): SessionIndexEntry[] {
  const dir = getProjectTranscriptDir(projectDir);
  if (!existsSync(dir)) return [];

  // Get indexed session IDs
  const index = loadSessionIndex(projectDir);
  const indexedIds = new Set(index?.entries.map((e) => e.sessionId) ?? []);

  // List .jsonl files in the project directory
  const jsonlFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => basename(f, '.jsonl'))
    .filter((id) => !indexedIds.has(id));

  if (jsonlFiles.length === 0) return [];

  const orphans: SessionIndexEntry[] = [];

  for (const sessionId of jsonlFiles) {
    const filePath = join(dir, `${sessionId}.jsonl`);
    try {
      const meta = extractMinimalMetadata(filePath, sessionId, projectDir);
      if (meta) orphans.push(meta);
    } catch (err) {
      logger.debug(`Failed to read orphan session ${sessionId}:`, err);
    }
  }

  return orphans;
}

/**
 * Read the beginning of a .jsonl file to extract minimal session metadata.
 * Uses sync read of first 64KB to avoid async complexity while keeping it fast.
 * messageCount is left at 0: it needs the whole file (see withEntryCount, applied by getSessions
 * and getSessionMetadata; listing projects does not need it).
 */
function extractMinimalMetadata(
  filePath: string,
  sessionId: string,
  projectDir: string,
): SessionIndexEntry | null {
  const stat = statSync(filePath);
  if (stat.size === 0) return null;

  // Read first 64KB - enough to find metadata in most sessions
  const CHUNK_SIZE = 64 * 1024;
  const buf = Buffer.alloc(Math.min(CHUNK_SIZE, stat.size));
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }

  const text = buf.toString('utf-8');
  const lines = text.split('\n');

  let firstPrompt = '';
  let firstTimestamp = '';
  let hasMessage = false;
  let gitBranch = '';
  let projectPath = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.includes('"file-history-snapshot"')) continue;

    try {
      const entry = JSON.parse(line);
      // Capture first timestamp
      if (entry.timestamp && !firstTimestamp) {
        firstTimestamp = entry.timestamp;
      }

      if (entry.type === 'user' || entry.type === 'assistant') {
        hasMessage = true;
      }

      if (entry.gitBranch && !gitBranch) {
        gitBranch = entry.gitBranch;
      }

      // The project's real path: a cwd that encodes to this project dir (a session can start elsewhere)
      if (!projectPath && typeof entry.cwd === 'string' && isProjectPath(entry.cwd, projectDir)) {
        projectPath = entry.cwd;
      }

      // Capture first user message as firstPrompt (isMeta entries are Claude Code's own
      // context, such as the <local-command-caveat> recorded before a slash command)
      if (entry.type === 'user' && !entry.isMeta && !firstPrompt) {
        if (typeof entry.message?.content === 'string') {
          firstPrompt = entry.message.content.slice(0, 200);
        } else if (Array.isArray(entry.message?.content)) {
          const textBlock = entry.message.content.find((b: { type: string }) => b.type === 'text');
          if (textBlock?.text) {
            firstPrompt = textBlock.text.slice(0, 200);
          }
        }
      }
    } catch {
      // Skip corrupt/truncated lines (last line from partial read)
    }
  }

  // Skip completely empty files
  if (!hasMessage && !firstPrompt) return null;

  return {
    sessionId,
    fullPath: filePath,
    fileMtime: stat.mtimeMs,
    firstPrompt,
    summary: '', // No summary available for orphans
    messageCount: 0,
    created: firstTimestamp || new Date(stat.birthtimeMs).toISOString(),
    modified: new Date(stat.mtimeMs).toISOString(),
    gitBranch,
    projectPath, // '' when no entry in the first 64 KB ran in the project root

    isSidechain: false,
  };
}

/**
 * Resolve the most recent session for a project.
 * Used for session_id="current" support.
 */
export function resolveCurrentSession(projectDir?: string): string | null {
  if (!projectDir) return null;
  const sessions = getSessions(projectDir, { sort: 'newest' });
  return sessions.length > 0 ? sessions[0].sessionId : null;
}

/**
 * Get project info: original path and session count.
 *
 * originalPath comes from sessions-index.json, else from the transcripts (the cwd of an entry run
 * in the project root). It is null when neither gives it: the dir name cannot be decoded back
 * ("-" stands for any non-alphanumeric character), and a guessed path would make a live project
 * look deleted.
 */
export function getProjectInfo(projectDir: string): {
  dirName: string;
  originalPath: string | null;
  sessionCount: number;
  latestDate: string | null;
  oldestDate: string | null;
} | null {
  const index = loadSessionIndex(projectDir);
  const indexedEntries = index?.entries ?? [];
  const orphans = discoverOrphanSessions(projectDir);
  const allEntries = [...indexedEntries, ...orphans];

  if (allEntries.length === 0) return null;

  const nonSidechain = allEntries.filter((e) => !e.isSidechain);
  const dates = nonSidechain.map((e) => new Date(e.created).getTime()).filter((d) => !isNaN(d));

  return {
    dirName: projectDir,
    originalPath: index?.originalPath || allEntries.find((e) => e.projectPath && isProjectPath(e.projectPath, projectDir))?.projectPath || null,
    sessionCount: nonSidechain.length,
    latestDate: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    oldestDate: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
  };
}
