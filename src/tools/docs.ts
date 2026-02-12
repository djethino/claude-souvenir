import { existsSync, statSync } from 'fs';
import { resolve, relative } from 'path';
import { getConfig } from '../config.js';
import { getOrCreateProvider } from './helpers.js';
import { logger } from '../utils/logger.js';
import type { DocCategory } from '../docs/store.js';
import {
  addDocSource,
  removeDocSource,
  getDocSources,
  getDocsIndexStatus,
  getDocIndexState,
  clearAllDocs,
  clearDocFile,
  docsDbExists,
  getDocsDb,
  getDocSections,
} from '../docs/store.js';
import { buildDocsIndex, resolveSourceFiles } from '../docs/indexer.js';
import { detectCategory } from '../docs/chunker.js';

export async function handleSouvenirDocs(params: {
  action: 'add' | 'remove' | 'list' | 'status' | 'build' | 'clear' | 'sections';
  path?: string;
  pattern?: string;
  category?: DocCategory;
  source_id?: number;
  rebuild?: boolean;
}): Promise<string> {
  const config = getConfig();
  const projectRoot = config.cwd;

  if (!projectRoot) {
    return 'Error: Could not determine project root directory.';
  }

  switch (params.action) {
    case 'add':
      return handleAdd(projectRoot, params);
    case 'remove':
      return handleRemove(projectRoot, params);
    case 'list':
      return handleList(projectRoot);
    case 'status':
      return handleStatus(projectRoot);
    case 'build':
      return handleBuild(projectRoot, config, params.rebuild ?? false);
    case 'clear':
      return handleClear(projectRoot);
    case 'sections':
      return handleSections(projectRoot, params);
    default:
      return `Unknown action: "${params.action}". Use "add", "remove", "list", "status", "build", "clear", or "sections".`;
  }
}

// ---------------------------------------------------------------------------
// Add source
// ---------------------------------------------------------------------------

async function handleAdd(
  projectRoot: string,
  params: { path?: string; pattern?: string; category?: DocCategory },
): Promise<string> {
  if (!params.path) {
    return 'Error: "path" parameter is required for "add" action. Provide a file or directory path (relative to project root).';
  }

  const absolutePath = resolve(projectRoot, params.path);
  const relativePath = relative(projectRoot, absolutePath).replace(/\\/g, '/');

  if (!existsSync(absolutePath)) {
    return `Error: Path "${params.path}" does not exist (resolved to ${absolutePath}).`;
  }

  const stat = statSync(absolutePath);
  const type = stat.isDirectory() ? 'directory' : 'file';

  // Validate category for files
  if (type === 'file' && !params.category) {
    const detected = detectCategory(absolutePath);
    if (!detected) {
      return `Error: Could not auto-detect category for "${params.path}". ` +
        'Specify the "category" parameter ("doc", "code", or "config").';
    }
  }

  try {
    const source = addDocSource(
      projectRoot,
      relativePath,
      type as 'file' | 'directory',
      params.pattern,
      params.category,
    );

    // Show what would be indexed
    const files = resolveSourceFiles(projectRoot);
    const fromThis = files.filter((f) =>
      type === 'file'
        ? f.relativePath === relativePath
        : f.relativePath.startsWith(relativePath + '/'),
    );

    const lines = [
      `Added ${type} source: ${relativePath}`,
      `  Source ID: ${source.source_id}`,
    ];

    if (params.pattern) {
      lines.push(`  Pattern: ${params.pattern}`);
    }
    if (params.category) {
      lines.push(`  Category: ${params.category}`);
    } else if (type === 'file') {
      lines.push(`  Category: ${detectCategory(absolutePath)} (auto-detected)`);
    }

    if (type === 'directory') {
      const catCounts = new Map<string, number>();
      for (const f of fromThis) {
        catCounts.set(f.category, (catCounts.get(f.category) || 0) + 1);
      }
      lines.push(`  Files found: ${fromThis.length}`);
      for (const [cat, count] of catCounts) {
        lines.push(`    ${cat}: ${count}`);
      }
    }

    lines.push('');
    lines.push('Run souvenir_docs action="build" to index the new content.');

    return lines.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint')) {
      return `Error: Source "${relativePath}" is already tracked. Use "list" to see all sources.`;
    }
    return `Error adding source: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Remove source
// ---------------------------------------------------------------------------

async function handleRemove(
  projectRoot: string,
  params: { source_id?: number; path?: string },
): Promise<string> {
  if (!params.source_id && !params.path) {
    return 'Error: "source_id" or "path" parameter is required for "remove" action. Use "list" to see source IDs.';
  }

  if (params.source_id) {
    const removed = removeDocSource(projectRoot, params.source_id);
    if (!removed) {
      return `Error: Source ID ${params.source_id} not found. Use "list" to see all sources.`;
    }
    return `Removed source ID ${params.source_id}. Existing indexed chunks remain until you run "build" with rebuild or "clear".`;
  }

  // Remove by path
  const sources = getDocSources(projectRoot);
  const relativePath = relative(projectRoot, resolve(projectRoot, params.path!)).replace(/\\/g, '/');
  const match = sources.find((s) => s.path === relativePath);

  if (!match) {
    return `Error: No source found matching path "${params.path}". Use "list" to see all sources.`;
  }

  removeDocSource(projectRoot, match.source_id);
  return `Removed source "${match.path}" (ID ${match.source_id}). Existing indexed chunks remain until you run "build" with rebuild or "clear".`;
}

// ---------------------------------------------------------------------------
// List sources
// ---------------------------------------------------------------------------

async function handleList(projectRoot: string): Promise<string> {
  if (!docsDbExists(projectRoot)) {
    return 'No docs database found. Use souvenir_docs action="add" to start tracking files.';
  }

  const sources = getDocSources(projectRoot);

  if (sources.length === 0) {
    return 'No sources configured. Use souvenir_docs action="add" path="<file_or_dir>" to add files to index.';
  }

  const lines = [`Tracked sources (${sources.length}):\n`];

  for (const s of sources) {
    const catLabel = s.category ? ` [${s.category}]` : ' [auto-detect]';
    const patternLabel = s.pattern ? ` (pattern: ${s.pattern})` : '';
    lines.push(`  ${s.source_id}. [${s.type}] ${s.path}${catLabel}${patternLabel}`);
    lines.push(`     Added: ${s.added_at.slice(0, 19)}`);
  }

  // Show resolved file count
  const files = resolveSourceFiles(projectRoot);
  lines.push('');
  lines.push(`Total files resolved: ${files.length}`);
  const catCounts = new Map<string, number>();
  for (const f of files) {
    catCounts.set(f.category, (catCounts.get(f.category) || 0) + 1);
  }
  for (const [cat, count] of catCounts) {
    lines.push(`  ${cat}: ${count}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function handleStatus(projectRoot: string): Promise<string> {
  if (!docsDbExists(projectRoot)) {
    return 'No docs database found for this project. Use souvenir_docs action="add" to start tracking files.';
  }

  const status = getDocsIndexStatus(projectRoot);
  const lines = ['Docs Index Status:\n'];

  lines.push(`  Chunks indexed: ${status.totalChunks}`);
  lines.push(`  Files indexed: ${status.totalFiles}`);
  lines.push(`  Markdown sections: ${status.totalSections}`);

  if (status.categories.length > 0) {
    lines.push('');
    lines.push('  By category:');
    for (const c of status.categories) {
      lines.push(`    ${c.category}: ${c.chunkCount} chunks`);
    }
  }

  const dbSizeKb = (status.dbSizeBytes / 1024).toFixed(1);
  lines.push(`\n  Database size: ${dbSizeKb} KB`);

  if (status.sources.length > 0) {
    lines.push(`\n  Sources: ${status.sources.length}`);
    for (const s of status.sources) {
      lines.push(`    - [${s.type}] ${s.path}${s.pattern ? ` (${s.pattern})` : ''}`);
    }
  } else {
    lines.push('\n  No sources configured.');
  }

  // Check for pending changes
  const files = resolveSourceFiles(projectRoot);
  let pendingCount = 0;
  for (const f of files) {
    try {
      const stat = statSync(f.absolutePath);
      const indexState = getDocIndexState(projectRoot, f.relativePath);
      if (!indexState || indexState.file_size !== stat.size || indexState.file_mtime !== stat.mtime.toISOString()) {
        pendingCount++;
      }
    } catch { /* skip */ }
  }

  if (pendingCount > 0) {
    lines.push(`\n  Pending: ${pendingCount} file(s) need (re-)indexing. Run souvenir_docs action="build".`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function handleBuild(
  projectRoot: string,
  config: ReturnType<typeof getConfig>,
  rebuild: boolean,
): Promise<string> {
  const sources = docsDbExists(projectRoot) ? getDocSources(projectRoot) : [];

  if (sources.length === 0 && !docsDbExists(projectRoot)) {
    return 'No sources configured. Use souvenir_docs action="add" to track files first.';
  }

  if (sources.length === 0) {
    // DB exists but no sources — might have been cleared
    getDocsDb(projectRoot);
    const dbSources = getDocSources(projectRoot);
    if (dbSources.length === 0) {
      return 'No sources configured. Use souvenir_docs action="add" to track files first.';
    }
  }

  const provider = getOrCreateProvider(config);

  try {
    const result = await buildDocsIndex(projectRoot, provider, { rebuild });

    const lines = [
      `Docs indexing ${rebuild ? '(rebuild) ' : ''}complete!`,
      `  Chunks processed: ${result.totalChunks}`,
      `  Chunks embedded: ${result.totalEmbedded}`,
      `  Files processed: ${result.filesProcessed}`,
      `  Files skipped (unchanged): ${result.skipped}`,
    ];

    if (result.errors.length > 0) {
      lines.push('');
      lines.push(`  Errors (${result.errors.length}):`);
      for (const err of result.errors) {
        lines.push(`    - ${err}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    return `Docs indexing error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

async function handleClear(projectRoot: string): Promise<string> {
  if (!docsDbExists(projectRoot)) {
    return 'No docs database found. Nothing to clear.';
  }

  clearAllDocs(projectRoot);
  return 'All docs index data cleared (chunks, sections, index state). Sources are preserved. Run "build" to re-index.';
}

// ---------------------------------------------------------------------------
// Sections (markdown TOC navigation)
// ---------------------------------------------------------------------------

async function handleSections(
  projectRoot: string,
  params: { path?: string },
): Promise<string> {
  if (!params.path) {
    return 'Error: "path" parameter is required for "sections" action. Provide a markdown file path.';
  }

  if (!docsDbExists(projectRoot)) {
    return 'No docs database found. Index the file first with souvenir_docs action="add" then action="build".';
  }

  const relativePath = relative(projectRoot, resolve(projectRoot, params.path)).replace(/\\/g, '/');
  const sections = getDocSections(projectRoot, relativePath);

  if (sections.length === 0) {
    return `No sections found for "${relativePath}". The file may not be indexed or may not contain markdown headers. Run souvenir_docs action="build" if needed.`;
  }

  const lines = [`Sections for ${relativePath} (${sections.length} headers):\n`];

  for (const s of sections) {
    const indent = '  '.repeat(s.level - 1);
    const lineRange = s.end_line
      ? `L${s.start_line}-${s.end_line}`
      : `L${s.start_line}+`;
    lines.push(`${indent}${'#'.repeat(s.level)} ${s.heading}  [${lineRange}]`);
  }

  lines.push('');
  lines.push('Use the Read tool with file_path and offset/limit to navigate to a specific section.');

  return lines.join('\n');
}
