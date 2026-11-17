/**
 * The transcript archive: every line of every Claude Code transcript, and the files Claude Code
 * keeps beside them (large tool results, images, subagent metadata), stored in the souvenir
 * database. Claude Code deletes its own files after a while (cleanupPeriodDays, 30 days by
 * default): the archive is what souvenir reads, the files are only where it copies from.
 *
 * Lines are stored as Claude Code wrote them, compressed (deflate-raw), numbered like the lines
 * of the file (1-based, empty lines counted), so that line numbers shown by souvenir_read and
 * search results stay valid whether the file still exists or not.
 */

import { deflateRawSync, inflateRawSync } from 'zlib';
import { getDb } from '../db/store.js';
import { getRow, allRows, iterateRows } from '../db/sqlite.js';

export interface ArchivedFileRow {
  /** Path of the transcript relative to Claude Code's projects folder, with '/' separators */
  file_key: string;
  project_dir: string;
  /** Session id for a main transcript, agent id (agent-…) for a subagent transcript */
  session_id: string;
  /** Main session of a subagent transcript, null for a main transcript */
  parent_session_id: string | null;
  /** Bytes of the source file copied so far (always the end of a complete line) */
  archived_bytes: number;
  /** Lines copied so far: the number of the last archived line */
  line_count: number;
  /** Entries souvenir_read pages through: lines of type user, assistant or summary */
  entry_count: number;
  first_timestamp: string | null;
  last_timestamp: string | null;
  first_prompt: string;
  /** Title Claude Code generated (ai-title) or an older summary entry */
  title: string;
  /** Title the user gave the session (/rename) */
  custom_title: string;
  git_branch: string;
  /** Project root the session ran in, when an entry recorded it */
  project_path: string;
  /** When souvenir found the source file deleted (by Claude Code's cleanup, usually) */
  source_gone_at: string | null;
  /** Why the source could not be archived further, null when it could */
  error: string | null;
  updated_at: string;
}

export interface ArchivedLine {
  lineNumber: number;
  text: string;
}

export interface ArchivedAttachment {
  file_key: string;
  project_dir: string;
  session_id: string;
  size: number;
  mtime_ms: number;
  data: Uint8Array;
}

export function compress(text: string | Buffer): Uint8Array {
  return deflateRawSync(typeof text === 'string' ? Buffer.from(text, 'utf8') : text);
}

export function decompress(data: Uint8Array): Buffer {
  return inflateRawSync(data);
}

export function getArchivedFile(fileKey: string): ArchivedFileRow | null {
  return getRow<ArchivedFileRow>(getDb(), 'SELECT * FROM transcript_files WHERE file_key = ?', fileKey);
}

/** Every archived transcript of a project (main and subagent ones). */
export function getArchivedFiles(projectDir: string): ArchivedFileRow[] {
  return allRows<ArchivedFileRow>(getDb(), 'SELECT * FROM transcript_files WHERE project_dir = ?', projectDir);
}

/**
 * The archived transcripts of a session id (a main session or a subagent's agent id), in any
 * project or in the given one. Main transcripts first.
 */
export function findArchivedFiles(sessionId: string, projectDir?: string): ArchivedFileRow[] {
  return projectDir
    ? allRows<ArchivedFileRow>(getDb(), 'SELECT * FROM transcript_files WHERE session_id = ? AND project_dir = ? ORDER BY parent_session_id IS NOT NULL', sessionId, projectDir)
    : allRows<ArchivedFileRow>(getDb(), 'SELECT * FROM transcript_files WHERE session_id = ? ORDER BY parent_session_id IS NOT NULL', sessionId);
}

/** Subagent transcripts of a main session. */
export function getSubagentFiles(projectDir: string, sessionId: string): ArchivedFileRow[] {
  return allRows<ArchivedFileRow>(getDb(), 'SELECT * FROM transcript_files WHERE project_dir = ? AND parent_session_id = ?', projectDir, sessionId);
}

/** Projects that have archived transcripts. */
export function getArchivedProjectDirs(): string[] {
  return allRows<{ project_dir: string }>(getDb(), 'SELECT DISTINCT project_dir FROM transcript_files').map((r) => r.project_dir);
}

/**
 * The lines of an archived transcript from fromLine on, in order. Reads the database lazily:
 * a transcript of hundreds of MB is never held in memory at once.
 */
export function* archivedLines(fileKey: string, fromLine = 1): Generator<ArchivedLine> {
  const rows = iterateRows<{ line_number: number; data: Uint8Array }>(getDb(),
    'SELECT line_number, data FROM transcript_lines WHERE file_key = ? AND line_number >= ? ORDER BY line_number', fileKey, fromLine);
  for (const row of rows) {
    yield { lineNumber: row.line_number, text: decompress(row.data).toString('utf8') };
  }
}

/** Files Claude Code kept beside a session (tool-results/…, subagents/*.meta.json …). */
export function getAttachments(projectDir: string, sessionId: string): Array<Omit<ArchivedAttachment, 'data'>> {
  return allRows(getDb(),
    'SELECT file_key, project_dir, session_id, size, mtime_ms FROM transcript_attachments WHERE project_dir = ? AND session_id = ? ORDER BY file_key',
    projectDir, sessionId);
}

export function getAttachment(fileKey: string): ArchivedAttachment | null {
  return getRow<ArchivedAttachment>(getDb(), 'SELECT * FROM transcript_attachments WHERE file_key = ?', fileKey);
}

/** Size of the archive: transcripts, lines, compressed bytes, deleted sources, attachments. */
export function getArchiveStats(projectDir?: string): {
  files: number;
  sessions: number;
  lines: number;
  sourcesGone: number;
  errors: number;
  storedBytes: number;
  attachments: number;
  attachmentBytes: number;
} {
  const db = getDb();
  const where = projectDir ? 'WHERE project_dir = ?' : '';
  const params = projectDir ? [projectDir] : [];
  const files = getRow<{ files: number; sessions: number; lines: number; gone: number; errors: number }>(db, `
    SELECT COUNT(*) AS files, COUNT(DISTINCT CASE WHEN parent_session_id IS NULL THEN session_id END) AS sessions,
           COALESCE(SUM(line_count), 0) AS lines, COUNT(source_gone_at) AS gone, COUNT(error) AS errors
    FROM transcript_files ${where}`, ...params)!;
  const stored = projectDir
    ? getRow<{ bytes: number }>(db, 'SELECT COALESCE(SUM(LENGTH(l.data)), 0) AS bytes FROM transcript_lines l JOIN transcript_files f ON f.file_key = l.file_key WHERE f.project_dir = ?', projectDir)!
    : getRow<{ bytes: number }>(db, 'SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM transcript_lines')!;
  const attachments = getRow<{ count: number; bytes: number }>(db,
    `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM transcript_attachments ${where}`, ...params)!;
  return {
    files: files.files,
    sessions: files.sessions,
    lines: files.lines,
    sourcesGone: files.gone,
    errors: files.errors,
    storedBytes: stored.bytes,
    attachments: attachments.count,
    attachmentBytes: attachments.bytes,
  };
}
