import type {
  TranscriptEntry,
  UserEntry,
  AssistantEntry,
  SummaryEntry,
  ProgressEntry,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  SessionIndexEntry,
  DetailLevel,
} from './types.js';

// Truncation limits per detail level
const TEXT_LIMITS: Record<string, number> = {
  conversation: 4000,
  compact: 4000,
  full: 20000,
};
const TOOL_INPUT_LIMITS: Record<string, number> = {
  compact: 200, // Not used in conversation (tools are summarized)
  full: 5000,
};
const TOOL_RESULT_LIMITS: Record<string, number> = {
  full: 10000,
};

/**
 * Format a relative time string (e.g., "2h ago", "3 days ago").
 */
function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

/**
 * Format a timestamp to a readable date string with relative time.
 */
function formatTimestamp(ts: string | undefined): string {
  if (!ts) return '???';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    const absolute = d.toISOString().replace('T', ' ').slice(0, 19);
    const relative = formatRelativeTime(d);
    return `${absolute} (${relative})`;
  } catch {
    return ts;
  }
}

/**
 * Format a timestamp compactly (for search results where space matters).
 */
function formatTimestampCompact(ts: string | undefined): string {
  if (!ts) return '???';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return formatRelativeTime(d);
  } catch {
    return ts;
  }
}

/**
 * Truncate text with clear indicator of how much was cut.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const remaining = text.length - maxLen;
  return text.slice(0, maxLen) + `\n[...truncated: showing ${maxLen}/${text.length} chars, ${remaining} more]`;
}

/**
 * Format a content block (assistant response part).
 * @param detailLevel - 'conversation' skips tools (handled by caller), 'compact' shows names, 'full' shows everything
 */
function formatContentBlock(block: ContentBlock, detailLevel: DetailLevel, noTruncate = false): string {
  const textLimit = noTruncate ? Infinity : (TEXT_LIMITS[detailLevel] ?? 4000);

  switch (block.type) {
    case 'text':
      return truncate((block as TextBlock).text, textLimit);

    case 'tool_use': {
      if (detailLevel === 'conversation') return ''; // Handled by caller as summary
      const tool = block as ToolUseBlock;
      if (detailLevel === 'full') {
        const inputLimit = noTruncate ? Infinity : (TOOL_INPUT_LIMITS[detailLevel] ?? 5000);
        const inputStr = JSON.stringify(tool.input, null, 2);
        return `  [Tool: ${tool.name}]\n  Input: ${truncate(inputStr, inputLimit)}`;
      }
      // compact: show tool name and key param
      const firstKey = Object.keys(tool.input)[0];
      const firstVal = firstKey ? String(tool.input[firstKey]).slice(0, 80) : '';
      return `  [Tool: ${tool.name}${firstKey ? ` "${firstVal}"` : ''}]`;
    }

    case 'tool_result': {
      if (detailLevel === 'conversation') return ''; // Handled by caller as summary
      if (detailLevel === 'compact') return ''; // Compact hides results
      const resultLimit = noTruncate ? Infinity : (TOOL_RESULT_LIMITS[detailLevel] ?? 10000);
      const result = block as ToolResultBlock;
      return `  [Result${result.is_error ? ' ERROR' : ''}]: ${truncate(result.content, resultLimit)}`;
    }

    case 'thinking':
      return ''; // Skip thinking blocks in output

    default:
      return '';
  }
}

/**
 * Format a single transcript entry to readable text.
 */
export function formatEntry(
  entry: TranscriptEntry,
  options: { detailLevel?: DetailLevel; noTruncate?: boolean } = {},
): string {
  const detailLevel: DetailLevel = options.detailLevel || 'conversation';
  const noTruncate = options.noTruncate || false;
  const ts = formatTimestamp(entry.timestamp);

  switch (entry.type) {
    case 'user': {
      const user = entry as UserEntry;
      const textLimit = noTruncate ? Infinity : (TEXT_LIMITS[detailLevel] ?? 4000);
      let content: string;
      if (typeof user.message.content === 'string') {
        content = truncate(user.message.content, textLimit);
      } else {
        content = user.message.content
          .map((b) => formatContentBlock(b, detailLevel, noTruncate))
          .filter(Boolean)
          .join('\n');
      }
      return `[${ts}] USER:\n${content}`;
    }

    case 'assistant': {
      const asst = entry as AssistantEntry;
      const blocks = asst.message.content;

      // In conversation mode, collect tool names for a summary line
      if (detailLevel === 'conversation') {
        const textParts = blocks
          .map((b: ContentBlock) => formatContentBlock(b, detailLevel, noTruncate))
          .filter((s) => s && s.trim());
        const toolNames = blocks
          .filter((b: ContentBlock) => b.type === 'tool_use')
          .map((b: ContentBlock) => (b as ToolUseBlock).name);
        const hasErrors = blocks
          .filter((b: ContentBlock) => b.type === 'tool_result')
          .some((b: ContentBlock) => (b as ToolResultBlock).is_error);

        if (textParts.length === 0 && toolNames.length === 0) return '';

        const model = asst.message.model ? ` (${asst.message.model})` : '';
        const lines: string[] = [];
        if (textParts.length > 0) lines.push(...textParts);
        if (toolNames.length > 0) {
          const unique = [...new Set(toolNames)];
          const errorTag = hasErrors ? ' (with errors)' : '';
          lines.push(`  [Used ${toolNames.length} tool${toolNames.length > 1 ? 's' : ''}: ${unique.join(', ')}${errorTag}]`);
        }
        return `[${ts}] ASSISTANT${model}:\n${lines.join('\n')}`;
      }

      // compact or full mode
      const parts = blocks
        .map((b: ContentBlock) => formatContentBlock(b, detailLevel, noTruncate))
        .filter((s) => s && s.trim());
      if (parts.length === 0) return ''; // Skip thinking-only or empty entries
      const model = asst.message.model ? ` (${asst.message.model})` : '';
      return `[${ts}] ASSISTANT${model}:\n${parts.join('\n')}`;
    }

    case 'summary': {
      const sum = entry as SummaryEntry;
      return `[${ts}] SUMMARY:\n${sum.summary}`;
    }

    case 'progress': {
      const prog = entry as ProgressEntry;
      const parts: string[] = [];
      if (prog.data?.hookEvent) parts.push(`hook:${prog.data.hookEvent}`);
      if (prog.data?.hookName) parts.push(prog.data.hookName);
      if (prog.data?.command) parts.push(`cmd: ${prog.data.command}`);
      if (prog.data?.type) parts.push(prog.data.type);
      const detail = parts.length > 0 ? parts.join(' | ') : 'event';
      return `[${ts}] PROGRESS: ${detail}`;
    }

    default:
      return '';
  }
}

/**
 * Format a session header.
 */
export function formatSessionHeader(meta: SessionIndexEntry): string {
  const created = formatTimestamp(meta.created);
  const modified = formatTimestamp(meta.modified);
  const lines = [
    `Session: ${meta.summary || meta.firstPrompt || 'No summary'}`,
    `ID: ${meta.sessionId}`,
    `Project: ${meta.projectPath || 'Unknown'}`,
    `Date: ${created} - ${modified}`,
    `Messages: ${meta.messageCount}${meta.gitBranch ? ` | Branch: ${meta.gitBranch}` : ''}`,
  ];
  return lines.join('\n');
}

/**
 * Format a session list entry (compact).
 */
export function formatSessionListEntry(meta: SessionIndexEntry, index: number): string {
  const date = meta.created ? meta.created.slice(0, 10) : '???';
  const relative = meta.modified ? formatTimestampCompact(meta.modified) : '';
  const title = meta.summary || meta.firstPrompt || 'No summary';
  const truncTitle = title.length > 100 ? title.slice(0, 100) + '...' : title;

  const lines = [
    `${index + 1}. [${date}${relative ? ` - ${relative}` : ''}] ${truncTitle}`,
    `   session_id: ${meta.sessionId}`,
  ];

  if (meta.firstPrompt && meta.firstPrompt !== title) {
    const firstPrompt = meta.firstPrompt.length > 80
      ? meta.firstPrompt.slice(0, 80) + '...'
      : meta.firstPrompt;
    lines.push(`   First: "${firstPrompt}"`);
  }

  const details: string[] = [];
  details.push(`Messages: ${meta.messageCount}`);
  if (meta.gitBranch) details.push(`Branch: ${meta.gitBranch}`);
  lines.push(`   ${details.join(' | ')}`);

  return lines.join('\n');
}

/**
 * Format a search result snippet.
 * Includes session_id and entry_uuid for easy drill-down with souvenir_read.
 */
export function formatSearchResult(
  result: {
    role: string;
    snippet: string;
    timestamp?: string;
    score: number;
    sessionId: string;
    entryUuid?: string;
    sessionSummary?: string;
    lineNumber: number;
  },
  index: number,
  sessionHitCount?: number,
): string {
  const ts = result.timestamp ? formatTimestampCompact(result.timestamp) : '???';
  const session = result.sessionSummary
    ? result.sessionSummary.slice(0, 80)
    : 'No summary';
  const scoreStr = result.score.toFixed(2);

  const lines = [
    `--- Result ${index + 1} (score: ${scoreStr}) ---`,
    `Session: ${session}`,
  ];

  if (sessionHitCount && sessionHitCount > 1) {
    lines.push(`  [Session: ${sessionHitCount} matching results]`);
  }

  lines.push(`  session_id: ${result.sessionId}`);

  if (result.entryUuid) {
    lines.push(`  entry_uuid: ${result.entryUuid}`);
  }

  lines.push(
    `${ts} | ${result.role} | Line ${result.lineNumber}`,
    `> ${result.snippet.replace(/\n/g, '\n> ')}`,
  );

  return lines.join('\n');
}

// ── Aggregate extraction functions ──────────────────────────────────────────

export interface FileAccessRecord {
  path: string;
  actions: Set<'read' | 'write' | 'search'>;
  count: number;
  hadError: boolean;
}

export interface ToolUsageRecord {
  name: string;
  count: number;
  errorCount: number;
}

/** Tools that take file_path as input */
const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const SEARCH_TOOLS = new Set(['Glob', 'Grep']);

type FileAction = 'read' | 'write' | 'search';

function classifyTool(baseName: string): FileAction | null {
  if (READ_TOOLS.has(baseName)) return 'read';
  if (WRITE_TOOLS.has(baseName)) return 'write';
  if (SEARCH_TOOLS.has(baseName)) return 'search';
  return null;
}

/** Strip MCP prefix: "mcp__server__ToolName" → "ToolName" */
function getBaseName(toolName: string): string {
  if (toolName.includes('__')) {
    return toolName.split('__').pop()!;
  }
  return toolName;
}

/**
 * Extract unique file paths accessed from transcript entries.
 * Processes assistant entries for tool_use blocks, user entries for tool_result errors.
 */
export function extractFileAccess(
  entries: Array<{ entry: TranscriptEntry; lineNumber: number }>,
): FileAccessRecord[] {
  const fileMap = new Map<string, FileAccessRecord>();
  const toolIdToPath = new Map<string, string>();

  for (const { entry } of entries) {
    if (entry.type !== 'assistant') continue;
    const asst = entry as AssistantEntry;

    for (const block of asst.message.content) {
      if (block.type !== 'tool_use') continue;
      const tool = block as ToolUseBlock;
      const baseName = getBaseName(tool.name);
      const action = classifyTool(baseName);
      if (!action) continue;

      const filePath = (tool.input.file_path as string | undefined)
        ?? (tool.input.path as string | undefined)
        ?? null;

      if (!filePath) continue;

      toolIdToPath.set(tool.id, filePath);

      const existing = fileMap.get(filePath);
      if (existing) {
        existing.actions.add(action);
        existing.count++;
      } else {
        fileMap.set(filePath, {
          path: filePath,
          actions: new Set([action]),
          count: 1,
          hadError: false,
        });
      }
    }
  }

  // Second pass: check user entries for tool_result errors
  for (const { entry } of entries) {
    if (entry.type !== 'user') continue;
    const user = entry as UserEntry;
    if (typeof user.message.content === 'string') continue;

    for (const block of user.message.content) {
      if (block.type !== 'tool_result') continue;
      const result = block as ToolResultBlock;
      if (!result.is_error) continue;

      const filePath = toolIdToPath.get(result.tool_use_id);
      if (filePath && fileMap.has(filePath)) {
        fileMap.get(filePath)!.hadError = true;
      }
    }
  }

  // Sort: written first, then read, then searched
  const records = [...fileMap.values()];
  records.sort((a, b) => {
    const aWrite = a.actions.has('write') ? 0 : 1;
    const bWrite = b.actions.has('write') ? 0 : 1;
    if (aWrite !== bWrite) return aWrite - bWrite;
    const aRead = a.actions.has('read') ? 0 : 1;
    const bRead = b.actions.has('read') ? 0 : 1;
    return aRead - bRead;
  });

  return records;
}

/**
 * Format file access records into a concise grouped output.
 */
export function formatFilesOutput(records: FileAccessRecord[]): string {
  if (records.length === 0) return '(No file access detected in this session)';

  const lines: string[] = [];
  const written = records.filter((r) => r.actions.has('write'));
  const readOnly = records.filter((r) => !r.actions.has('write') && r.actions.has('read'));
  const searched = records.filter((r) => !r.actions.has('write') && !r.actions.has('read'));

  if (written.length > 0) {
    lines.push(`Modified (${written.length}):`);
    for (const r of written) {
      lines.push(`  ${r.path}${r.hadError ? '  [ERROR]' : ''}`);
    }
  }

  if (readOnly.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Read (${readOnly.length}):`);
    for (const r of readOnly) {
      lines.push(`  ${r.path}${r.hadError ? '  [ERROR]' : ''}`);
    }
  }

  if (searched.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Searched (${searched.length}):`);
    for (const r of searched) {
      lines.push(`  ${r.path}`);
    }
  }

  lines.push('');
  lines.push(`Total: ${records.length} unique paths (${written.length} modified, ${readOnly.length} read, ${searched.length} searched)`);
  return lines.join('\n');
}

/**
 * Extract tool usage counts from transcript entries.
 */
export function extractToolUsage(
  entries: Array<{ entry: TranscriptEntry; lineNumber: number }>,
): ToolUsageRecord[] {
  const toolMap = new Map<string, ToolUsageRecord>();
  const toolIdToName = new Map<string, string>();

  for (const { entry } of entries) {
    if (entry.type === 'assistant') {
      const asst = entry as AssistantEntry;
      for (const block of asst.message.content) {
        if (block.type === 'tool_use') {
          const tool = block as ToolUseBlock;
          const existing = toolMap.get(tool.name);
          if (existing) {
            existing.count++;
          } else {
            toolMap.set(tool.name, { name: tool.name, count: 1, errorCount: 0 });
          }
          toolIdToName.set(tool.id, tool.name);
        }
      }
    }

    // tool_result blocks are in user entries
    if (entry.type === 'user') {
      const user = entry as UserEntry;
      if (typeof user.message.content === 'string') continue;
      for (const block of user.message.content) {
        if (block.type === 'tool_result') {
          const result = block as ToolResultBlock;
          if (result.is_error) {
            const toolName = toolIdToName.get(result.tool_use_id);
            if (toolName && toolMap.has(toolName)) {
              toolMap.get(toolName)!.errorCount++;
            }
          }
        }
      }
    }
  }

  return [...toolMap.values()].sort((a, b) => b.count - a.count);
}

/**
 * Format tool usage records into a concise summary.
 */
export function formatToolsOutput(records: ToolUsageRecord[]): string {
  if (records.length === 0) return '(No tool usage detected in this session)';

  const totalCalls = records.reduce((s, r) => s + r.count, 0);
  const totalErrors = records.reduce((s, r) => s + r.errorCount, 0);

  const lines: string[] = [];
  lines.push(`Tool usage (${totalCalls} calls, ${records.length} unique tools${totalErrors > 0 ? `, ${totalErrors} error${totalErrors > 1 ? 's' : ''}` : ''}):`);

  for (const r of records) {
    const error = r.errorCount > 0 ? ` (${r.errorCount} error${r.errorCount > 1 ? 's' : ''})` : '';
    lines.push(`  ${r.name}: ${r.count}${error}`);
  }

  return lines.join('\n');
}
