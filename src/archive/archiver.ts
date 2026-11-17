/**
 * Copies Claude Code's transcripts and the files kept beside them into the archive (see store.ts).
 *
 * Incremental: each transcript is copied from where the previous copy stopped (archived_bytes),
 * complete lines only, so a line being written is copied once it ends. Nothing in the archive is
 * ever changed or deleted here: a source that got smaller than what was copied is reported and
 * left alone, a deleted source is only marked as gone.
 *
 * Several processes archive at once (the MCP server of each open session, the hook process):
 * each batch is written in an IMMEDIATE transaction that first checks that the copy is still
 * where this process left it, and starts over from the database state when another process
 * went further.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { setImmediate as nextTick } from 'timers/promises';
import { getDb, removeCaseDuplicateArchives } from '../db/store.js';
import { inTransaction } from '../db/sqlite.js';
import { logger } from '../utils/logger.js';
import { serialized } from '../utils/serial.js';
import { isProjectPath } from '../utils/paths.js';
import { listProjectDirsOnDisk, listSourceFiles, type SourceAttachment, type SourceTranscript } from '../transcript/discovery.js';
import { compress, getArchivedFile, getArchivedFiles, type ArchivedFileRow } from './store.js';

export interface ArchiveProgress {
  phase: string;
  current: number;
  total: number;
  detail?: string;
}

export interface ArchiveReport {
  /** Transcripts that received new lines */
  filesUpdated: number;
  linesAdded: number;
  attachmentsUpdated: number;
  /** Transcripts found deleted by Claude Code during this run */
  sourcesGone: number;
  /** "file: reason" for each transcript or file that could not be archived */
  errors: string[];
}

/** Bytes read from a transcript per batch (one transaction); a longer line is read whole. */
const BATCH_BYTES = 8 * 1024 * 1024;
/** First prompts are kept as a session label: the whole prompt stays in the archived lines. */
const FIRST_PROMPT_LABEL_CHARS = 1000;
/** Entry types souvenir_read pages through (the parser's DEFAULT_ENTRY_TYPES). */
const COUNTED_TYPES = new Set(['user', 'assistant', 'summary']);
const NEWLINE = 0x0a;

/**
 * Archive the transcripts of these projects (one call at a time in this process: a call queued
 * behind another finds the files it copied unchanged).
 */
export const archiveProjects = serialized(runArchive);

/** Where this process's running archive copy is, null when none runs. */
let running: ArchiveProgress | null = null;

/** The archive copy running in this process, if any (another process may be copying too). */
export function archiveInProgress(): ArchiveProgress | null {
  return running;
}

/**
 * What Claude Code wrote that the archive does not hold yet, measured on disk: transcripts with
 * bytes beyond the archived ones (a session being written always has a few) and their size.
 */
export function archiveBacklog(projectDirs: string[]): { transcripts: number; bytes: number } {
  const backlog = { transcripts: 0, bytes: 0 };
  for (const projectDir of projectDirs) {
    const archived = new Map(getArchivedFiles(projectDir).map((f) => [f.file_key, f.archived_bytes]));
    for (const source of listSourceFiles(projectDir).transcripts) {
      let size: number;
      try {
        size = statSync(source.path).size;
      } catch {
        continue; // deleted meanwhile: the next copy marks it gone
      }
      const missing = size - (archived.get(source.fileKey) ?? 0);
      if (missing > 0) {
        backlog.transcripts++;
        backlog.bytes += missing;
      }
    }
  }
  return backlog;
}

async function runArchive(
  projectDirs: string[],
  options: { onProgress?: (progress: ArchiveProgress) => void; signal?: AbortSignal } = {},
): Promise<ArchiveReport> {
  try {
    return await copyProjects(projectDirs, {
      ...options,
      onProgress: (progress) => {
        running = progress;
        options.onProgress?.(progress);
      },
    });
  } finally {
    running = null;
  }
}

async function copyProjects(
  projectDirs: string[],
  options: { onProgress?: (progress: ArchiveProgress) => void; signal?: AbortSignal },
): Promise<ArchiveReport> {
  const report: ArchiveReport = { filesUpdated: 0, linesAdded: 0, attachmentsUpdated: 0, sourcesGone: 0, errors: [] };
  // Copies made twice under another spelling of a project folder (fixed in discovery.ts)
  removeCaseDuplicateArchives(new Set(listProjectDirsOnDisk()));

  for (const projectDir of projectDirs) {
    if (options.signal?.aborted) break;
    const { transcripts, attachments } = listSourceFiles(projectDir);
    const total = transcripts.length + attachments.length;
    let current = 0;

    for (const source of transcripts) {
      if (options.signal?.aborted) break;
      options.onProgress?.({ phase: `Archiving ${projectDir}`, current: ++current, total, detail: source.fileKey });
      try {
        const added = await archiveTranscript(projectDir, source, options.signal);
        if (added > 0) {
          report.filesUpdated++;
          report.linesAdded += added;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Could not archive ${source.path}:`, msg);
        report.errors.push(`${source.fileKey}: ${msg}`);
      }
    }

    for (const attachment of attachments) {
      if (options.signal?.aborted) break;
      options.onProgress?.({ phase: `Archiving ${projectDir}`, current: ++current, total, detail: attachment.fileKey });
      try {
        if (await archiveAttachment(projectDir, attachment)) report.attachmentsUpdated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Could not archive ${attachment.path}:`, msg);
        report.errors.push(`${attachment.fileKey}: ${msg}`);
      }
      await nextTick();
    }

    if (!options.signal?.aborted) {
      report.sourcesGone += await markSourcesGone(projectDir, new Set(transcripts.map((t) => t.fileKey)));
    }
  }

  if (report.linesAdded > 0 || report.attachmentsUpdated > 0) {
    logger.info(`Archived ${report.linesAdded} lines in ${report.filesUpdated} transcripts, ${report.attachmentsUpdated} attached files`);
  }
  return report;
}

/** Metadata gathered from new lines, merged into the transcript's row. */
interface LineMetadata {
  entries: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  firstPrompt: string;
  title: string;
  customTitle: string;
  gitBranch: string;
  projectPath: string;
  parentSessionId: string | null;
}

/** Copy the new complete lines of a transcript. Returns the number of lines added. */
async function archiveTranscript(projectDir: string, source: SourceTranscript, signal?: AbortSignal): Promise<number> {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO transcript_files (file_key, project_dir, session_id, parent_session_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(source.fileKey, projectDir, source.sessionId, source.parentSessionId, new Date().toISOString());

  let added = 0;
  for (;;) {
    if (signal?.aborted) return added; // the next run continues from the last batch written
    const state = getArchivedFile(source.fileKey)!;
    let size: number;
    try {
      size = statSync(source.path).size;
    } catch {
      return added; // deleted since it was listed: marked gone on the next run
    }

    if (size < state.archived_bytes) {
      const reason = `the transcript is now ${size} bytes, smaller than the ${state.archived_bytes} bytes already archived: it was rewritten, the archived copy is kept unchanged and new lines are not archived`;
      if (state.error !== reason) {
        db.prepare('UPDATE transcript_files SET error = ?, updated_at = ? WHERE file_key = ?').run(reason, new Date().toISOString(), source.fileKey);
      }
      throw new Error(reason);
    }
    if (size === state.archived_bytes) {
      if (state.error) db.prepare('UPDATE transcript_files SET error = NULL WHERE file_key = ?').run(source.fileKey);
      return added;
    }

    const batch = readCompleteLines(source.path, state.archived_bytes, size);
    if (!batch) return added; // only a line still being written

    const written = await writeBatchWhenFree(projectDir, state, batch.lines, batch.bytes);
    if (written === null) continue; // another process archived this part first: start over from its state
    added += written;
    await nextTick(); // let tool calls run between batches of a large first copy
  }
}

/**
 * Read the complete lines of a file from an offset: at most BATCH_BYTES, or the whole first line
 * when it is longer. Null when there is no complete line yet.
 */
function readCompleteLines(path: string, offset: number, size: number): { lines: Buffer[]; bytes: number } | null {
  const fd = openSync(path, 'r');
  try {
    let length = Math.min(BATCH_BYTES, size - offset);
    for (;;) {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, offset);
      const data = buf.subarray(0, read);
      const lastNewline = data.lastIndexOf(NEWLINE);
      if (lastNewline === -1) {
        if (offset + read >= size) return null;
        length = Math.min(length * 2, size - offset); // a line longer than the batch: read it whole
        continue;
      }
      const lines: Buffer[] = [];
      let start = 0;
      for (let nl = data.indexOf(NEWLINE); nl !== -1 && nl <= lastNewline; nl = data.indexOf(NEWLINE, start)) {
        // Lines end with \n (\r\n counted as one break, as readline did)
        const end = nl > start && data[nl - 1] === 0x0d ? nl - 1 : nl;
        lines.push(data.subarray(start, end));
        start = nl + 1;
      }
      return { lines, bytes: lastNewline + 1 };
    }
  } finally {
    closeSync(fd);
  }
}

/** Attempts to take the write lock for one batch (each waits busy_timeout, 5 s) before reporting the error. */
const WRITE_ATTEMPTS = 6;

/**
 * Write one batch, waiting for the write lock while another process (another session's server,
 * the hook) writes a large first copy. Null when another process copied this part first.
 */
async function writeBatchWhenFree(projectDir: string, state: ArchivedFileRow, lines: Buffer[], bytes: number): Promise<number | null> {
  // Compressed before taking the lock: the lock is held only for the inserts
  const compressed = lines.map((line) => compress(line));
  const meta = readMetadata(projectDir, state, lines);
  return whenWriteLockFree(state.file_key, () => writeBatch(state, compressed, meta, bytes));
}

/** Run a write, again while another process holds the write lock (up to WRITE_ATTEMPTS times). */
async function whenWriteLockFree<T>(fileKey: string, write: () => T): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return write();
    } catch (err) {
      const busy = err instanceof Error && /database is locked|SQLITE_BUSY/i.test(err.message);
      if (!busy || attempt >= WRITE_ATTEMPTS) throw err;
      logger.debug(`Archive write of ${fileKey} waiting for another process (attempt ${attempt})`);
      await nextTick();
    }
  }
}

/** Write one batch of lines. Null when another process changed the copy since state was read. */
function writeBatch(state: ArchivedFileRow, lines: Uint8Array[], meta: LineMetadata, bytes: number): number | null {
  const db = getDb();
  const insertLine = db.prepare('INSERT INTO transcript_lines (file_key, line_number, data) VALUES (?, ?, ?)');

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = getArchivedFile(state.file_key)!;
    if (current.archived_bytes !== state.archived_bytes || current.line_count !== state.line_count) {
      db.exec('ROLLBACK');
      return null;
    }
    for (let i = 0; i < lines.length; i++) {
      insertLine.run(state.file_key, state.line_count + i + 1, lines[i]);
    }
    db.prepare(`
      UPDATE transcript_files SET
        archived_bytes = ?, line_count = ?, entry_count = entry_count + ?,
        first_timestamp = COALESCE(first_timestamp, ?),
        last_timestamp = CASE WHEN ? IS NOT NULL AND (last_timestamp IS NULL OR ? > last_timestamp) THEN ? ELSE last_timestamp END,
        first_prompt = CASE WHEN first_prompt = '' THEN ? ELSE first_prompt END,
        title = CASE WHEN ? != '' THEN ? ELSE title END,
        custom_title = CASE WHEN ? != '' THEN ? ELSE custom_title END,
        git_branch = CASE WHEN git_branch = '' THEN ? ELSE git_branch END,
        project_path = CASE WHEN project_path = '' THEN ? ELSE project_path END,
        parent_session_id = COALESCE(parent_session_id, ?),
        source_gone_at = NULL, error = NULL, updated_at = ?
      WHERE file_key = ?
    `).run(
      state.archived_bytes + bytes, state.line_count + lines.length, meta.entries,
      meta.firstTimestamp,
      meta.lastTimestamp, meta.lastTimestamp, meta.lastTimestamp,
      meta.firstPrompt,
      meta.title, meta.title,
      meta.customTitle, meta.customTitle,
      meta.gitBranch,
      meta.projectPath,
      meta.parentSessionId,
      new Date().toISOString(),
      state.file_key,
    );
    db.exec('COMMIT');
    return lines.length;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Session metadata found in new lines (a corrupt line is archived as is and skipped here). */
function readMetadata(projectDir: string, state: ArchivedFileRow, lines: Buffer[]): LineMetadata {
  const meta: LineMetadata = {
    entries: 0, firstTimestamp: null, lastTimestamp: null, firstPrompt: '', title: '', customTitle: '',
    gitBranch: '', projectPath: '', parentSessionId: null,
  };
  const needsParent = state.parent_session_id === null && state.session_id.startsWith('agent-');

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line.toString('utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (COUNTED_TYPES.has(type)) meta.entries++;

    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : null;
    if (ts) {
      if (!meta.firstTimestamp) meta.firstTimestamp = ts;
      if (!meta.lastTimestamp || ts > meta.lastTimestamp) meta.lastTimestamp = ts;
    }

    if (type === 'summary' && typeof entry.summary === 'string' && entry.summary) meta.title = entry.summary;
    if (type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle) meta.title = entry.aiTitle;
    if (type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle) meta.customTitle = entry.customTitle;

    if (!meta.gitBranch && typeof entry.gitBranch === 'string') meta.gitBranch = entry.gitBranch;
    // The project's real path: a cwd that encodes to this project dir (a session can start elsewhere)
    if (!meta.projectPath && typeof entry.cwd === 'string' && isProjectPath(entry.cwd, projectDir)) meta.projectPath = entry.cwd;
    // A subagent transcript at the project root (older Claude Code) names its main session in its entries
    if (needsParent && !meta.parentSessionId && typeof entry.sessionId === 'string' && entry.sessionId !== state.session_id) {
      meta.parentSessionId = entry.sessionId;
    }

    // First prompt: isMeta entries are Claude Code's own context (e.g. <local-command-caveat>)
    if (!state.first_prompt && !meta.firstPrompt && type === 'user' && !entry.isMeta) {
      meta.firstPrompt = promptText(entry).slice(0, FIRST_PROMPT_LABEL_CHARS);
    }
  }
  return meta;
}

/** Text the user typed in a user entry ('' for tool results). */
function promptText(entry: Record<string, unknown>): string {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.find((b: { type?: string; text?: unknown }) => b?.type === 'text' && typeof b.text === 'string');
    return text ? (text as { text: string }).text : '';
  }
  return '';
}

/** Copy a file kept beside a session when it is new or changed. Returns whether it was copied. */
async function archiveAttachment(projectDir: string, source: SourceAttachment): Promise<boolean> {
  const stat = statSync(source.path);
  const db = getDb();
  const existing = db.prepare('SELECT size, mtime_ms FROM transcript_attachments WHERE file_key = ?').get(source.fileKey) as
    { size: number; mtime_ms: number } | undefined;
  if (existing && existing.size === stat.size && existing.mtime_ms === stat.mtimeMs) return false;

  const data = compress(readFileSync(source.path));
  await whenWriteLockFree(source.fileKey, () => db.prepare(`
    INSERT OR REPLACE INTO transcript_attachments (file_key, project_dir, session_id, size, mtime_ms, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(source.fileKey, projectDir, source.sessionId, stat.size, stat.mtimeMs, data, new Date().toISOString()));
  return true;
}

/** Mark the archived transcripts whose source no longer exists. Returns how many were newly marked. */
async function markSourcesGone(projectDir: string, present: Set<string>): Promise<number> {
  const gone = getArchivedFiles(projectDir).filter((f) => f.source_gone_at === null && !present.has(f.file_key));
  if (gone.length === 0) return 0;
  const db = getDb();
  const now = new Date().toISOString();
  const mark = db.prepare('UPDATE transcript_files SET source_gone_at = ? WHERE file_key = ? AND source_gone_at IS NULL');
  await whenWriteLockFree(projectDir, () => inTransaction(db, () => {
    for (const f of gone) mark.run(now, f.file_key);
  }));
  logger.info(`${gone.length} transcript(s) of ${projectDir} deleted by Claude Code: the archived copies are kept`);
  return gone.length;
}
