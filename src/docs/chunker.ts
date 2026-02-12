import { readFileSync } from 'fs';
import { extname } from 'path';
import type { DocCategory } from './store.js';

export interface DocChunk {
  file_path: string;
  category: DocCategory;
  content_text: string;
  embed_text: string;
  start_line: number;
  end_line: number;
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
// Chunking constants
// ---------------------------------------------------------------------------

const MAX_EMBED_CHARS = 1600;
const MAX_CONTENT_CHARS = 2000;
const MAX_CHUNK_LINES = 80;
const MIN_CHUNK_LINES = 5;

function truncateForEmbed(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > maxChars * 0.7 ? truncated.slice(0, lastSpace) : truncated;
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

  if (headers.length === 0) {
    // No headers: treat as a single chunk
    const content = lines.join('\n');
    if (content.trim()) {
      chunks.push({
        file_path: relativePath,
        category: 'doc',
        content_text: truncateForEmbed(content, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(`[${relativePath}]\n${content}`, MAX_EMBED_CHARS),
        start_line: 1,
        end_line: lines.length,
        section_path: null,
      });
    }
    return { chunks, sections };
  }

  // Content before first header (if any)
  if (headers[0].lineIndex > 0) {
    const preContent = lines.slice(0, headers[0].lineIndex).join('\n');
    if (preContent.trim()) {
      chunks.push({
        file_path: relativePath,
        category: 'doc',
        content_text: truncateForEmbed(preContent, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(`[${relativePath}]\n${preContent}`, MAX_EMBED_CHARS),
        start_line: 1,
        end_line: headers[0].lineIndex,
        section_path: null,
      });
    }
  }

  // Process each header section
  for (let hi = 0; hi < headers.length; hi++) {
    const header = headers[hi];
    const startLine = header.lineIndex; // 0-based
    const endLine = hi + 1 < headers.length ? headers[hi + 1].lineIndex : lines.length;
    const sectionLines = lines.slice(startLine, endLine);
    const sectionContent = sectionLines.join('\n');
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

    if (!sectionContent.trim()) continue;

    // If section is too long, split at paragraph boundaries
    if (sectionContent.length > MAX_CONTENT_CHARS) {
      const subChunks = splitAtParagraphs(sectionLines, startLine, relativePath, 'doc', sectionPath);
      chunks.push(...subChunks);
    } else {
      chunks.push({
        file_path: relativePath,
        category: 'doc',
        content_text: truncateForEmbed(sectionContent, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(`[${sectionPath}]\n${sectionContent}`, MAX_EMBED_CHARS),
        start_line: startLine + 1,
        end_line: endLine,
        section_path: sectionPath,
      });
    }
  }

  return { chunks, sections };
}

// ---------------------------------------------------------------------------
// Code chunking (by blank line boundaries)
// ---------------------------------------------------------------------------

function chunkCode(
  lines: string[],
  relativePath: string,
): { chunks: DocChunk[]; sections: DocSection[] } {
  const chunks: DocChunk[] = [];

  if (lines.length <= MAX_CHUNK_LINES) {
    // Small file: single chunk
    const content = lines.join('\n');
    if (content.trim()) {
      chunks.push({
        file_path: relativePath,
        category: 'code',
        content_text: truncateForEmbed(content, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(`[${relativePath}]\n${content}`, MAX_EMBED_CHARS),
        start_line: 1,
        end_line: lines.length,
        section_path: null,
      });
    }
    return { chunks, sections: [] };
  }

  // Find blank line positions (good split points)
  const splitPoints: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      splitPoints.push(i);
    }
  }

  // Group lines into chunks of ~MAX_CHUNK_LINES, splitting at blank lines
  let chunkStart = 0;

  while (chunkStart < lines.length) {
    let chunkEnd = Math.min(chunkStart + MAX_CHUNK_LINES, lines.length);

    // Try to find a blank line near the target end to split cleanly
    if (chunkEnd < lines.length) {
      const nearestBlank = splitPoints.find(
        (p) => p >= chunkStart + MIN_CHUNK_LINES && p <= chunkEnd,
      );
      // Prefer the last blank line in the range
      const candidates = splitPoints.filter(
        (p) => p >= chunkStart + MIN_CHUNK_LINES && p <= chunkEnd,
      );
      if (candidates.length > 0) {
        chunkEnd = candidates[candidates.length - 1] + 1;
      }
    }

    const chunkLines = lines.slice(chunkStart, chunkEnd);
    const content = chunkLines.join('\n');

    if (content.trim()) {
      chunks.push({
        file_path: relativePath,
        category: 'code',
        content_text: truncateForEmbed(content, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(`[${relativePath}:${chunkStart + 1}-${chunkEnd}]\n${content}`, MAX_EMBED_CHARS),
        start_line: chunkStart + 1,
        end_line: chunkEnd,
        section_path: null,
      });
    }

    chunkStart = chunkEnd;
  }

  return { chunks, sections: [] };
}

// ---------------------------------------------------------------------------
// Config chunking (single chunk or split by sections)
// ---------------------------------------------------------------------------

function chunkConfig(
  lines: string[],
  relativePath: string,
): { chunks: DocChunk[]; sections: DocSection[] } {
  const content = lines.join('\n');
  const chunks: DocChunk[] = [];

  if (!content.trim()) return { chunks, sections: [] };

  if (content.length <= MAX_CONTENT_CHARS) {
    // Small config: single chunk
    chunks.push({
      file_path: relativePath,
      category: 'config',
      content_text: truncateForEmbed(content, MAX_CONTENT_CHARS),
      embed_text: truncateForEmbed(`[config: ${relativePath}]\n${content}`, MAX_EMBED_CHARS),
      start_line: 1,
      end_line: lines.length,
      section_path: null,
    });
  } else {
    // Large config: split at blank lines like code
    const codeResult = chunkCode(lines, relativePath);
    for (const chunk of codeResult.chunks) {
      chunk.category = 'config';
    }
    chunks.push(...codeResult.chunks);
  }

  return { chunks, sections: [] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitAtParagraphs(
  lines: string[],
  baseLineIndex: number,
  relativePath: string,
  category: DocCategory,
  sectionPath: string | null,
): DocChunk[] {
  const chunks: DocChunk[] = [];
  let blockStart = 0;
  let currentBlock: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    currentBlock.push(lines[i]);
    const blockContent = currentBlock.join('\n');

    // Split when block is large enough and we hit a blank line
    if (blockContent.length >= MAX_CONTENT_CHARS * 0.8 && lines[i].trim() === '') {
      if (blockContent.trim()) {
        chunks.push({
          file_path: relativePath,
          category,
          content_text: truncateForEmbed(blockContent, MAX_CONTENT_CHARS),
          embed_text: truncateForEmbed(
            sectionPath ? `[${sectionPath}]\n${blockContent}` : `[${relativePath}]\n${blockContent}`,
            MAX_EMBED_CHARS,
          ),
          start_line: baseLineIndex + blockStart + 1,
          end_line: baseLineIndex + i + 1,
          section_path: sectionPath,
        });
      }
      blockStart = i + 1;
      currentBlock = [];
    }
  }

  // Remaining content
  if (currentBlock.length > 0) {
    const remaining = currentBlock.join('\n');
    if (remaining.trim()) {
      chunks.push({
        file_path: relativePath,
        category,
        content_text: truncateForEmbed(remaining, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(
          sectionPath ? `[${sectionPath}]\n${remaining}` : `[${relativePath}]\n${remaining}`,
          MAX_EMBED_CHARS,
        ),
        start_line: baseLineIndex + blockStart + 1,
        end_line: baseLineIndex + lines.length,
        section_path: sectionPath,
      });
    }
  }

  return chunks;
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
