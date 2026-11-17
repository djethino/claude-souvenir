import { extractText, isToolResultEntry, readTranscript } from '../transcript/parser.js';
import { logger } from '../utils/logger.js';
import type { ArchivedFileRow } from '../archive/store.js';
import type { NewChunk } from '../db/store.js';
import type { TranscriptEntry } from '../transcript/types.js';

/**
 * Characters embedded per vector: ~400 tokens, within what every supported model reads whole
 * (EmbeddingGemma: 2048 tokens; servers truncate beyond the model's limit). A longer text is not
 * cut: it is embedded in several overlapping parts, so every part of it can be found.
 */
export const EMBED_WINDOW_CHARS = 1600;
/** Characters shared by two consecutive parts, so that a sentence across a boundary stays whole in one. */
export const WINDOW_OVERLAP_CHARS = 200;

/**
 * Version of the way chunks are cut from the archive (what an exchange's text holds, the parts).
 * Stored with each chunk: its text is re-made from the archive by this code (chunk-text.ts), so a
 * change to the cutting must bump it, and the chunks of an older format must be rebuilt.
 */
export const CHUNK_TEXT_FORMAT = 1;

/**
 * Split a text into parts of at most `size` characters, breaking at a space when one is near
 * the end, each part starting WINDOW_OVERLAP_CHARS before the end of the previous one.
 */
export function windows(text: string, size = EMBED_WINDOW_CHARS): Array<{ start: number; end: number }> {
  if (text.length <= size) return [{ start: 0, end: text.length }];
  const parts: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (;;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > start + size * 0.7) end = space;
    }
    parts.push({ start, end });
    if (end >= text.length) return parts;
    start = Math.max(end - WINDOW_OVERLAP_CHARS, start + 1);
  }
}

/** A text to embed, as read from the archive: an exchange, a tool result, a summary… */
export interface ChunkSource {
  /** First entry of the text (its line is the chunk's line) */
  entry: TranscriptEntry;
  lineNumber: number;
  /** Last archive line read for this text: reading [lineNumber, endLine] again gives the same text */
  endLine: number;
  role: 'turn' | 'tool_result' | 'summary' | 'assistant';
  text: string;
  /** Where the user's words end in the text (0 when it has none) */
  userEnd: number;
  hasAssistant: boolean;
  /** Tool output can run to megabytes: only its first part is embedded (text search reads all of it) */
  firstPartOnly: boolean;
}

/**
 * The texts to embed in archive lines [fromLine, toLine]:
 * - a turn: what the user wrote and the whole reply that follows (every assistant entry until the
 *   user writes again);
 * - a tool result, on its own;
 * - an assistant entry whose prompt was read in an earlier run (the reply was still being
 *   written), and summaries: on their own.
 * Reading from a source's lineNumber to its endLine gives that source again, unchanged: the
 * archive never changes the lines it holds.
 */
export function chunkSources(fileKey: string, fromLine: number, toLine: number): ChunkSource[] {
  const entries: Array<{ entry: TranscriptEntry; lineNumber: number }> = [];
  for (const parsed of readTranscript(fileKey, { includeTypes: ['user', 'assistant', 'summary'], fromLine, toLine })) {
    entries.push(parsed);
  }

  const sources: ChunkSource[] = [];
  const single = (at: { entry: TranscriptEntry; lineNumber: number }, role: ChunkSource['role'], text: string, hasAssistant = false) => {
    sources.push({ ...at, endLine: at.lineNumber, role, text, userEnd: 0, hasAssistant, firstPartOnly: role === 'tool_result' });
  };

  let i = 0;
  while (i < entries.length) {
    const current = entries[i];
    const { entry } = current;

    if (entry.type === 'summary') {
      const text = extractText(entry);
      if (text.trim()) single(current, 'summary', text);
      i++;
      continue;
    }

    if (entry.type === 'user' && isToolResultEntry(entry)) {
      const text = extractText(entry);
      if (text.trim()) single(current, 'tool_result', `TOOL RESULT: ${text}`);
      i++;
      continue;
    }

    if (entry.type === 'user') {
      const userPart = `USER: ${extractText(entry)}`;
      const replies: string[] = [];
      let endLine = current.lineNumber;
      // Sources inside the reply (tool results, summaries) come after the turn they belong to
      const inside: ChunkSource[] = [];
      i++;
      // The reply: every assistant entry until the user writes again (tool results in between are chunks of their own)
      while (i < entries.length) {
        const next = entries[i];
        if (next.entry.type === 'assistant') {
          const text = extractText(next.entry);
          if (text.trim()) replies.push(text);
        } else if (next.entry.type === 'user' && isToolResultEntry(next.entry)) {
          const text = extractText(next.entry);
          if (text.trim()) inside.push({ ...next, endLine: next.lineNumber, role: 'tool_result', text: `TOOL RESULT: ${text}`, userEnd: 0, hasAssistant: false, firstPartOnly: true });
        } else if (next.entry.type === 'summary') {
          const text = extractText(next.entry);
          if (text.trim()) inside.push({ ...next, endLine: next.lineNumber, role: 'summary', text, userEnd: 0, hasAssistant: false, firstPartOnly: false });
        } else {
          break; // the user writes again: next turn
        }
        endLine = next.lineNumber;
        i++;
      }
      const text = replies.length > 0 ? `${userPart}\nASSISTANT: ${replies.join('\n')}` : userPart;
      if (text.trim() !== 'USER:') {
        sources.push({ ...current, endLine, role: 'turn', text, userEnd: userPart.length, hasAssistant: replies.length > 0, firstPartOnly: false });
      }
      sources.push(...inside);
      continue;
    }

    // Assistant entry whose prompt was chunked in an earlier run
    const text = extractText(entry);
    if (text.trim()) single(current, 'assistant', `ASSISTANT: ${text}`, true);
    i++;
  }
  return sources;
}

/** The parts of a source to embed. */
export function sourceParts(source: ChunkSource): Array<{ start: number; end: number }> {
  const parts = windows(source.text);
  return source.firstPartOnly ? parts.slice(0, 1) : parts;
}

/**
 * Turn the new lines of an archived transcript into chunks to embed, each text in as many parts
 * as its length needs (see chunkSources). The chunks carry their text for embedding; the database
 * keeps where it is in the archive. Returns the chunks and the last line read (the archive's line
 * count when the read started).
 */
export function chunkTranscript(file: ArchivedFileRow, fromLine: number): { chunks: NewChunk[]; lastLine: number } {
  const toLine = file.line_count;
  const sources = chunkSources(file.file_key, fromLine, toLine);

  const chunks: NewChunk[] = [];
  for (const source of sources) {
    sourceParts(source).forEach(({ start, end }, part) => {
      chunks.push({
        session_id: file.session_id,
        project_dir: file.project_dir,
        entry_uuid: source.entry.uuid,
        role: source.role,
        content_text: source.text.slice(start, end),
        timestamp: source.entry.timestamp,
        line_number: source.lineNumber,
        part,
        end_line: source.endLine,
        text_start: start,
        text_end: end,
        text_format: CHUNK_TEXT_FORMAT,
        hasUser: start < source.userEnd,
        hasAssistant: source.hasAssistant && end > source.userEnd,
      });
    });
  }

  logger.debug(`Chunked ${file.file_key} from line ${fromLine}: ${sources.length} texts -> ${chunks.length} chunks`);
  return { chunks, lastLine: toLine };
}
