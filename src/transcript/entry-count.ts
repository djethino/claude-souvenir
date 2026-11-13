import { closeSync, openSync, readSync, statSync } from 'fs';
import { DEFAULT_ENTRY_TYPES, SKIPPED_LINE_MARKER } from './parser.js';

/**
 * Number of entries in a transcript, as souvenir_read pages through them: valid JSON lines of type
 * user, assistant or summary (file-history-snapshot lines skipped), the same filter as parseTranscript.
 *
 * Transcripts only grow at the end, and the longest reach hundreds of MB: each file is counted once,
 * then only from where the previous count stopped. A file that got smaller was rewritten and is
 * counted again from the start.
 */
export function countTranscriptEntries(filePath: string): number {
  const size = statSync(filePath).size;
  let state = counts.get(filePath);
  if (!state || size < state.offset) {
    state = { offset: 0, complete: 0, pending: Buffer.alloc(0) };
    counts.set(filePath, state);
  }

  if (size > state.offset) {
    const fd = openSync(filePath, 'r');
    try {
      const chunk = Buffer.alloc(CHUNK_SIZE);
      while (state.offset < size) {
        const read = readSync(fd, chunk, 0, Math.min(CHUNK_SIZE, size - state.offset), state.offset);
        if (read === 0) break;
        state.offset += read;
        let data = state.pending.length ? Buffer.concat([state.pending, chunk.subarray(0, read)]) : chunk.subarray(0, read);
        let start = 0;
        for (let nl = data.indexOf(NEWLINE, start); nl !== -1; nl = data.indexOf(NEWLINE, start)) {
          if (isEntry(data.toString('utf8', start, nl))) state.complete++;
          start = nl + 1;
        }
        data = data.subarray(start);
        state.pending = Buffer.from(data); // copy: chunk is reused on the next read
      }
    } finally {
      closeSync(fd);
    }
  }

  // A last line without its newline yet counts if it is already a whole entry (as parseTranscript reads it)
  return state.complete + (state.pending.length && isEntry(state.pending.toString('utf8')) ? 1 : 0);
}

const CHUNK_SIZE = 1024 * 1024;
const NEWLINE = 0x0a;
const COUNTED_TYPES = new Set(DEFAULT_ENTRY_TYPES);

interface CountState {
  /** Bytes of the file already read */
  offset: number;
  /** Entries among the complete lines read */
  complete: number;
  /** Bytes after the last newline read */
  pending: Buffer;
}

const counts = new Map<string, CountState>();

function isEntry(line: string): boolean {
  if (!line.trim() || line.includes(SKIPPED_LINE_MARKER)) return false;
  try {
    return COUNTED_TYPES.has((JSON.parse(line) as { type?: string }).type ?? '');
  } catch {
    return false; // corrupt line, skipped by parseTranscript too
  }
}
