import { statSync, readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { chunkFile, detectCategory, isSupportedExtension } from './chunker.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { DocCategory } from './store.js';
import {
  getDocsDb,
  getDocSources,
  getDocIndexState,
  setDocIndexState,
  insertDocChunks,
  insertDocSections,
  clearDocFile,
  clearAllDocs,
  getDocsStoredProvider,
  setDocsStoredProvider,
  insertSnapshot,
  cleanupOldSnapshots,
} from './store.js';

const EMBED_BATCH_SIZE = 32;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB — only skip truly abusive files (dumps, generated data)

export interface DocsIndexProgress {
  phase: string;
  current: number;
  total: number;
  detail?: string;
}

// ---------------------------------------------------------------------------
// File resolution from sources
// ---------------------------------------------------------------------------

/** Default directories/files to skip during recursive scan. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '__pycache__', '.venv', 'venv', '.claude',
  '.godot', '.import', 'addons',
]);

/** Hidden directories (starting with .) that should still be scanned. */
const VISIBLE_DOT_DIRS = new Set([
  '.claude-plugin', '.github', '.vscode', '.husky',
  '.circleci', '.devcontainer', '.docker',
]);

const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);

/**
 * Recursively list files in a directory, respecting skip lists and optional pattern.
 */
function listFilesRecursive(
  dirPath: string,
  pattern: string | null,
  recursive: boolean,
): string[] {
  const results: string[] = [];

  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (!recursive) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && !VISIBLE_DOT_DIRS.has(entry.name)) continue;
      results.push(...listFilesRecursive(fullPath, pattern, recursive));
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;

      // Pattern matching: simple glob like "*.md" or "*.{ts,js}"
      if (pattern) {
        if (!matchSimplePattern(entry.name, pattern)) continue;
      }

      // Only include files with supported extensions
      if (isSupportedExtension(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/**
 * Simple pattern matching: supports "*.ext" and "*.{ext1,ext2}" patterns.
 */
function matchSimplePattern(filename: string, pattern: string): boolean {
  // Handle *.{ext1,ext2} pattern
  const braceMatch = pattern.match(/^\*\.\{(.+)\}$/);
  if (braceMatch) {
    const extensions = braceMatch[1].split(',').map((e) => `.${e.trim()}`);
    return extensions.some((ext) => filename.endsWith(ext));
  }

  // Handle *.ext pattern
  const starMatch = pattern.match(/^\*(\..+)$/);
  if (starMatch) {
    return filename.endsWith(starMatch[1]);
  }

  // Handle exact filename match
  return filename === pattern;
}

/**
 * Resolve all files to index from configured sources.
 */
export function resolveSourceFiles(
  projectRoot: string,
): Array<{ absolutePath: string; relativePath: string; category: DocCategory }> {
  const sources = getDocSources(projectRoot);
  const fileSet = new Map<string, { absolutePath: string; relativePath: string; category: DocCategory }>();

  for (const source of sources) {
    const absoluteSource = resolve(projectRoot, source.path);

    if (source.type === 'file') {
      if (!isSupportedExtension(absoluteSource)) continue;
      const cat = source.category || detectCategory(absoluteSource);
      if (!cat) continue;

      const rel = relative(projectRoot, absoluteSource).replace(/\\/g, '/');
      fileSet.set(rel, { absolutePath: absoluteSource, relativePath: rel, category: cat });
    } else {
      // Directory source
      const files = listFilesRecursive(absoluteSource, source.pattern, source.recursive !== 0);
      for (const filePath of files) {
        const cat = source.category || detectCategory(filePath);
        if (!cat) continue;

        const rel = relative(projectRoot, filePath).replace(/\\/g, '/');
        if (!fileSet.has(rel)) {
          fileSet.set(rel, { absolutePath: filePath, relativePath: rel, category: cat });
        }
      }
    }
  }

  return [...fileSet.values()];
}

// ---------------------------------------------------------------------------
// Build index
// ---------------------------------------------------------------------------

/**
 * Build the docs semantic index for a project.
 * Scans configured sources, detects changes, chunks, and embeds.
 */
export async function buildDocsIndex(
  projectRoot: string,
  provider: EmbeddingProvider,
  options: {
    rebuild?: boolean;
    onProgress?: (progress: DocsIndexProgress) => void;
  } = {},
): Promise<{
  totalChunks: number;
  totalEmbedded: number;
  filesProcessed: number;
  skipped: number;
  errors: string[];
}> {
  const { rebuild = false, onProgress } = options;

  // Initialize database
  getDocsDb(projectRoot, provider.dimensions);

  // Check for provider mismatch
  const storedProvider = getDocsStoredProvider(projectRoot);
  if (storedProvider && !rebuild) {
    if (storedProvider.dimensions !== provider.dimensions) {
      throw new Error(
        `Embedding dimensions mismatch: docs index was built with ${storedProvider.dimensions}d ` +
        `but current provider uses ${provider.dimensions}d. Rebuild the docs index.`,
      );
    }
  }

  // Initialize embedding provider
  if (!provider.isReady()) {
    onProgress?.({ phase: 'Initializing embedding model', current: 0, total: 1 });
    await provider.initialize();
  }

  // Handle rebuild
  if (rebuild) {
    logger.info('Rebuilding docs index from scratch...');
    clearAllDocs(projectRoot);
  }

  // Store provider info
  setDocsStoredProvider(projectRoot, provider.name, provider.dimensions);

  // Resolve all files from sources
  const files = resolveSourceFiles(projectRoot);
  const totalFiles = files.length;

  onProgress?.({ phase: 'Scanning sources', current: 0, total: totalFiles });

  let totalChunks = 0;
  let totalEmbedded = 0;
  let filesProcessed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let fi = 0; fi < files.length; fi++) {
    const { absolutePath, relativePath, category } = files[fi];

    onProgress?.({
      phase: 'Indexing docs',
      current: fi + 1,
      total: totalFiles,
      detail: relativePath,
    });

    try {
      const stat = statSync(absolutePath);

      // Skip files that are too large (avoids memory issues + noise)
      if (stat.size > MAX_FILE_SIZE) {
        skipped++;
        continue;
      }

      const fileMtime = stat.mtime.toISOString();

      // Check if file needs re-indexing
      if (!rebuild) {
        const indexState = getDocIndexState(projectRoot, relativePath);
        if (indexState && indexState.file_size === stat.size && indexState.file_mtime === fileMtime) {
          skipped++;
          continue;
        }
      }

      // Snapshot file content before re-indexing (versioning)
      try {
        const content = readFileSync(absolutePath, 'utf-8');
        const contentHash = createHash('sha256').update(content).digest('hex');
        insertSnapshot(projectRoot, relativePath, content, contentHash, stat.size);
      } catch (snapErr) {
        logger.error(`Snapshot error for ${relativePath}:`, snapErr);
      }

      // Clear previous data for this file (re-index)
      clearDocFile(projectRoot, relativePath);

      // Chunk the file
      const { chunks, sections } = chunkFile(absolutePath, relativePath, category);

      if (chunks.length === 0) {
        setDocIndexState(projectRoot, relativePath, stat.size, fileMtime);
        skipped++;
        continue;
      }

      totalChunks += chunks.length;

      // Insert sections (no embedding needed)
      if (sections.length > 0) {
        insertDocSections(projectRoot, sections);
      }

      // Embed in batches
      const chunkData = chunks.map((c) => ({
        ...c,
        file_modified: fileMtime,
      }));

      for (let i = 0; i < chunkData.length; i += EMBED_BATCH_SIZE) {
        const batch = chunkData.slice(i, i + EMBED_BATCH_SIZE);
        const texts = batch.map((c) => c.embed_text);

        const embeddings = await provider.embed(texts);
        const inserted = insertDocChunks(projectRoot, batch, embeddings);
        totalEmbedded += inserted;
      }

      // Update index state
      setDocIndexState(projectRoot, relativePath, stat.size, fileMtime);
      filesProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Error processing doc ${relativePath}:`, msg);
      if (errors.length < 5) {
        errors.push(`${relativePath}: ${msg.slice(0, 200)}`);
      }
    }
  }

  // Cleanup old snapshots (3-day TTL)
  try {
    const cleaned = cleanupOldSnapshots(projectRoot, 3);
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} old snapshot(s)`);
    }
  } catch (cleanErr) {
    logger.error('Snapshot cleanup error:', cleanErr);
  }

  logger.info(
    `Docs indexing complete: ${totalChunks} chunks, ${totalEmbedded} embedded, ` +
    `${filesProcessed} files, ${skipped} skipped`,
  );

  return { totalChunks, totalEmbedded, filesProcessed, skipped, errors };
}
