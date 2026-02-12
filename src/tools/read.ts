import { getSessionFilePath, getSessionMetadata, resolveCurrentSession } from '../transcript/discovery.js';
import { parseTranscript } from '../transcript/parser.js';
import { formatEntry, formatSessionHeader } from '../transcript/formatter.js';
import { getConfig } from '../config.js';
import { resolveProjectDir } from '../utils/paths.js';
import type { DetailLevel } from '../transcript/types.js';

export async function handleSouvenirRead(params: {
  session_id: string;
  project?: string;
  around_uuid?: string;
  from_line?: number;
  max_entries?: number;
  context_turns?: number;
  before_turns?: number;
  after_turns?: number;
  detail_level?: DetailLevel;
  entry_types?: string;
}): Promise<string> {
  const config = getConfig();
  const projectDir = params.project && params.project !== 'all'
    ? resolveProjectDir(params.project)
    : undefined;

  // Resolve "current" session_id
  const sessionId = params.session_id === 'current'
    ? resolveCurrentSession(projectDir || config.currentProject || undefined)
    : params.session_id;

  if (!sessionId) {
    return 'Error: Could not determine current session. Use an explicit session_id.';
  }

  // Find the session file
  const searchAllProjects = params.project === 'all';
  const searchDir = searchAllProjects ? undefined : (projectDir || config.currentProject || undefined);
  const location = getSessionFilePath(sessionId, searchDir);
  if (!location) {
    return `Error: Session "${sessionId}" not found in ${searchAllProjects ? 'any project' : projectDir ? `project "${params.project}"` : 'current project'}. Use souvenir_sessions to list valid session IDs, or specify the project parameter to search in a different project.`;
  }

  // Get session metadata
  const meta = getSessionMetadata(sessionId, location.projectDir);

  // Parse entry types
  const entryTypes = params.entry_types
    ? params.entry_types.split(',').map((t) => t.trim())
    : ['user', 'assistant', 'summary'];

  const maxEntries = Math.min(params.max_entries || 20, 200);
  const detailLevel: DetailLevel = params.detail_level || 'conversation';

  // If around_uuid is specified, center around that entry
  if (params.around_uuid) {
    const beforeTurns = params.before_turns ?? params.context_turns ?? 3;
    const afterTurns = params.after_turns ?? params.context_turns ?? 3;
    return await readAroundUuid(
      location.filePath,
      params.around_uuid,
      beforeTurns,
      afterTurns,
      entryTypes,
      detailLevel,
      meta,
    );
  }

  // Main page-based reading (default: from end)
  return await readPage(
    location.filePath,
    params.from_line,
    maxEntries,
    entryTypes,
    detailLevel,
    meta,
  );
}

/**
 * Format a character count for human-readable display.
 */
function formatSize(chars: number): string {
  if (chars < 1000) return `${chars}`;
  if (chars < 1000000) return `${(chars / 1000).toFixed(1)}K`;
  return `${(chars / 1000000).toFixed(1)}M`;
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
  filePath: string,
  fromLine: number | undefined,
  maxEntries: number,
  entryTypes: string[],
  detailLevel: DetailLevel,
  meta: ReturnType<typeof getSessionMetadata>,
): Promise<string> {
  // Collect ALL matching entries
  const allEntries: Array<{
    entry: import('../transcript/types.js').TranscriptEntry;
    lineNumber: number;
    rawLength: number;
  }> = [];
  const stream = parseTranscript(filePath, { includeTypes: entryTypes });

  for await (const parsed of stream) {
    allEntries.push(parsed);
  }

  const totalEntries = allEntries.length;

  // Header
  const output: string[] = [];
  if (meta) {
    output.push(formatSessionHeader(meta.entry));
    output.push('---');
  }

  if (totalEntries === 0) {
    output.push('(No matching entries found)');
    return output.join('\n');
  }

  // Determine page window
  let startIdx: number;
  let endIdx: number;

  if (fromLine === undefined) {
    // Default: last page (from end — most recent entries)
    endIdx = totalEntries;
    startIdx = Math.max(0, endIdx - maxEntries);
  } else {
    // Forward read from specified line
    startIdx = allEntries.findIndex((e) => e.lineNumber >= fromLine);
    if (startIdx === -1) startIdx = totalEntries;
    endIdx = Math.min(startIdx + maxEntries, totalEntries);
  }

  // Format entries in the page window
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

      let text = `[L${lineNumber}] ${formatted}`;

      // Add drill-down hint if entry was truncated (only in multi-entry mode)
      if (!singleEntry && text.includes('[...truncated:') && entry.uuid) {
        text += `\n  >> Full entry: souvenir_read around_uuid="${entry.uuid}" max_entries=1 detail_level=full`;
      }

      output.push(text);
      output.push('');
      count++;
    }
  }

  if (count === 0) {
    output.push('(No matching entries in this range)');
    return output.join('\n');
  }

  // Pagination footer
  const totalPages = Math.ceil(totalEntries / maxEntries);
  const currentPage = fromLine === undefined
    ? totalPages
    : Math.min(totalPages, Math.floor(startIdx / maxEntries) + 1);

  output.push(
    `--- Page ~${currentPage}/${totalPages} | Entries ${startIdx + 1}-${Math.min(endIdx, totalEntries)} of ${totalEntries} (L${firstLine}-L${lastLine}) ---`,
  );

  // Earlier page preview
  if (startIdx > 0) {
    const earlierEndIdx = startIdx;
    const earlierStartIdx = Math.max(0, earlierEndIdx - maxEntries);
    const earlierSlice = allEntries.slice(earlierStartIdx, earlierEndIdx);
    const earlierFromLine = earlierSlice[0].lineNumber;
    const earlierTotalChars = earlierSlice.reduce((sum, e) => sum + e.rawLength, 0);
    const earlierMaxEntry = Math.max(...earlierSlice.map((e) => e.rawLength));
    output.push(
      `--- Earlier: from_line=${earlierFromLine} | ${earlierSlice.length} entries, ~${formatSize(earlierTotalChars)} chars total, largest ~${formatSize(earlierMaxEntry)} chars ---`,
    );
  }

  // Later page preview
  if (endIdx < totalEntries) {
    const laterStartIdx = endIdx;
    const laterEndIdx = Math.min(laterStartIdx + maxEntries, totalEntries);
    const laterSlice = allEntries.slice(laterStartIdx, laterEndIdx);
    const laterFromLine = laterSlice[0].lineNumber;
    const laterTotalChars = laterSlice.reduce((sum, e) => sum + e.rawLength, 0);
    const laterMaxEntry = Math.max(...laterSlice.map((e) => e.rawLength));
    output.push(
      `--- Later: from_line=${laterFromLine} | ${laterSlice.length} entries, ~${formatSize(laterTotalChars)} chars total, largest ~${formatSize(laterMaxEntry)} chars ---`,
    );
  }

  return output.join('\n');
}

/**
 * Read entries around a target UUID, counting by visible conversation messages
 * (user/assistant) rather than raw JSONL entries.
 *
 * When before_turns=0 and after_turns=0, shows only the target entry with no truncation.
 */
async function readAroundUuid(
  filePath: string,
  targetUuid: string,
  beforeTurns: number,
  afterTurns: number,
  entryTypes: string[],
  detailLevel: DetailLevel,
  meta: ReturnType<typeof getSessionMetadata>,
): Promise<string> {
  // First pass: collect all entries (including types needed for context)
  // We need user+assistant at minimum for counting messages, plus requested types
  const collectTypes = new Set([...entryTypes, 'user', 'assistant']);
  const allEntries: Array<{
    entry: import('../transcript/types.js').TranscriptEntry;
    lineNumber: number;
    rawLength: number;
  }> = [];
  let targetIndex = -1;

  const stream = parseTranscript(filePath, { includeTypes: [...collectTypes] });

  for await (const parsed of stream) {
    allEntries.push(parsed);
    if (parsed.entry.uuid === targetUuid) {
      targetIndex = allEntries.length - 1;
    }
  }

  if (targetIndex === -1) {
    return `Error: Entry with UUID "${targetUuid}" not found in this session.`;
  }

  // Count total conversation messages for position info
  const totalMessages = allEntries.filter(
    (e) => e.entry.type === 'user' || e.entry.type === 'assistant',
  ).length;
  const targetMessageIndex = allEntries
    .slice(0, targetIndex + 1)
    .filter((e) => e.entry.type === 'user' || e.entry.type === 'assistant').length;

  // Count backwards by conversation messages (user/assistant)
  let startIndex = targetIndex;
  let messagesBefore = 0;
  for (let i = targetIndex - 1; i >= 0; i--) {
    const type = allEntries[i].entry.type;
    if (type === 'user' || type === 'assistant') {
      messagesBefore++;
      if (messagesBefore > beforeTurns) break;
    }
    startIndex = i;
  }

  // Count forwards by conversation messages
  let endIndex = targetIndex;
  let messagesAfter = 0;
  for (let i = targetIndex + 1; i < allEntries.length; i++) {
    const type = allEntries[i].entry.type;
    if (type === 'user' || type === 'assistant') {
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

  const output: string[] = [];

  if (meta) {
    output.push(formatSessionHeader(meta.entry));
    output.push('---');
    output.push(`(Target: message ${targetMessageIndex}/${totalMessages} | showing ${messagesBefore} before, ${messagesAfter} after)`);
    output.push('');
  }

  for (const { entry, lineNumber } of slice) {
    const isTarget = entry.uuid === targetUuid;
    const marker = isTarget ? '>>> ' : '    ';
    const formatted = formatEntry(entry, { detailLevel, noTruncate: singleEntry });
    if (formatted) {
      let text = `${marker}[L${lineNumber}] ${formatted}`;

      // Drill-down hint for truncated entries (when showing multiple entries)
      if (!singleEntry && text.includes('[...truncated:') && entry.uuid) {
        text += `\n      >> Full entry: souvenir_read around_uuid="${entry.uuid}" max_entries=1 detail_level=full`;
      }

      output.push(text);
      output.push('');
    }
  }

  return output.join('\n');
}
