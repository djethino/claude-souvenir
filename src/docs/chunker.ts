import { readFileSync } from 'fs';
import { extname } from 'path';
import { EMBED_WINDOW_CHARS, WINDOW_OVERLAP_CHARS, windows } from '../embedding/chunker.js';
import type { DocCategory } from './store.js';

export interface DocChunk {
  file_path: string;
  category: DocCategory;
  /** The lines of the chunk (stored: shown in results) */
  content_text: string;
  /** What is embedded: the chunk's location, then its lines (not stored) */
  embed_text: string;
  start_line: number;
  end_line: number;
  /** Part of a line too long for one chunk (0 otherwise): its parts share the line */
  part: number;
  section_path: string | null;
}

export interface DocSection {
  file_path: string;
  heading: string;
  level: number;
  start_line: number;
  end_line: number | null;
  section_path: string;
}

// ---------------------------------------------------------------------------
// Category detection by extension
// ---------------------------------------------------------------------------

const CATEGORY_MAP: Record<string, DocCategory> = {
  // doc
  '.md': 'doc', '.txt': 'doc', '.rst': 'doc', '.adoc': 'doc',
  // code
  '.ts': 'code', '.tsx': 'code', '.js': 'code', '.jsx': 'code',
  '.mjs': 'code', '.cjs': 'code',
  '.py': 'code', '.go': 'code', '.rs': 'code', '.java': 'code',
  '.cs': 'code', '.c': 'code', '.cpp': 'code', '.h': 'code', '.hpp': 'code',
  '.rb': 'code', '.php': 'code', '.swift': 'code', '.kt': 'code',
  '.lua': 'code', '.sh': 'code', '.bash': 'code', '.ps1': 'code', '.bat': 'code',
  '.vue': 'code', '.svelte': 'code',
  '.css': 'code', '.scss': 'code', '.less': 'code',
  '.html': 'code', '.xml': 'code',
  '.sql': 'code', '.graphql': 'code', '.gql': 'code',
  '.gd': 'code', '.gdshader': 'code',
  // config
  '.json': 'config', '.yaml': 'config', '.yml': 'config',
  '.toml': 'config', '.ini': 'config',
  '.editorconfig': 'config',
};

/**
 * Detect category from file extension.
 * Returns null if the extension is unknown.
 */
export function detectCategory(filePath: string): DocCategory | null {
  const ext = extname(filePath).toLowerCase();
  return CATEGORY_MAP[ext] ?? null;
}

/**
 * Check if a file extension is supported for indexing.
 */
export function isSupportedExtension(filePath: string): boolean {
  return detectCategory(filePath) !== null;
}

// ---------------------------------------------------------------------------
// Splitting a block of lines into chunks
// ---------------------------------------------------------------------------

/** Where a chunk is, written before its lines in the embedded text. */
type Location = (startLine: number, endLine: number) => string;

/**
 * Cut lines [first, first + lines.length) of a file into chunks whose embedded text (location +
 * lines) fits one embedding window, so that every line is embedded: nothing is truncated.
 * A chunk ends at a blank line when one is near its end; consecutive chunks share up to
 * WINDOW_OVERLAP_CHARS of lines; a line too long for one chunk is cut into parts.
 */
function blockChunks(
  lines: string[],
  first: number,
  base: { file_path: string; category: DocCategory; section_path: string | null },
  location: Location,
): DocChunk[] {
  const last = first + lines.length - 1;
  // Room left for the lines once the longest location is written (at least half a window)
  const budget = Math.max(EMBED_WINDOW_CHARS - location(last, last).length - 1, EMBED_WINDOW_CHARS / 2);
  const chunks: DocChunk[] = [];
  const push = (text: string, startLine: number, endLine: number, part: number) => {
    if (!text.trim()) return;
    chunks.push({ ...base, content_text: text, embed_text: `${location(startLine, endLine)}\n${text}`, start_line: startLine, end_line: endLine, part });
  };

  let start = 0;
  while (start < lines.length) {
    if (lines[start].length > budget) {
      const line = lines[start];
      windows(line, budget).forEach(({ start: s, end: e }, part) => push(line.slice(s, e), first + start, first + start, part));
      start++;
      continue;
    }

    // As many lines as fit
    let end = start;
    let length = -1;
    while (end < lines.length && lines[end].length <= budget && length + 1 + lines[end].length <= budget) {
      length += 1 + lines[end].length;
      end++;
    }
    // End after a blank line when one is in the last 30% of the chunk
    if (end < lines.length) {
      let upTo = length;
      for (let k = end - 1; k > start; k--) {
        upTo -= 1 + lines[k].length;
        if (upTo < budget * 0.7) break;
        if (lines[k - 1].trim() === '') {
          end = k;
          break;
        }
      }
    }
    push(lines.slice(start, end).join('\n'), first + start, first + end - 1, 0);
    if (end >= lines.length) break;

    // The next chunk starts with the last lines of this one (not before a line cut into parts)
    let next = end;
    if (lines[end].length <= budget) {
      let shared = 0;
      while (next - 1 > start && shared + lines[next - 1].length + 1 <= WINDOW_OVERLAP_CHARS) {
        next--;
        shared += lines[next].length + 1;
      }
    }
    start = next;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Markdown chunking (by headers)
// ---------------------------------------------------------------------------

interface ParsedHeader {
  level: number;
  text: string;
  lineIndex: number; // 0-based
}

function parseMarkdownHeaders(lines: string[]): ParsedHeader[] {
  const headers: ParsedHeader[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();

    // Toggle code blocks
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // ATX headers: # H1, ## H2, etc.
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headers.push({
        level: match[1].length,
        text: match[2].replace(/\s+#+\s*$/, '').trim(), // Remove trailing # markers
        lineIndex: i,
      });
    }
  }

  return headers;
}

function buildSectionPath(headers: ParsedHeader[], currentIndex: number): string {
  const current = headers[currentIndex];
  const parts: string[] = [];

  // Walk backwards to find ancestor headers (lower level numbers)
  let targetLevel = current.level - 1;
  for (let i = currentIndex - 1; i >= 0 && targetLevel >= 1; i--) {
    if (headers[i].level === targetLevel) {
      parts.unshift(`${'#'.repeat(headers[i].level)} ${headers[i].text}`);
      targetLevel--;
    }
  }

  parts.push(`${'#'.repeat(current.level)} ${current.text}`);
  return parts.join(' > ');
}

function chunkMarkdown(
  lines: string[],
  relativePath: string,
): { chunks: DocChunk[]; sections: DocSection[] } {
  const headers = parseMarkdownHeaders(lines);
  const chunks: DocChunk[] = [];
  const sections: DocSection[] = [];
  const inFile: Location = () => `[${relativePath}]`;

  // Text before the first header (the whole file when it has none)
  const preEnd = headers.length > 0 ? headers[0].lineIndex : lines.length;
  if (preEnd > 0) {
    chunks.push(...blockChunks(lines.slice(0, preEnd), 1, { file_path: relativePath, category: 'doc', section_path: null }, inFile));
  }

  // Process each header section
  for (let hi = 0; hi < headers.length; hi++) {
    const header = headers[hi];
    const startLine = header.lineIndex; // 0-based
    const endLine = hi + 1 < headers.length ? headers[hi + 1].lineIndex : lines.length;
    const sectionPath = buildSectionPath(headers, hi);

    // Register section for navigation
    sections.push({
      file_path: relativePath,
      heading: header.text,
      level: header.level,
      start_line: startLine + 1, // 1-based for user display
      end_line: endLine < lines.length ? endLine : null,
      section_path: sectionPath,
    });

    chunks.push(...blockChunks(
      lines.slice(startLine, endLine),
      startLine + 1,
      { file_path: relativePath, category: 'doc', section_path: sectionPath },
      () => `[${sectionPath}]`,
    ));
  }

  return { chunks, sections };
}

// ---------------------------------------------------------------------------
// Code and config chunking (by lines, preferring blank lines as boundaries)
// ---------------------------------------------------------------------------

function chunkCode(
  lines: string[],
  relativePath: string,
): { chunks: DocChunk[]; sections: DocSection[] } {
  const chunks = blockChunks(lines, 1, { file_path: relativePath, category: 'code', section_path: null },
    (start, end) => `[${relativePath}:${start}-${end}]`);
  return { chunks, sections: [] };
}

function chunkConfig(
  lines: string[],
  relativePath: string,
): { chunks: DocChunk[]; sections: DocSection[] } {
  const chunks = blockChunks(lines, 1, { file_path: relativePath, category: 'config', section_path: null },
    () => `[config: ${relativePath}]`);
  return { chunks, sections: [] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Chunk a file into pieces for embedding.
 * Reads the file content and splits based on category (doc/code/config).
 *
 * @param filePath - Absolute path to the file
 * @param relativePath - Path relative to project root (stored in DB)
 * @param category - File category (auto-detected if not provided)
 */
export function chunkFile(
  filePath: string,
  relativePath: string,
  category?: DocCategory,
): { chunks: DocChunk[]; sections: DocSection[] } {
  const resolvedCategory = category || detectCategory(filePath);
  if (!resolvedCategory) {
    return { chunks: [], sections: [] };
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  switch (resolvedCategory) {
    case 'doc':
      return chunkMarkdown(lines, relativePath);
    case 'code':
      return chunkCode(lines, relativePath);
    case 'config':
      return chunkConfig(lines, relativePath);
    default:
      return { chunks: [], sections: [] };
  }
}
