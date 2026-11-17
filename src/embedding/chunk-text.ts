import { findArchivedFiles } from '../archive/store.js';
import type { ChunkRow, TextChunkRow } from '../db/store.js';
import { CHUNK_TEXT_FORMAT, chunkSources, type ChunkSource } from './chunker.js';

/** Raised when a chunk's text cannot be re-made from the archive as it was embedded. */
export class ChunkTextError extends Error {}

/**
 * Give chunks their text. A chunk of an archived transcript keeps none in the database: it is
 * re-made here from the archive, by the code that cut it (chunker.ts), from the lines it records.
 * Chunks with kept text (partial sessions, chunks made before) are returned as they are.
 * Parts of one exchange share one reading of the archive.
 *
 * Throws ChunkTextError when a chunk cannot be re-made as it was embedded: cut by another chunker
 * format, transcript no longer archived, or a text that does not match the recorded position.
 */
export function withChunkText<T extends ChunkRow>(chunks: T[]): Array<T & TextChunkRow> {
  const sources = new Map<string, ChunkSource[]>();
  return chunks.map((chunk) => {
    if (chunk.content_text !== null) return chunk as T & TextChunkRow;
    return { ...chunk, content_text: rebuildText(chunk, sources) };
  });
}

function rebuildText(chunk: ChunkRow, cache: Map<string, ChunkSource[]>): string {
  const rebuildHint = `rebuild the index of this project (souvenir_index action="rebuild" project="${chunk.project_dir}")`;
  if (chunk.text_format !== CHUNK_TEXT_FORMAT) {
    throw new ChunkTextError(`A chunk of session ${chunk.session_id} was cut by another version of souvenir (format ${chunk.text_format}, now ${CHUNK_TEXT_FORMAT}): ${rebuildHint}.`);
  }
  if (chunk.line_number === null || chunk.end_line === null || chunk.text_start === null || chunk.text_end === null) {
    throw new ChunkTextError(`A chunk of session ${chunk.session_id} records no position in the archive: ${rebuildHint}.`);
  }
  const file = findArchivedFiles(chunk.session_id, chunk.project_dir)[0];
  if (!file) {
    throw new ChunkTextError(`Session ${chunk.session_id} is indexed but not archived in ${chunk.project_dir}: ${rebuildHint}.`);
  }

  const key = `${file.file_key}\0${chunk.line_number}\0${chunk.end_line}`;
  let sources = cache.get(key);
  if (!sources) {
    sources = chunkSources(file.file_key, chunk.line_number, chunk.end_line);
    cache.set(key, sources);
  }
  const source = sources.find((s) => s.lineNumber === chunk.line_number && s.role === chunk.role);
  if (!source || chunk.text_end > source.text.length) {
    throw new ChunkTextError(`The text of a chunk of session ${chunk.session_id} (line ${chunk.line_number}) no longer matches the archive: ${rebuildHint}.`);
  }
  return source.text.slice(chunk.text_start, chunk.text_end);
}
