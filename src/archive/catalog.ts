/**
 * The sessions and projects souvenir knows, from the archive first:
 * - archived transcripts (complete, whether Claude Code still has the file or not);
 * - sessions known only by their search index excerpts (Claude Code deleted the transcript
 *   before souvenir archived transcripts): partial;
 * - sessions only listed in Claude Code's old sessions-index.json: lost.
 *
 * Callers archive what Claude Code wrote since the last copy first (ensureArchived), so that
 * the catalog includes the session being written.
 */

import { getDb } from '../db/store.js';
import { allRows, getRow } from '../db/sqlite.js';
import { listProjectDirsOnDisk, loadSessionIndex } from '../transcript/discovery.js';
import type { SessionIndexEntry, SessionInfo } from '../transcript/types.js';
import { isProjectPath } from '../utils/paths.js';
import { archiveProjects, type ArchiveProgress, type ArchiveReport } from './archiver.js';
import { findArchivedFiles, getArchivedFiles, getArchivedProjectDirs, type ArchivedFileRow } from './store.js';

/** Copy what Claude Code wrote since the last copy, for these projects. */
export function ensureArchived(
  projectDirs: string[],
  onProgress?: (progress: ArchiveProgress) => void,
): Promise<ArchiveReport> {
  return archiveProjects(projectDirs, { onProgress });
}

/** A note for tool answers when some transcripts could not be archived (their newest lines are missing). */
export function archiveErrorNote(report: ArchiveReport): string | null {
  if (report.errors.length === 0) return null;
  return `Note: ${report.errors.length} file(s) could not be archived, their newest content may be missing (${report.errors.slice(0, 3).join('; ')}${report.errors.length > 3 ? '; …' : ''}).`;
}

/**
 * Every project souvenir knows: the folders Claude Code has now, and those it deleted whose
 * conversations are in the archive or the search index.
 */
export function listProjectDirs(): string[] {
  const dirs = new Set(listProjectDirsOnDisk());
  for (const dir of getArchivedProjectDirs()) dirs.add(dir);
  for (const { project_dir } of allRows<{ project_dir: string }>(getDb(), 'SELECT DISTINCT project_dir FROM chunks')) {
    dirs.add(project_dir);
  }
  return [...dirs];
}

interface LegacySessionRow {
  session_id: string;
  excerpts: number;
  first_ts: string | null;
  last_ts: string | null;
}

/** Sessions of a project known only by their search index excerpts. */
function legacySessions(projectDir: string, sessionId?: string): LegacySessionRow[] {
  const filter = sessionId ? 'AND session_id = ?' : '';
  const params = sessionId ? [projectDir, projectDir, sessionId] : [projectDir, projectDir];
  return allRows<LegacySessionRow>(getDb(), `
    SELECT session_id, COUNT(*) AS excerpts, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
    FROM chunks
    WHERE project_dir = ? AND session_id NOT IN (SELECT session_id FROM transcript_files WHERE project_dir = ?) ${filter}
    GROUP BY session_id`, ...params);
}

/** The user's words in a session's first excerpt ("USER: …\nASSISTANT: …"). */
function legacyFirstPrompt(projectDir: string, sessionId: string): string {
  const first = getRow<{ content_text: string }>(getDb(),
    "SELECT content_text FROM chunks WHERE session_id = ? AND project_dir = ? AND role = 'turn' ORDER BY line_number, part LIMIT 1",
    sessionId, projectDir)?.content_text ?? '';
  if (!first.startsWith('USER: ')) return '';
  const end = first.indexOf('\nASSISTANT: ');
  return first.slice('USER: '.length, end === -1 ? undefined : end);
}

function fromArchive(row: ArchivedFileRow, indexEntry: SessionIndexEntry | undefined): SessionInfo {
  return {
    sessionId: row.session_id,
    projectDir: row.project_dir,
    fileKey: row.file_key,
    firstPrompt: row.first_prompt || indexEntry?.firstPrompt || '',
    summary: row.custom_title || row.title || indexEntry?.summary || '',
    messageCount: row.entry_count,
    created: row.first_timestamp ?? indexEntry?.created ?? row.updated_at,
    modified: row.last_timestamp ?? indexEntry?.modified ?? row.updated_at,
    gitBranch: row.git_branch || indexEntry?.gitBranch || '',
    projectPath: row.project_path || indexEntry?.projectPath || '',
    isSidechain: row.parent_session_id !== null,
    availability: 'complete',
    sourceDeleted: row.source_gone_at !== null,
  };
}

function fromLegacy(projectDir: string, row: LegacySessionRow, indexEntry: SessionIndexEntry | undefined): SessionInfo {
  const created = row.first_ts ?? indexEntry?.created ?? '';
  return {
    sessionId: row.session_id,
    projectDir,
    fileKey: null,
    firstPrompt: indexEntry?.firstPrompt || legacyFirstPrompt(projectDir, row.session_id),
    summary: indexEntry?.summary ?? '',
    messageCount: row.excerpts,
    created,
    modified: row.last_ts ?? indexEntry?.modified ?? created,
    gitBranch: indexEntry?.gitBranch ?? '',
    projectPath: indexEntry?.projectPath ?? '',
    isSidechain: indexEntry?.isSidechain ?? row.session_id.startsWith('agent-'),
    availability: 'partial',
    sourceDeleted: true,
  };
}

function fromIndexOnly(projectDir: string, entry: SessionIndexEntry): SessionInfo {
  return {
    sessionId: entry.sessionId,
    projectDir,
    fileKey: null,
    firstPrompt: entry.firstPrompt,
    summary: entry.summary,
    messageCount: 0,
    created: entry.created,
    modified: entry.modified,
    gitBranch: entry.gitBranch,
    projectPath: entry.projectPath,
    isSidechain: entry.isSidechain,
    availability: 'lost',
    sourceDeleted: true,
  };
}

/** All sessions of a project, archived, partial and lost. */
function allSessions(projectDir: string): SessionInfo[] {
  const indexEntries = new Map((loadSessionIndex(projectDir)?.entries ?? []).map((e) => [e.sessionId, e]));
  const sessions: SessionInfo[] = [];
  const seen = new Set<string>();

  for (const row of getArchivedFiles(projectDir)) {
    sessions.push(fromArchive(row, indexEntries.get(row.session_id)));
    seen.add(row.session_id);
  }
  for (const row of legacySessions(projectDir)) {
    sessions.push(fromLegacy(projectDir, row, indexEntries.get(row.session_id)));
    seen.add(row.session_id);
  }
  for (const entry of indexEntries.values()) {
    if (!seen.has(entry.sessionId)) sessions.push(fromIndexOnly(projectDir, entry));
  }
  return sessions;
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
): SessionInfo[] {
  let sessions = allSessions(projectDir);

  if (!options.includeSidechains) {
    sessions = sessions.filter((s) => !s.isSidechain);
  }

  if (options.search) {
    const term = options.search.toLowerCase();
    sessions = sessions.filter(
      (s) => s.summary.toLowerCase().includes(term) || s.firstPrompt.toLowerCase().includes(term),
    );
  }

  if (options.dateFrom) {
    const from = new Date(options.dateFrom).getTime();
    sessions = sessions.filter((s) => new Date(s.created).getTime() >= from);
  }
  if (options.dateTo) {
    const to = new Date(options.dateTo).getTime();
    sessions = sessions.filter((s) => new Date(s.created).getTime() <= to);
  }

  const sort = options.sort || 'newest';
  sessions.sort((a, b) => {
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

  return sessions;
}

/**
 * Find a session (or a subagent transcript by its agent id) in a project, or in every project.
 * The archive first, then the search index excerpts, then the old sessions-index.json.
 */
export function findSession(sessionId: string, projectDir?: string): SessionInfo | null {
  const archived = findArchivedFiles(sessionId, projectDir)[0];
  if (archived) {
    return fromArchive(archived, loadSessionIndex(archived.project_dir)?.entries.find((e) => e.sessionId === sessionId));
  }

  const legacyDirs = projectDir
    ? [projectDir]
    : allRows<{ project_dir: string }>(getDb(), 'SELECT DISTINCT project_dir FROM chunks WHERE session_id = ?', sessionId).map((r) => r.project_dir);
  for (const dir of legacyDirs) {
    const row = legacySessions(dir, sessionId)[0];
    if (row) return fromLegacy(dir, row, loadSessionIndex(dir)?.entries.find((e) => e.sessionId === sessionId));
  }

  for (const dir of projectDir ? [projectDir] : listProjectDirsOnDisk()) {
    const entry = loadSessionIndex(dir)?.entries.find((e) => e.sessionId === sessionId);
    if (entry) return fromIndexOnly(dir, entry);
  }
  return null;
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
 * Get project info: original path, session count and dates.
 *
 * originalPath comes from sessions-index.json, else from the archived transcripts (the cwd of an
 * entry run in the project root). It is null when neither gives it: the dir name cannot be
 * decoded back ("-" stands for any non-alphanumeric character), and a guessed path would make a
 * live project look deleted.
 */
export function getProjectInfo(projectDir: string): {
  dirName: string;
  originalPath: string | null;
  sessionCount: number;
  partialSessions: number;
  latestDate: string | null;
  oldestDate: string | null;
} | null {
  const sessions = allSessions(projectDir).filter((s) => !s.isSidechain && s.availability !== 'lost');
  if (sessions.length === 0) return null;

  const dates = sessions.map((s) => new Date(s.created).getTime()).filter((d) => !isNaN(d));
  const index = loadSessionIndex(projectDir);

  return {
    dirName: projectDir,
    originalPath: index?.originalPath || sessions.find((s) => s.projectPath && isProjectPath(s.projectPath, projectDir))?.projectPath || null,
    sessionCount: sessions.length,
    partialSessions: sessions.filter((s) => s.availability === 'partial').length,
    latestDate: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    oldestDate: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
  };
}
