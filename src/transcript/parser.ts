import { logger } from '../utils/logger.js';
import { archivedLines } from '../archive/store.js';
import type { TranscriptEntry, UserEntry, AssistantEntry, ContentBlock, TextBlock, ToolUseBlock } from './types.js';

export interface ParseOptions {
  /** Entry types to include. Default: ['user', 'assistant', 'summary'] */
  includeTypes?: string[];
  /** Skip lines before this line number (1-based) */
  fromLine?: number;
  /** Stop after this line number (lines archived meanwhile are left for the next read) */
  toLine?: number;
  /** Maximum entries to yield */
  maxEntries?: number;
  /** Raw string pre-filter: only parse lines containing this text */
  containsText?: string;
  /** Case-insensitive text matching */
  caseInsensitive?: boolean;
}

export interface ParsedLine {
  entry: TranscriptEntry;
  lineNumber: number;
  rawLength: number;
}

/** Lines never read: file-history-snapshot, the dominant type, never useful. */
const SKIPPED_LINE_MARKER = '"file-history-snapshot"';

/** Entry types read when the caller names none. */
export const DEFAULT_ENTRY_TYPES = ['user', 'assistant', 'summary'];

/**
 * Parse an archived transcript (see archive/store.ts), yielding entries one at a time.
 * Applies pre-filters on raw strings before JSON.parse for performance.
 */
export async function* parseTranscript(
  fileKey: string,
  options: ParseOptions = {},
): AsyncGenerator<ParsedLine> {
  const {
    includeTypes = DEFAULT_ENTRY_TYPES,
    fromLine = 1,
    toLine,
    maxEntries,
    containsText,
    caseInsensitive = true,
  } = options;

  const searchText = containsText && caseInsensitive ? containsText.toLowerCase() : containsText;
  let yielded = 0;

  for (const { lineNumber, text: line } of archivedLines(fileKey, fromLine)) {
    if (toLine !== undefined && lineNumber > toLine) break;
    if (maxEntries && yielded >= maxEntries) break;

    // Skip empty lines
    if (!line.trim()) continue;

    // Pre-filter 1: Skip file-history-snapshot (dominant type, never useful for search)
    if (line.includes(SKIPPED_LINE_MARKER)) continue;

    // Pre-filter 2: If searching for text, skip lines that don't contain it
    if (searchText) {
      const haystack = caseInsensitive ? line.toLowerCase() : line;
      if (!haystack.includes(searchText)) continue;
    }

    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      logger.debug(`Skipping corrupt line ${lineNumber} in ${fileKey}`);
      continue;
    }

    if (!includeTypes.includes(entry.type)) continue;

    yielded++;
    yield { entry, lineNumber, rawLength: line.length };
  }
}

/** Text of a tool result's content: a string, or text blocks (images and other blocks have none). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: string; text?: unknown }) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Extract searchable text content from a transcript entry.
 */
export function extractText(entry: TranscriptEntry): string {
  switch (entry.type) {
    case 'user': {
      const user = entry as UserEntry;
      if (typeof user.message.content === 'string') {
        return user.message.content;
      }
      // Array content (tool results etc.)
      return user.message.content
        .map((block) => {
          if (block.type === 'text') return (block as TextBlock).text;
          if (block.type === 'tool_result') return toolResultText(block.content);
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }

    case 'assistant': {
      const asst = entry as AssistantEntry;
      return asst.message.content
        .map((block: ContentBlock) => {
          if (block.type === 'text') return (block as TextBlock).text;
          if (block.type === 'tool_use') {
            const tool = block as ToolUseBlock;
            return `[Tool: ${tool.name}]`;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }

    case 'summary':
      return (entry as { summary: string }).summary || '';

    default:
      return '';
  }
}

/** Whether a user entry is a tool result (Claude Code records them as user entries), not something the user wrote. */
export function isToolResultEntry(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user') return false;
  const content = (entry as UserEntry).message.content;
  return Array.isArray(content) && content.length > 0 && content.every((b) => b.type === 'tool_result');
}
