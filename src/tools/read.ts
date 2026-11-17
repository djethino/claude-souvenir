import { DEFAULT_ENTRY_TYPES, parseTranscript } from '../transcript/parser.js';
import {
  formatEntry,
  formatExcerpt,
  formatSessionHeader,
  extractFileAccess,
  formatFilesOutput,
  extractToolUsage,
  formatToolsOutput,
} from '../transcript/formatter.js';
import { getConfig } from '../config.js';
import { resolveProjectDir } from '../utils/paths.js';
import { archiveErrorNote, ensureArchived, findSession, listProjectDirs, resolveCurrentSession } from '../archive/catalog.js';
import { decompress, getAttachment, getAttachments } from '../archive/store.js';
import { getSessionChunks, type ChunkRow } from '../db/store.js';
import type { DetailLevel, SessionInfo, TranscriptEntry } from '../transcript/types.js';

/** Last entries a session digest shows (souvenir_read's default page size). */
const DIGEST_ENTRIES = 20;

type Entry = { entry: TranscriptEntry; lineNumber: number; rawLength: number };

/** Content of a tool answer: text, or text and an image (a saved image read back). */
export type ReadContent = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;

/** The archive notes (files that could not be archived) to put before an answer. */
function withNote(note: string | null, text: string): string {
  return note ? `${note}\n\n${text}` : text;
}

/**
 * What Claude gets when a past session is cited (@ resource) or recapped (prompt): the session
 * header, the files it touched, and its last entries, with how to read further.
 * Looks in the current project first, then in every project. Returns null when the session does not exist.
 */
export async function readSessionDigest(sessionId: string): Promise<string | null> {
  const config = getConfig();
  const note = config.currentProject ? archiveErrorNote(await ensureArchived([config.currentProject])) : null;
  const session = (config.currentProject ? findSession(sessionId, config.currentProject) : null) ?? findSession(sessionId);
  if (!session) return null;

  const readMore = `Read more: souvenir_read session_id="${sessionId}" project="${session.projectDir}" (from_line for earlier entries, around_uuid for one moment).`;
  if (session.availability !== 'complete' || !session.fileKey) {
    const body = session.availability === 'partial'
      ? [`=== Last ${DIGEST_ENTRIES} excerpts ===`, readExcerptPage(session, undefined, DIGEST_ENTRIES)]
      : [];
    return withNote(note, [formatSessionHeader(session), readMore, '', ...body].join('\n'));
  }

  const files = await readAggregate(session, 'files', false);
  const lastEntries = await readPage(session, undefined, DIGEST_ENTRIES, DEFAULT_ENTRY_TYPES, 'conversation', false);

  return withNote(note, [
    formatSessionHeader(session),
    readMore,
    savedFilesLine(session),
    '',
    '=== Files touched ===',
    files,
    '',
    `=== Last ${DIGEST_ENTRIES} entries ===`,
    lastEntries,
  ].filter((line) => line !== null).join('\n'));
}

export async function handleSouvenirRead(params: {
  session_id?: string;
  project?: string;
  around_uuid?: string;
  from_line?: number;
  max_entries?: number;
  context_turns?: number;
  before_turns?: number;
  after_turns?: number;
  detail_level?: DetailLevel;
  entry_types?: string;
  saved_file?: string;
}): Promise<ReadContent> {
  if (params.saved_file) return readSavedFile(params.saved_file);
  if (!params.session_id) {
    return text('Error: session_id is required (or saved_file to read a file Claude Code saved with a session).');
  }

  const config = getConfig();
  const searchAllProjects = params.project === 'all';
  const projectDir = params.project && !searchAllProjects ? resolveProjectDir(params.project) : undefined;
  const homeDir = projectDir || config.currentProject || undefined;

  // Copy what Claude Code wrote since the last copy, so the session being written is read up to now
  const report = await ensureArchived(searchAllProjects ? listProjectDirs() : homeDir ? [homeDir] : []);
  const note = archiveErrorNote(report);

  const sessionId = params.session_id === 'current' ? resolveCurrentSession(homeDir) : params.session_id;
  if (!sessionId) {
    return text('Error: Could not determine current session. Use an explicit session_id.');
  }

  // The given project, else the current one, else any project
  const session = searchAllProjects
    ? findSession(sessionId)
    : (homeDir ? findSession(sessionId, homeDir) : null) ?? (projectDir ? null : findSession(sessionId));
  if (!session) {
    return text(withNote(note, `Error: Session "${sessionId}" not found in ${projectDir ? `project "${params.project}"` : 'any project'}. Use souvenir_sessions to list valid session IDs.`));
  }

  const maxEntries = Math.min(params.max_entries || 20, 200);
  const beforeTurns = params.before_turns ?? params.context_turns ?? 3;
  const afterTurns = params.after_turns ?? params.context_turns ?? 3;

  if (session.availability === 'lost') {
    return text(withNote(note, formatSessionHeader(session)));
  }

  if (session.availability === 'partial') {
    if (params.detail_level === 'files' || params.detail_level === 'tools') {
      return text(withNote(note, `${formatSessionHeader(session)}\n---\n(Not available: the excerpts kept of this session have no tool calls.)`));
    }
    const body = params.around_uuid
      ? readExcerptsAround(session, params.around_uuid, beforeTurns, afterTurns)
      : readExcerptPage(session, params.from_line, maxEntries);
    return text(withNote(note, body));
  }

  const entryTypes = params.entry_types
    ? params.entry_types.split(',').map((t) => t.trim())
    : DEFAULT_ENTRY_TYPES;
  const detailLevel: DetailLevel = params.detail_level || 'conversation';

  // Aggregate modes: process entire transcript, no pagination
  if (detailLevel === 'files' || detailLevel === 'tools') {
    return text(withNote(note, await readAggregate(session, detailLevel, true)));
  }

  if (params.around_uuid) {
    return text(withNote(note, await readAroundUuid(session, params.around_uuid, beforeTurns, afterTurns, entryTypes, detailLevel)));
  }

  return text(withNote(note, await readPage(session, params.from_line, maxEntries, entryTypes, detailLevel, true)));
}

function text(value: string): ReadContent {
  return [{ type: 'text', text: value }];
}

/** Session header, with the files Claude Code saved beside the session when there are some. */
function header(session: SessionInfo): string {
  return [formatSessionHeader(session), savedFilesLine(session)].filter((line) => line !== null).join('\n');
}

/** How many files Claude Code saved with the session (large tool results, images …), null when none. */
function savedFilesLine(session: SessionInfo): string | null {
  const saved = getAttachments(session.projectDir, session.sessionId);
  if (saved.length === 0) return null;
  const shown = saved.slice(0, 5).map((a) => a.file_key.split('/').slice(2).join('/')).join(', ');
  return `Saved files: ${saved.length} (${shown}${saved.length > 5 ? ', …' : ''}). A tool result that names one: souvenir_read saved_file="<path as written>".`;
}

/**
 * Format a character count for human-readable display.
 */
function formatSize(chars: number): string {
  if (chars < 1000) return `${chars}`;
  if (chars < 1000000) return `${(chars / 1000).toFixed(1)}K`;
  return `${(chars / 1000000).toFixed(1)}M`;
}

/** All entries of an archived session of the given types, in order. */
async function collectEntries(session: SessionInfo, entryTypes: string[]): Promise<Entry[]> {
  const entries: Entry[] = [];
  for await (const parsed of parseTranscript(session.fileKey!, { includeTypes: entryTypes })) {
    entries.push(parsed);
  }
  return entries;
}

/**
 * Unified page-based reading from a session.
 *
 * Collects all matching entries, then shows a page of max_entries:
 * - No from_line: shows the LAST page (most recent entries) — the default
 * - from_line=N: shows entries starting from line N (forward)
 *
 * Footer includes:
 * - Position: page number, entry range, line range
 * - Earlier page preview: from_line, entry count, total chars, largest entry size
 * - Later page preview: same format
 *
 * When max_entries=1, entries are shown without truncation (full content mode).
 */
async function readPage(
  session: SessionInfo,
  fromLine: number | undefined,
  maxEntries: number,
  entryTypes: string[],
  detailLevel: DetailLevel,
  withHeader: boolean,
): Promise<string> {
  const allEntries = await collectEntries(session, entryTypes);
  const totalEntries = allEntries.length;

  const output: string[] = [];
  if (withHeader) {
    output.push(header(session));
    output.push('---');
  }

  if (totalEntries === 0) {
    output.push('(No matching entries found)');
    return output.join('\n');
  }

  const { startIdx, endIdx } = pageWindow(allEntries.map((e) => e.lineNumber), fromLine, maxEntries);
  const pageEntries = allEntries.slice(startIdx, endIdx);
  const singleEntry = maxEntries === 1;

  let count = 0;
  let firstLine = 0;
  let lastLine = 0;

  for (const { entry, lineNumber } of pageEntries) {
    const formatted = formatEntry(entry, { detailLevel, noTruncate: singleEntry });
    if (formatted) {
      if (firstLine === 0) firstLine = lineNumber;
      lastLine = lineNumber;

      let line = `[L${lineNumber}] ${formatted}`;

      // Add drill-down hint if entry was truncated (only in multi-entry mode)
      if (!singleEntry && line.includes('[...truncated:') && entry.uuid) {
        line += `\n  >> Full entry: souvenir_read around_uuid="${entry.uuid}" max_entries=1 detail_level=full`;
      }

      output.push(line);
      output.push('');
      count++;
    }
  }

  if (count === 0) {
    output.push('(No matching entries in this range)');
    return output.join('\n');
  }

  output.push(...pageFooter(allEntries.map((e) => ({ lineNumber: e.lineNumber, size: e.rawLength })), fromLine, maxEntries, startIdx, endIdx, firstLine, lastLine, 'entries'));
  return output.join('\n');
}

/** Index range of a page: the last page by default, else the page starting at fromLine. */
function pageWindow(lineNumbers: number[], fromLine: number | undefined, maxEntries: number): { startIdx: number; endIdx: number } {
  const total = lineNumbers.length;
  if (fromLine === undefined) {
    return { startIdx: Math.max(0, total - maxEntries), endIdx: total };
  }
  let startIdx = lineNumbers.findIndex((line) => line >= fromLine);
  if (startIdx === -1) startIdx = total;
  return { startIdx, endIdx: Math.min(startIdx + maxEntries, total) };
}

/** Pagination footer: position, and how to read the earlier and later pages with their size. */
function pageFooter(
  items: Array<{ lineNumber: number; size: number }>,
  fromLine: number | undefined,
  maxEntries: number,
  startIdx: number,
  endIdx: number,
  firstLine: number,
  lastLine: number,
  unit: string,
): string[] {
  const total = items.length;
  const totalPages = Math.ceil(total / maxEntries);
  const currentPage = fromLine === undefined ? totalPages : Math.min(totalPages, Math.floor(startIdx / maxEntries) + 1);
  const lines = [
    `--- Page ~${currentPage}/${totalPages} | ${unit[0].toUpperCase()}${unit.slice(1)} ${startIdx + 1}-${Math.min(endIdx, total)} of ${total} (L${firstLine}-L${lastLine}) ---`,
  ];

  const preview = (label: string, slice: typeof items) => {
    const totalChars = slice.reduce((sum, e) => sum + e.size, 0);
    const largest = Math.max(...slice.map((e) => e.size));
    lines.push(`--- ${label}: from_line=${slice[0].lineNumber} | ${slice.length} ${unit}, ~${formatSize(totalChars)} chars total, largest ~${formatSize(largest)} chars ---`);
  };
  if (startIdx > 0) preview('Earlier', items.slice(Math.max(0, startIdx - maxEntries), startIdx));
  if (endIdx < total) preview('Later', items.slice(endIdx, Math.min(endIdx + maxEntries, total)));
  return lines;
}

/**
 * Read entries around a target UUID, counting by visible conversation messages
 * (user/assistant) rather than raw JSONL entries.
 *
 * When before_turns=0 and after_turns=0, shows only the target entry with no truncation.
 */
async function readAroundUuid(
  session: SessionInfo,
  targetUuid: string,
  beforeTurns: number,
  afterTurns: number,
  entryTypes: string[],
  detailLevel: DetailLevel,
): Promise<string> {
  // We need user+assistant at minimum for counting messages, plus requested types
  const allEntries = await collectEntries(session, [...new Set([...entryTypes, 'user', 'assistant'])]);
  const targetIndex = allEntries.findIndex((e) => e.entry.uuid === targetUuid);

  if (targetIndex === -1) {
    return `Error: Entry with UUID "${targetUuid}" not found in this session.`;
  }

  const isMessage = (e: Entry) => e.entry.type === 'user' || e.entry.type === 'assistant';
  const totalMessages = allEntries.filter(isMessage).length;
  const targetMessageIndex = allEntries.slice(0, targetIndex + 1).filter(isMessage).length;

  // Count backwards by conversation messages (user/assistant)
  let startIndex = targetIndex;
  let messagesBefore = 0;
  for (let i = targetIndex - 1; i >= 0; i--) {
    if (isMessage(allEntries[i])) {
      messagesBefore++;
      if (messagesBefore > beforeTurns) break;
    }
    startIndex = i;
  }

  // Count forwards by conversation messages
  let endIndex = targetIndex;
  let messagesAfter = 0;
  for (let i = targetIndex + 1; i < allEntries.length; i++) {
    if (isMessage(allEntries[i])) {
      messagesAfter++;
      if (messagesAfter > afterTurns) break;
    }
    endIndex = i;
  }

  // Filter slice to only requested entry types
  const entryTypesSet = new Set(entryTypes);
  const slice = allEntries
    .slice(startIndex, endIndex + 1)
    .filter(({ entry }) => entryTypesSet.has(entry.type));

  // Single entry mode: no truncation (before=0, after=0 → only target)
  const singleEntry = beforeTurns === 0 && afterTurns === 0;

  const output: string[] = [
    header(session),
    '---',
    `(Target: message ${targetMessageIndex}/${totalMessages} | showing ${Math.min(messagesBefore, beforeTurns)} before, ${Math.min(messagesAfter, afterTurns)} after)`,
    '',
  ];

  for (const { entry, lineNumber } of slice) {
    const marker = entry.uuid === targetUuid ? '>>> ' : '    ';
    const formatted = formatEntry(entry, { detailLevel, noTruncate: singleEntry });
    if (formatted) {
      let line = `${marker}[L${lineNumber}] ${formatted}`;

      // Drill-down hint for truncated entries (when showing multiple entries)
      if (!singleEntry && line.includes('[...truncated:') && entry.uuid) {
        line += `\n      >> Full entry: souvenir_read around_uuid="${entry.uuid}" max_entries=1 detail_level=full`;
      }

      output.push(line);
      output.push('');
    }
  }

  return output.join('\n');
}

/**
 * Aggregate mode: process entire transcript and extract structured data.
 * Used by detail_level="files" and detail_level="tools".
 */
async function readAggregate(session: SessionInfo, mode: 'files' | 'tools', withHeader: boolean): Promise<string> {
  const allEntries = await collectEntries(session, ['user', 'assistant']);
  const output: string[] = [];
  if (withHeader) {
    output.push(header(session));
    output.push('---');
  }
  output.push(mode === 'files'
    ? formatFilesOutput(extractFileAccess(allEntries))
    : formatToolsOutput(extractToolUsage(allEntries)));
  return output.join('\n');
}

// ── Partial sessions: only their search index excerpts remain ──────────────

/** A page of excerpts (same paging as readPage: the last page by default). */
function readExcerptPage(session: SessionInfo, fromLine: number | undefined, maxEntries: number): string {
  const excerpts = getSessionChunks(session.projectDir, session.sessionId);
  const output = [formatSessionHeader(session), '---'];
  if (excerpts.length === 0) {
    output.push('(No excerpts found)');
    return output.join('\n');
  }

  const lineOf = (c: ChunkRow) => c.line_number ?? 0;
  const { startIdx, endIdx } = pageWindow(excerpts.map(lineOf), fromLine, maxEntries);
  const page = excerpts.slice(startIdx, endIdx);
  if (page.length === 0) {
    output.push('(No excerpts in this range)');
    return output.join('\n');
  }
  for (const c of page) {
    output.push(`[L${lineOf(c)}] ${formatExcerpt(c)}`, '');
  }
  output.push(...pageFooter(
    excerpts.map((c) => ({ lineNumber: lineOf(c), size: c.content_text.length })),
    fromLine, maxEntries, startIdx, endIdx, lineOf(page[0]), lineOf(page[page.length - 1]), 'excerpts',
  ));
  return output.join('\n');
}

/** Excerpts around the one of an entry uuid (before/after counted in excerpts). */
function readExcerptsAround(session: SessionInfo, targetUuid: string, before: number, after: number): string {
  const excerpts = getSessionChunks(session.projectDir, session.sessionId);
  const target = excerpts.findIndex((c) => c.entry_uuid === targetUuid);
  if (target === -1) return `${formatSessionHeader(session)}\n---\nError: Entry with UUID "${targetUuid}" not found in the excerpts of this session.`;

  const output = [formatSessionHeader(session), '---', `(Target: excerpt ${target + 1}/${excerpts.length})`, ''];
  for (let i = Math.max(0, target - before); i <= Math.min(excerpts.length - 1, target + after); i++) {
    const c = excerpts[i];
    output.push(`${i === target ? '>>> ' : '    '}[L${c.line_number ?? 0}] ${formatExcerpt(c)}`, '');
  }
  return output.join('\n');
}

// ── Files Claude Code saved beside a session ────────────────────────────────

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/**
 * A file Claude Code saved with a session (large tool output, image …), read from the archive.
 * The path is given as a transcript wrote it (absolute, any separators) or relative to the
 * projects folder.
 */
function readSavedFile(path: string): ReadContent {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const saved = getAttachment(segments.slice(i).join('/'));
    if (!saved) continue;
    const data = decompress(saved.data);
    const extension = saved.file_key.slice(saved.file_key.lastIndexOf('.') + 1).toLowerCase();
    const label = `Saved file ${saved.file_key} (${saved.size} bytes, session ${saved.session_id})`;
    const mimeType = IMAGE_TYPES[extension];
    if (mimeType) {
      return [{ type: 'text', text: label }, { type: 'image', data: data.toString('base64'), mimeType }];
    }
    if (data.includes(0)) {
      return text(`${label}: binary file (.${extension}), not shown as text.`);
    }
    return text(`${label}:\n${data.toString('utf8')}`);
  }
  return text(`Error: no saved file matching "${path}" in souvenir's archive. Files are archived from the session folders (tool-results/, subagents/) of each project.`);
}
