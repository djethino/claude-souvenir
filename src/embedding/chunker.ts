import { extractText, isToolResultEntry, parseTranscript } from '../transcript/parser.js';
import { logger } from '../utils/logger.js';
import type { ArchivedFileRow } from '../archive/store.js';
import type { NewChunk } from '../db/store.js';
import type { TranscriptEntry } from '../transcript/types.js';

/**
 * Characters embedded per vector: ~400 tokens, within what every supported model reads whole
 * (EmbeddingGemma: 2048 tokens; servers truncate beyond the model's limit). A longer text is not
 * cut: it is embedded in several overlapping parts, so every part of it can be found.
 */
const EMBED_WINDOW_CHARS = 1600;
/** Characters shared by two consecutive parts, so that a sentence across a boundary stays whole in one. */
const WINDOW_OVERLAP_CHARS = 200;

/**
 * Split a text into parts of at most EMBED_WINDOW_CHARS, breaking at a space when one is near
 * the end, each part starting WINDOW_OVERLAP_CHARS before the end of the previous one.
 */
export function windows(text: string): Array<{ start: number; end: number }> {
  if (text.length <= EMBED_WINDOW_CHARS) return [{ start: 0, end: text.length }];
  const parts: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (;;) {
    let end = Math.min(start + EMBED_WINDOW_CHARS, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > start + EMBED_WINDOW_CHARS * 0.7) end = space;
    }
    parts.push({ start, end });
    if (end >= text.length) return parts;
    start = Math.max(end - WINDOW_OVERLAP_CHARS, start + 1);
  }
}

/**
 * Turn the new lines of an archived transcript into chunks to embed:
 * - a turn: what the user wrote and the whole reply that follows (every assistant entry until the
 *   user writes again), embedded in as many parts as its length needs;
 * - a tool result: its first part only — tool output (file contents, command output) can run to
 *   megabytes; text search reads all of it in the archive;
 * - an assistant entry whose prompt was indexed in an earlier run (the reply was still being
 *   written), and summaries: on their own.
 * Returns the chunks and the last line read (the archive's line count when the read started).
 */
export async function chunkTranscript(
  file: ArchivedFileRow,
  fromLine: number,
): Promise<{ chunks: NewChunk[]; lastLine: number }> {
  const toLine = file.line_count;
  const entries: Array<{ entry: TranscriptEntry; lineNumber: number }> = [];
  for await (const parsed of parseTranscript(file.file_key, { includeTypes: ['user', 'assistant', 'summary'], fromLine, toLine })) {
    entries.push(parsed);
  }

  const chunks: NewChunk[] = [];
  const base = { session_id: file.session_id, project_dir: file.project_dir };

  /** Add the parts of a text; userEnd: where the user's words end in it (0 when it has none). */
  const addText = (text: string, start: { entry: TranscriptEntry; lineNumber: number }, role: string, userEnd: number, hasAssistant: boolean, firstPartOnly = false) => {
    const parts = windows(text);
    (firstPartOnly ? parts.slice(0, 1) : parts).forEach(({ start: s, end: e }, part) => {
      chunks.push({
        ...base,
        entry_uuid: start.entry.uuid,
        role,
        content_text: text.slice(s, e),
        timestamp: start.entry.timestamp,
        line_number: start.lineNumber,
        part,
        hasUser: s < userEnd,
        hasAssistant: hasAssistant && e > userEnd,
      });
    });
  };

  let i = 0;
  while (i < entries.length) {
    const current = entries[i];
    const { entry } = current;

    if (entry.type === 'summary') {
      const text = extractText(entry);
      if (text.trim()) addText(text, current, 'summary', 0, false);
      i++;
      continue;
    }

    if (entry.type === 'user' && isToolResultEntry(entry)) {
      const text = extractText(entry);
      if (text.trim()) addText(`TOOL RESULT: ${text}`, current, 'tool_result', 0, false, true);
      i++;
      continue;
    }

    if (entry.type === 'user') {
      const userPart = `USER: ${extractText(entry)}`;
      const replies: string[] = [];
      i++;
      // The reply: every assistant entry until the user writes again (tool results in between are chunks of their own)
      while (i < entries.length) {
        const next = entries[i];
        if (next.entry.type === 'assistant') {
          const text = extractText(next.entry);
          if (text.trim()) replies.push(text);
        } else if (next.entry.type === 'user' && isToolResultEntry(next.entry)) {
          const text = extractText(next.entry);
          if (text.trim()) addText(`TOOL RESULT: ${text}`, next, 'tool_result', 0, false, true);
        } else if (next.entry.type === 'summary') {
          const text = extractText(next.entry);
          if (text.trim()) addText(text, next, 'summary', 0, false);
        } else {
          break; // the user writes again: next turn
        }
        i++;
      }
      const text = replies.length > 0 ? `${userPart}\nASSISTANT: ${replies.join('\n')}` : userPart;
      if (text.trim() !== 'USER:') addText(text, current, 'turn', userPart.length, replies.length > 0);
      continue;
    }

    // Assistant entry whose prompt was chunked in an earlier run
    const text = extractText(entry);
    if (text.trim()) addText(`ASSISTANT: ${text}`, current, 'assistant', 0, true);
    i++;
  }

  logger.debug(`Chunked ${file.file_key} from line ${fromLine}: ${entries.length} entries -> ${chunks.length} chunks`);
  return { chunks, lastLine: toLine };
}
