/**
 * souvenir_tree — Display project directory tree with smart defaults.
 *
 * Skips common noise directories (node_modules, .git, build, etc.)
 * and formats output with standard ASCII tree connectors.
 */

import { readdirSync } from 'fs';
import { join, resolve } from 'path';
import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';

// ── Skip lists ───────────────────────────────────────────────────────────────

/** Directories always skipped (noise/generated/cache) */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.tox',
  '.souvenir', '.claude',
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

// ── Tree entry ───────────────────────────────────────────────────────────────

interface TreeEntry {
  name: string;
  isDir: boolean;
  /** Tracks whether each ancestor level is the last child (for connector drawing) */
  prefixParts: boolean[];
}

// ── Walker ───────────────────────────────────────────────────────────────────

function shouldSkipDir(name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  // Hidden dirs not in the whitelist
  if (name.startsWith('.') && !VISIBLE_DOT_DIRS.has(name)) return true;
  return false;
}

/**
 * Walk the directory tree and collect entries for display.
 * Returns entries in display order (depth-first, sorted: directories first, then files, both alphabetical).
 * When a pattern is active, directories with no matching descendants are pruned.
 */
function walkTree(
  dir: string,
  currentDepth: number,
  maxDepth: number,
  pattern: string | null,
  dirsOnly: boolean,
  parentPrefixes: boolean[],
): { entries: TreeEntry[]; dirCount: number; fileCount: number } {
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
  if (pattern && !dirsOnly) {
    items = items.filter((item) => item.isDir || matchPattern(item.name, pattern));
  }

  // If dirsOnly, filter out all files
  if (dirsOnly) {
    items = items.filter((item) => item.isDir);
  }

  // Process each item
  const total = items.length;
  for (let i = 0; i < total; i++) {
    const item = items[i];
    const isLast = i === total - 1;
    const prefixParts = [...parentPrefixes, isLast];

    if (item.isDir) {
      // Recurse into subdirectory if depth allows
      if (currentDepth < maxDepth) {
        const sub = walkTree(
          join(dir, item.name),
          currentDepth + 1,
          maxDepth,
          pattern,
          dirsOnly,
          prefixParts,
        );

        // If pattern is active, prune empty directories (no matching files in subtree)
        if (pattern && !dirsOnly && sub.entries.length === 0 && sub.fileCount === 0) {
          continue;
        }

        dirCount += 1 + sub.dirCount;
        fileCount += sub.fileCount;
        entries.push({ name: item.name + '/', isDir: true, prefixParts });
        entries.push(...sub.entries);
      } else {
        // At max depth — show directory name only
        dirCount += 1;
        entries.push({ name: item.name + '/', isDir: true, prefixParts });
      }
    } else {
      fileCount += 1;
      entries.push({ name: item.name, isDir: false, prefixParts });
    }
  }

  // After filtering/pruning, recalculate isLast flags at this level
  // (items may have been removed by pattern pruning)
  let levelIdx = 0;
  const depth = parentPrefixes.length;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].prefixParts.length === depth + 1) {
      levelIdx = i;
    }
  }
  // Mark the actual last top-level entry
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].prefixParts.length === depth + 1) {
      entries[i].prefixParts[depth] = true;
      break;
    }
  }
  // Ensure non-last entries are not marked as last
  let foundLast = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].prefixParts.length === depth + 1) {
      if (!foundLast) {
        foundLast = true;
      } else {
        entries[i].prefixParts[depth] = false;
      }
    }
  }

  return { entries, dirCount, fileCount };
}

// ── Formatter ────────────────────────────────────────────────────────────────

function formatTree(
  entries: TreeEntry[],
  rootPath: string,
  pattern: string | null,
  dirCount: number,
  fileCount: number,
): string {
  const lines: string[] = [rootPath];

  for (const entry of entries) {
    let prefix = '';
    for (let d = 0; d < entry.prefixParts.length - 1; d++) {
      prefix += entry.prefixParts[d] ? '    ' : '\u2502   ';
    }
    const isLast = entry.prefixParts[entry.prefixParts.length - 1];
    prefix += isLast ? '\u2514\u2500\u2500 ' : '\u251C\u2500\u2500 ';
    lines.push(prefix + entry.name);
  }

  // Footer
  lines.push('');
  const parts: string[] = [];
  parts.push(`${dirCount} ${dirCount === 1 ? 'directory' : 'directories'}`);
  parts.push(`${fileCount} ${fileCount === 1 ? 'file' : 'files'}`);
  let footer = parts.join(', ');
  if (pattern) {
    footer += ` (filtered by ${pattern})`;
  }
  lines.push(footer);

  return lines.join('\n');
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function handleSouvenirTree(params: {
  path?: string;
  depth?: number;
  pattern?: string;
  directories_only?: boolean;
}): Promise<string> {
  const config = getConfig();
  const projectRoot = config.cwd;

  if (!projectRoot) {
    return 'Error: Could not detect current project directory.';
  }

  const maxDepth = Math.min(Math.max(params.depth ?? 3, 1), 10);
  const pattern = params.pattern ?? null;
  const dirsOnly = params.directories_only ?? false;

  // Resolve target directory
  const targetDir = params.path
    ? resolve(projectRoot, params.path)
    : projectRoot;

  // Verify it's within the project
  if (!targetDir.startsWith(projectRoot)) {
    return `Error: Path "${params.path}" resolves outside the project root.`;
  }

  // Check directory exists
  try {
    readdirSync(targetDir);
  } catch {
    return `Error: Directory not found: ${params.path || projectRoot}`;
  }

  logger.info(`souvenir_tree: ${targetDir} (depth=${maxDepth}, pattern=${pattern}, dirsOnly=${dirsOnly})`);

  const { entries, dirCount, fileCount } = walkTree(
    targetDir,
    1,
    maxDepth,
    pattern,
    dirsOnly,
    [],
  );

  return formatTree(entries, targetDir, pattern, dirCount, fileCount);
}
