import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { logger } from '../utils/logger.js';
import type { TranscriptEntry, UserEntry, AssistantEntry, ContentBlock, TextBlock, ToolUseBlock } from './types.js';

export interface ParseOptions {
  /** Entry types to include. Default: ['user', 'assistant', 'summary'] */
  includeTypes?: string[];
  /** Skip lines before this line number (1-based) */
  fromLine?: number;
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

const SKIP_TYPE = '"file-history-snapshot"';

/**
 * Stream-parse a JSONL transcript file, yielding entries one at a time.
 * Applies pre-filters on raw strings before JSON.parse for performance.
 */
export async function* parseTranscript(
  filePath: string,
  options: ParseOptions = {},
): AsyncGenerator<ParsedLine> {
  const {
    includeTypes = ['user', 'assistant', 'summary'],
    fromLine = 1,
    maxEntries,
    containsText,
    caseInsensitive = true,
  } = options;

  const searchText = containsText && caseInsensitive ? containsText.toLowerCase() : containsText;

  let lineNumber = 0;
  let yielded = 0;

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      lineNumber++;

      // Skip lines before fromLine
      if (lineNumber < fromLine) continue;

      // Check max entries
      if (maxEntries && yielded >= maxEntries) break;

      // Skip empty lines
      if (!line.trim()) continue;

      // Pre-filter 1: Skip file-history-snapshot (dominant type, never useful for search)
      if (line.includes(SKIP_TYPE)) continue;

      // Pre-filter 2: If searching for text, skip lines that don't contain it
      if (searchText) {
        const haystack = caseInsensitive ? line.toLowerCase() : line;
        if (!haystack.includes(searchText)) continue;
      }

      // Parse JSON
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        logger.debug(`Skipping corrupt line ${lineNumber} in ${filePath}`);
        continue;
      }

      // Type filter
      if (!includeTypes.includes(entry.type)) continue;

      yielded++;
      yield { entry, lineNumber, rawLength: line.length };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
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
          if ('text' in block) return (block as TextBlock).text;
          if ('content' in block) return block.content;
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

/**
 * Count total lines in a JSONL file quickly (for progress).
 */
export async function countLines(filePath: string): Promise<number> {
  let count = 0;
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const _line of rl) {
    count++;
  }

  rl.close();
  stream.destroy();
  return count;
}
