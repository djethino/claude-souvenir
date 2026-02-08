import type {
  TranscriptEntry,
  UserEntry,
  AssistantEntry,
  SummaryEntry,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  SessionIndexEntry,
} from './types.js';

const MAX_TEXT_LENGTH = 2000;
const MAX_TOOL_INPUT_LENGTH = 200;

/**
 * Format a timestamp to a readable date string.
 */
function formatTimestamp(ts: string | undefined): string {
  if (!ts) return '???';
  try {
    const d = new Date(ts);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return ts;
  }
}

/**
 * Truncate text with ellipsis.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `... (${Math.round(text.length / 1024)}KB total)`;
}

/**
 * Format a content block (assistant response part).
 */
function formatContentBlock(block: ContentBlock, includeToolDetails: boolean): string {
  switch (block.type) {
    case 'text':
      return truncate((block as TextBlock).text, MAX_TEXT_LENGTH);

    case 'tool_use': {
      const tool = block as ToolUseBlock;
      if (includeToolDetails) {
        const inputStr = JSON.stringify(tool.input, null, 2);
        return `  [Tool: ${tool.name}]\n  Input: ${truncate(inputStr, MAX_TOOL_INPUT_LENGTH)}`;
      }
      // Compact form: show tool name and key param
      const firstKey = Object.keys(tool.input)[0];
      const firstVal = firstKey ? String(tool.input[firstKey]).slice(0, 80) : '';
      return `  [Tool: ${tool.name}${firstKey ? ` "${firstVal}"` : ''}]`;
    }

    case 'tool_result': {
      const result = block as ToolResultBlock;
      if (includeToolDetails) {
        return `  [Result${result.is_error ? ' ERROR' : ''}]: ${truncate(result.content, MAX_TEXT_LENGTH)}`;
      }
      const lines = (result.content || '').split('\n').length;
      return `  [Result${result.is_error ? ' ERROR' : ''}: ${lines} lines]`;
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
  options: { includeToolDetails?: boolean } = {},
): string {
  const { includeToolDetails = false } = options;
  const ts = formatTimestamp(entry.timestamp);

  switch (entry.type) {
    case 'user': {
      const user = entry as UserEntry;
      let content: string;
      if (typeof user.message.content === 'string') {
        content = truncate(user.message.content, MAX_TEXT_LENGTH);
      } else {
        content = user.message.content
          .map((b) => formatContentBlock(b, includeToolDetails))
          .filter(Boolean)
          .join('\n');
      }
      return `[${ts}] USER:\n${content}`;
    }

    case 'assistant': {
      const asst = entry as AssistantEntry;
      const parts = asst.message.content
        .map((b: ContentBlock) => formatContentBlock(b, includeToolDetails))
        .filter(Boolean);
      const model = asst.message.model ? ` (${asst.message.model})` : '';
      return `[${ts}] ASSISTANT${model}:\n${parts.join('\n')}`;
    }

    case 'summary': {
      const sum = entry as SummaryEntry;
      return `[${ts}] SUMMARY:\n${sum.summary}`;
    }

    case 'progress':
      return `[${ts}] PROGRESS: ${JSON.stringify(entry)}`.slice(0, 200);

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
  const title = meta.summary || meta.firstPrompt || 'No summary';
  const truncTitle = title.length > 100 ? title.slice(0, 100) + '...' : title;

  const lines = [
    `${index + 1}. [${date}] ${truncTitle}`,
    `   ID: ${meta.sessionId}`,
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
 */
export function formatSearchResult(
  result: {
    role: string;
    snippet: string;
    timestamp?: string;
    score: number;
    sessionId: string;
    sessionSummary?: string;
    lineNumber: number;
  },
  index: number,
): string {
  const ts = result.timestamp ? formatTimestamp(result.timestamp) : '???';
  const session = result.sessionSummary
    ? result.sessionSummary.slice(0, 80)
    : result.sessionId.slice(0, 8);
  const scoreStr = result.score.toFixed(2);

  const lines = [
    `--- Result ${index + 1} (score: ${scoreStr}) ---`,
    `Session: ${session}`,
    `Date: ${ts} | Role: ${result.role} | Line: ${result.lineNumber}`,
    `> ${result.snippet.replace(/\n/g, '\n> ')}`,
  ];

  return lines.join('\n');
}
