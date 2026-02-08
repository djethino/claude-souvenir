import { extractText, parseTranscript } from '../transcript/parser.js';
import { logger } from '../utils/logger.js';
import type { TranscriptEntry, UserEntry, AssistantEntry } from '../transcript/types.js';

export interface Chunk {
  session_id: string;
  project_dir: string;
  entry_uuid?: string;
  role: string;
  content_text: string;
  embed_text: string;
  timestamp?: string;
  line_number: number;
}

const MAX_EMBED_CHARS = 1600; // ~400 tokens for EmbeddingGemma (2048 token limit)
const MAX_CONTENT_CHARS = 2000; // Full text for display

/**
 * Truncate text to a max character count, respecting word boundaries.
 */
function truncateForEmbed(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Try to break at a word boundary
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > maxChars * 0.7 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Process a transcript file into chunks for embedding.
 * Groups user+assistant pairs into conversation turns.
 */
export async function chunkTranscript(
  filePath: string,
  sessionId: string,
  projectDir: string,
  options: { fromLine?: number } = {},
): Promise<{ chunks: Chunk[]; lastLine: number }> {
  const chunks: Chunk[] = [];
  let lastLine = 0;

  // Collect entries
  const entries: Array<{ entry: TranscriptEntry; lineNumber: number }> = [];

  const stream = parseTranscript(filePath, {
    includeTypes: ['user', 'assistant', 'summary'],
    fromLine: options.fromLine,
  });

  for await (const parsed of stream) {
    entries.push(parsed);
    lastLine = Math.max(lastLine, parsed.lineNumber);
  }

  // Group into turns: user message + following assistant response
  let i = 0;
  while (i < entries.length) {
    const current = entries[i];
    const entry = current.entry;

    if (entry.type === 'summary') {
      // Summary entries are standalone chunks
      const text = (entry as { summary: string }).summary || '';
      if (text.trim()) {
        chunks.push({
          session_id: sessionId,
          project_dir: projectDir,
          entry_uuid: entry.uuid,
          role: 'summary',
          content_text: truncateForEmbed(text, MAX_CONTENT_CHARS),
          embed_text: truncateForEmbed(text, MAX_EMBED_CHARS),
          timestamp: entry.timestamp,
          line_number: current.lineNumber,
        });
      }
      i++;
      continue;
    }

    if (entry.type === 'user') {
      const userText = extractText(entry);
      let turnText = userText;
      let contentParts = [`USER: ${userText}`];

      // Look ahead for assistant response
      if (i + 1 < entries.length && entries[i + 1].entry.type === 'assistant') {
        const assistantEntry = entries[i + 1].entry;
        const assistantText = extractText(assistantEntry);
        turnText += '\n' + assistantText;
        contentParts.push(`ASSISTANT: ${assistantText}`);
        i++; // Skip the assistant entry
      }

      if (turnText.trim()) {
        chunks.push({
          session_id: sessionId,
          project_dir: projectDir,
          entry_uuid: entry.uuid,
          role: 'turn',
          content_text: truncateForEmbed(contentParts.join('\n'), MAX_CONTENT_CHARS),
          embed_text: truncateForEmbed(turnText, MAX_EMBED_CHARS),
          timestamp: entry.timestamp,
          line_number: current.lineNumber,
        });
      }
      i++;
      continue;
    }

    // Standalone assistant entry (no preceding user message)
    if (entry.type === 'assistant') {
      const text = extractText(entry);
      if (text.trim()) {
        chunks.push({
          session_id: sessionId,
          project_dir: projectDir,
          entry_uuid: entry.uuid,
          role: 'assistant',
          content_text: truncateForEmbed(`ASSISTANT: ${text}`, MAX_CONTENT_CHARS),
          embed_text: truncateForEmbed(text, MAX_EMBED_CHARS),
          timestamp: entry.timestamp,
          line_number: current.lineNumber,
        });
      }
      i++;
      continue;
    }

    i++;
  }

  logger.debug(`Chunked ${filePath}: ${entries.length} entries -> ${chunks.length} chunks`);
  return { chunks, lastLine };
}
