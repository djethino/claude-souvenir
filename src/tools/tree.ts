/**
 * souvenir_tree — Display project directory tree with smart defaults.
 *
 * Skips common noise directories (node_modules, .git, build, etc.)
 * and formats output with standard ASCII tree connectors.
 *
 * Extra features beyond standard `tree`:
 * - show_lines: line count per file (find the "meaty" files)
 * - show_modified: relative modification time (what changed recently)
 * - stats: extension breakdown summary (understand the stack at a glance)
 * - max_files: cap output to prevent context flooding on large repos
 */

import { readdirSync, statSync } from 'fs';
import { join, resolve, extname } from 'path';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';

// ── Skip lists ───────────────────────────────────────────────────────────────

/** Directories always skipped (noise/generated/cache) */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.tox',
  '.claude',
  '.godot', '.import',
  'coverage', '.nyc_output', '.cache',
]);

/** Hidden directories (starting with .) that should still be shown */
const VISIBLE_DOT_DIRS = new Set([
  '.claude-plugin', '.github', '.vscode', '.husky',
  '.circleci', '.devcontainer', '.docker',
]);

// ── Pattern matching ─────────────────────────────────────────────────────────

function matchPattern(filename: string, pattern: string): boolean {
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

  // Exact filename match
  return filename === pattern;
}

// ── Line counting ────────────────────────────────────────────────────────────

/** Count lines in a file efficiently (streaming, no full load) */
function countLines(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    let count = 0;
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });
    rl.on('line', () => { count++; });
    rl.on('close', () => resolve(count));
    rl.on('error', () => resolve(0));
  });
}

// ── Time formatting ──────────────────────────────────────────────────────────

function formatRelativeTime(mtimeMs: number): string {
  const diffMs = Date.now() - mtimeMs;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

// ── Tree entry ───────────────────────────────────────────────────────────────

interface TreeEntry {
  name: string;
  isDir: boolean;
  /** Full path on disk (for line counting / stat) */
  fullPath: string;
  /** Tracks whether each ancestor level is the last child (for connector drawing) */
  prefixParts: boolean[];
  /** Line count (populated if show_lines is true) */
  lineCount?: number;
  /** Modification time in ms (populated if show_modified is true) */
  mtimeMs?: number;
  /** File extension (for stats) */
  ext?: string;
}

// ── Walker ───────────────────────────────────────────────────────────────────

function shouldSkipDir(name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  if (name.startsWith('.') && !VISIBLE_DOT_DIRS.has(name)) return true;
  return false;
}

interface WalkOptions {
  maxDepth: number;
  pattern: string | null;
  dirsOnly: boolean;
  showModified: boolean;
}

interface WalkResult {
  entries: TreeEntry[];
  dirCount: number;
  fileCount: number;
}

/**
 * Walk the directory tree and collect entries for display.
 * Sorted: directories first (alphabetical), then files (alphabetical).
 * When a pattern is active, directories with no matching descendants are pruned.
 */
function walkTree(
  dir: string,
  currentDepth: number,
  opts: WalkOptions,
  parentPrefixes: boolean[],
): WalkResult {
  let entries: TreeEntry[] = [];
  let dirCount = 0;
  let fileCount = 0;

  let items: { name: string; isDir: boolean }[];
  try {
    const dirents = readdirSync(dir, { withFileTypes: true });
    items = dirents
      .filter((d) => d.isFile() || d.isDirectory())
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch {
    return { entries, dirCount, fileCount };
  }

  // Sort: directories first (alphabetical), then files (alphabetical)
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Filter out skipped directories
  items = items.filter((item) => !(item.isDir && shouldSkipDir(item.name)));

  // Filter files by pattern if provided
  if (opts.pattern && !opts.dirsOnly) {
    items = items.filter((item) => item.isDir || matchPattern(item.name, opts.pattern!));
  }

  // If dirsOnly, filter out all files
  if (opts.dirsOnly) {
    items = items.filter((item) => item.isDir);
  }

  // Process each item
  const total = items.length;
  for (let i = 0; i < total; i++) {
    const item = items[i];
    const isLast = i === total - 1;
    const prefixParts = [...parentPrefixes, isLast];
    const fullPath = join(dir, item.name);

    if (item.isDir) {
      if (currentDepth < opts.maxDepth) {
        const sub = walkTree(fullPath, currentDepth + 1, opts, prefixParts);

        // Prune empty directories when pattern is active
        if (opts.pattern && !opts.dirsOnly && sub.entries.length === 0 && sub.fileCount === 0) {
          continue;
        }

        dirCount += 1 + sub.dirCount;
        fileCount += sub.fileCount;
        entries.push({ name: item.name + '/', isDir: true, fullPath, prefixParts });
        entries.push(...sub.entries);
      } else {
        dirCount += 1;
        entries.push({ name: item.name + '/', isDir: true, fullPath, prefixParts });
      }
    } else {
      fileCount += 1;
      const entry: TreeEntry = { name: item.name, isDir: false, fullPath, prefixParts };
      entry.ext = extname(item.name).toLowerCase() || '(no ext)';

      // Collect mtime if needed (stat is cheap)
      if (opts.showModified) {
        try {
          entry.mtimeMs = statSync(fullPath).mtimeMs;
        } catch { /* ignore */ }
      }

      entries.push(entry);
    }
  }

  // Recalculate isLast flags at this level after potential pruning
  const depth = parentPrefixes.length;
  let foundLast = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].prefixParts.length === depth + 1) {
      if (!foundLast) {
        entries[i].prefixParts[depth] = true;
        foundLast = true;
      } else {
        entries[i].prefixParts[depth] = false;
      }
    }
  }

  return { entries, dirCount, fileCount };
}

// ── Line count population ────────────────────────────────────────────────────

/** Populate line counts for all file entries (async, parallel batches) */
async function populateLineCounts(entries: TreeEntry[]): Promise<void> {
  const fileEntries = entries.filter((e) => !e.isDir);
  // Process in batches of 50 to avoid too many open file handles
  const BATCH = 50;
  for (let i = 0; i < fileEntries.length; i += BATCH) {
    const batch = fileEntries.slice(i, i + BATCH);
    const counts = await Promise.all(batch.map((e) => countLines(e.fullPath)));
    for (let j = 0; j < batch.length; j++) {
      batch[j].lineCount = counts[j];
    }
  }
}

// ── Stats computation ────────────────────────────────────────────────────────

interface ExtStats {
  ext: string;
  count: number;
  totalLines: number;
}

function computeStats(entries: TreeEntry[]): ExtStats[] {
  const map = new Map<string, { count: number; totalLines: number }>();
  for (const entry of entries) {
    if (entry.isDir || !entry.ext) continue;
    const existing = map.get(entry.ext);
    if (existing) {
      existing.count++;
      existing.totalLines += entry.lineCount ?? 0;
    } else {
      map.set(entry.ext, { count: 1, totalLines: entry.lineCount ?? 0 });
    }
  }

  return [...map.entries()]
    .map(([ext, data]) => ({ ext, ...data }))
    .sort((a, b) => b.count - a.count);
}

// ── Formatter ────────────────────────────────────────────────────────────────

interface FormatOptions {
  pattern: string | null;
  dirCount: number;
  fileCount: number;
  showLines: boolean;
  showModified: boolean;
  showStats: boolean;
  truncatedCount: number;
}

function formatTree(
  entries: TreeEntry[],
  rootPath: string,
  opts: FormatOptions,
): string {
  const lines: string[] = [rootPath];

  for (const entry of entries) {
    // Build tree connector prefix
    let prefix = '';
    for (let d = 0; d < entry.prefixParts.length - 1; d++) {
      prefix += entry.prefixParts[d] ? '    ' : '\u2502   ';
    }
    const isLast = entry.prefixParts[entry.prefixParts.length - 1];
    prefix += isLast ? '\u2514\u2500\u2500 ' : '\u251C\u2500\u2500 ';

    // Build suffix annotations
    const suffixes: string[] = [];
    if (!entry.isDir && opts.showLines && entry.lineCount !== undefined) {
      suffixes.push(`${entry.lineCount}L`);
    }
    if (!entry.isDir && opts.showModified && entry.mtimeMs !== undefined) {
      suffixes.push(formatRelativeTime(entry.mtimeMs));
    }

    const suffix = suffixes.length > 0 ? '  (' + suffixes.join(', ') + ')' : '';
    lines.push(prefix + entry.name + suffix);
  }

  // Summary footer
  lines.push('');
  const footerParts: string[] = [];
  footerParts.push(`${opts.dirCount} ${opts.dirCount === 1 ? 'directory' : 'directories'}`);
  footerParts.push(`${opts.fileCount} ${opts.fileCount === 1 ? 'file' : 'files'}`);
  let footer = footerParts.join(', ');
  if (opts.pattern) {
    footer += ` (filtered by ${opts.pattern})`;
  }
  if (opts.truncatedCount > 0) {
    footer += ` — truncated, ${opts.truncatedCount} more files not shown`;
  }
  lines.push(footer);

  // Extension stats
  if (opts.showStats) {
    const stats = computeStats(entries);
    if (stats.length > 0) {
      lines.push('');
      lines.push('Extensions:');
      for (const s of stats) {
        const lineInfo = s.totalLines > 0 ? `, ${s.totalLines} lines` : '';
        lines.push(`  ${s.ext.padEnd(12)} ${String(s.count).padStart(4)} files${lineInfo}`);
      }
    }
  }

  return lines.join('\n');
}

// ── Truncation ───────────────────────────────────────────────────────────────

/**
 * Truncate entries to max_files, keeping directory structure intact.
 * Counts only files (not directories) toward the limit.
 */
function truncateEntries(
  entries: TreeEntry[],
  maxFiles: number,
): { entries: TreeEntry[]; truncatedCount: number; totalFiles: number } {
  let filesSeen = 0;
  let totalFiles = 0;
  const kept: TreeEntry[] = [];
  // Track which directory prefix depths are still open
  const activeDirDepths = new Set<number>();

  for (const entry of entries) {
    if (!entry.isDir) totalFiles++;
  }

  for (const entry of entries) {
    if (entry.isDir) {
      // Always include directories (they provide structure context)
      kept.push(entry);
    } else {
      filesSeen++;
      if (filesSeen <= maxFiles) {
        kept.push(entry);
      }
    }
  }

  const truncatedCount = totalFiles > maxFiles ? totalFiles - maxFiles : 0;
  return { entries: kept, truncatedCount, totalFiles };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function handleSouvenirTree(params: {
  path?: string;
  depth?: number;
  pattern?: string;
  directories_only?: boolean;
  show_lines?: boolean;
  show_modified?: boolean;
  stats?: boolean;
  max_files?: number;
}): Promise<string> {
  const config = getConfig();
  const projectRoot = config.cwd;

  if (!projectRoot) {
    return 'Error: Could not detect current project directory.';
  }

  const maxDepth = Math.min(Math.max(params.depth ?? 3, 1), 10);
  const pattern = params.pattern ?? null;
  const dirsOnly = params.directories_only ?? false;
  const showLines = params.show_lines ?? false;
  const showModified = params.show_modified ?? false;
  const showStats = params.stats ?? false;
  const maxFiles = params.max_files ?? 0; // 0 = no limit

  // Resolve target directory
  const targetDir = params.path
    ? resolve(projectRoot, params.path)
    : projectRoot;

  // Verify it's within the project
  if (!targetDir.startsWith(projectRoot) && targetDir !== projectRoot) {
    return `Error: Path "${params.path}" resolves outside the project root.`;
  }

  // Check directory exists
  try {
    readdirSync(targetDir);
  } catch {
    return `Error: Directory not found: ${params.path || projectRoot}`;
  }

  logger.info(`souvenir_tree: ${targetDir} (depth=${maxDepth}, pattern=${pattern}, dirsOnly=${dirsOnly})`);

  const walkOpts: WalkOptions = {
    maxDepth,
    pattern,
    dirsOnly,
    showModified,
  };

  let { entries, dirCount, fileCount } = walkTree(targetDir, 1, walkOpts, []);

  // Populate line counts if requested (async I/O)
  if (showLines && !dirsOnly) {
    await populateLineCounts(entries);
  }

  // Truncate if max_files is set
  let truncatedCount = 0;
  if (maxFiles > 0 && !dirsOnly) {
    const result = truncateEntries(entries, maxFiles);
    entries = result.entries;
    truncatedCount = result.truncatedCount;
  }

  return formatTree(entries, targetDir, {
    pattern,
    dirCount,
    fileCount,
    showLines,
    showModified,
    showStats,
    truncatedCount,
  });
}
