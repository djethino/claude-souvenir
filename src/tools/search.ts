import { textSearch } from '../search/text-search.js';
import { formatSearchResult } from '../transcript/formatter.js';
import { listProjectDirs, getSessionMetadata, resolveCurrentSession } from '../transcript/discovery.js';
import { getConfig } from '../config.js';
import { resolveProjectDir } from '../utils/paths.js';
import { searchSemantic, getProjectChunkCount } from '../db/store.js';
import type { VecSearchResult } from '../db/store.js';
import { getOrCreateProvider, errorMessage } from './helpers.js';
import { buildIndex } from '../db/indexer.js';
import { logger } from '../utils/logger.js';
import { applySessionDensityBoost } from '../search/density-boost.js';
import type { SearchResult } from '../transcript/types.js';
import { searchDocsSemantic, docsDbExists, getDocsChunkCount } from '../docs/store.js';
import type { DocCategory, DocVecSearchResult } from '../docs/store.js';
import type { ToolContext } from './helpers.js';
import { createProgressNotifier } from './helpers.js';

/**
 * Number of results for a header: "N", or "N+" when more may exist beyond those fetched.
 */
function resultCount(total: number, more: boolean): string {
  return more ? `${total}+` : `${total}`;
}

/**
 * Pagination footer. `more`: results may exist beyond the `total` fetched (semantic searches fetch
 * only what the page needs plus one), so the next page is offered even when this one ends the list.
 * `nextScore`, the score of the first result of the next page, tells whether it is worth reading:
 * close to this page's scores, keep going; far below, the rest is weaker matches.
 */
function pageFooter(endIndex: number, maxResults: number, total: number, more: boolean, nextScore?: number): string {
  if (endIndex >= total && !more) return `\n--- All ${total} results shown ---`;
  const page = more
    ? `Page ${Math.ceil(endIndex / maxResults)}`
    : `Page ${Math.ceil(endIndex / maxResults)}/${Math.ceil(total / maxResults)}`;
  const remaining = endIndex < total ? `${total - endIndex}${more ? '+' : ''} more results` : 'more results';
  const best = nextScore !== undefined ? ` (best score: ${nextScore.toFixed(2)})` : '';
  return `\n--- ${page} | ${remaining}${best} | Next page: offset=${endIndex} ---`;
}

/**
 * Index new messages before a semantic search. Returns a note for the answer when the index may
 * lack recent messages: the search still runs on what is indexed, but Claude must know the
 * results can be incomplete instead of taking them as everything there is.
 */
async function indexBeforeSemanticSearch(
  provider: ReturnType<typeof getOrCreateProvider>,
  projectDirs: string[],
  ctx: ToolContext | undefined,
): Promise<string | null> {
  if (projectDirs.length !== 1) {
    // Several projects: indexing them all here could take minutes; the background index only covers the current one
    return 'Note: across several projects, only messages already indexed are searched: recent sessions of other projects may be missing (souvenir_index action="build" project="all" indexes them; text mode reads the transcripts directly).';
  }
  try {
    const result = await buildIndex(provider, projectDirs, { rebuild: false, onProgress: createProgressNotifier(ctx) });
    if (result.errors.length === 0) return null;
    const count = result.errors.length >= 5 ? '5 or more' : String(result.errors.length); // buildIndex keeps the first 5
    return `Note: ${count} transcript(s) could not be indexed, so their newest messages may be missing from semantic results (first error: ${result.errors[0]}). Text mode reads the transcripts directly.`;
  } catch (err) {
    logger.warn('Indexing before search failed:', err);
    return `Note: indexing new messages failed (${errorMessage(err)}), so the latest messages may be missing from semantic results. Text mode reads the transcripts directly.`;
  }
}

/** Note for text matches when some transcripts could not be read (their matches are missing). */
function unreadableNote(unreadable: string[]): string | null {
  if (unreadable.length === 0) return null;
  return `Note: ${unreadable.length} transcript(s) could not be read, their matches are missing (${unreadable.slice(0, 3).join('; ')}${unreadable.length > 3 ? '; …' : ''}).`;
}

/** Session metadata for result lists, read once per session and search. */
function sessionMetadataLookup(): (sessionId: string, projectDir: string) => ReturnType<typeof getSessionMetadata> {
  const cache = new Map<string, ReturnType<typeof getSessionMetadata>>();
  return (sessionId, projectDir) => {
    if (!cache.has(sessionId)) cache.set(sessionId, getSessionMetadata(sessionId, projectDir));
    return cache.get(sessionId) ?? null;
  };
}

/**
 * Extract a smart snippet from content, trying to center on query words.
 * For semantic search where we don't have exact match positions.
 */
function extractSmartSnippet(content: string, query: string, maxLen: number = 250): string {
  const contentLower = content.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

  // Try to find the first significant query word in content
  let bestPos = -1;
  for (const word of words) {
    const pos = contentLower.indexOf(word);
    if (pos !== -1) {
      bestPos = pos;
      break;
    }
  }

  if (bestPos === -1) {
    // No match found, return start of content
    const snippet = content.slice(0, maxLen);
    return (snippet.length < content.length ? snippet + '...' : snippet).replace(/\n/g, ' ');
  }

  // Center the snippet on the match
  const halfLen = Math.floor(maxLen / 2);
  const start = Math.max(0, bestPos - halfLen);
  const end = Math.min(content.length, bestPos + halfLen);

  let snippet = content.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet.replace(/\n/g, ' ');
}

export type SearchSource = 'transcripts' | 'docs' | 'code' | 'config' | 'project' | 'all';

export async function handleSouvenirSearch(params: {
  query: string;
  mode?: 'text' | 'semantic' | 'hybrid';
  source?: SearchSource;
  project?: string;
  session_id?: string;
  role?: 'user' | 'assistant' | 'both';
  date_from?: string;
  date_to?: string;
  include_subagents?: boolean;
  max_results?: number;
  offset?: number;
  case_sensitive?: boolean;
  regex?: boolean;
}, ctx?: ToolContext): Promise<string> {
  const config = getConfig();
  const mode = params.mode || 'hybrid';
  const source = params.source || 'transcripts';

  // Sources that search in docs DB
  const searchDocs = source === 'docs' || source === 'code' || source === 'config' || source === 'project' || source === 'all';
  // Sources that search in transcripts DB
  const searchTranscripts = source === 'transcripts' || source === 'all';

  // For docs-only sources, delegate to docs search
  if (searchDocs && !searchTranscripts) {
    return await performDocsSearch(params, config, source, mode);
  }

  // Resolve "current" session_id
  if (params.session_id === 'current') {
    const projectDir = config.currentProject || undefined;
    const resolved = resolveCurrentSession(projectDir);
    if (!resolved) {
      return 'Error: Could not determine current session.';
    }
    params = { ...params, session_id: resolved };
  }

  // Resolve project dirs
  let projectDirs: string[];
  if (params.project === 'all') {
    projectDirs = listProjectDirs();
  } else if (params.project) {
    projectDirs = [resolveProjectDir(params.project)];
  } else if (config.currentProject) {
    projectDirs = [config.currentProject];
  } else {
    return 'Error: No project specified and could not detect current project. Use the "project" parameter or set "all" to search all projects.';
  }

  const maxResults = Math.min(params.max_results || 10, 50);

  let result: string;

  if (mode === 'text') {
    result = await performTextSearch(params, projectDirs, maxResults);
  } else if (mode === 'semantic') {
    result = await performSemanticSearch(params, projectDirs, maxResults, ctx);
  } else if (mode === 'hybrid') {
    result = await performHybridSearch(params, projectDirs, maxResults, ctx);
  } else {
    return `Unknown search mode: "${mode}". Use "text", "semantic", or "hybrid".`;
  }

  // Cross-reference hint: check docs DB for related content
  if (source === 'transcripts') {
    const docsHint = await getDocsXrefHint(params.query, config);
    if (docsHint) {
      result += `\n${docsHint}`;
    }
  }

  return result;
}

async function performTextSearch(
  params: {
    query: string;
    session_id?: string;
    role?: 'user' | 'assistant' | 'both';
    date_from?: string;
    date_to?: string;
    include_subagents?: boolean;
    max_results?: number;
    offset?: number;
    case_sensitive?: boolean;
    regex?: boolean;
  },
  projectDirs: string[],
  maxResults: number,
): Promise<string> {
  // Fetch all results (no pagination) so density boost can re-rank across sessions
  const result = await textSearch({
    query: params.query,
    projectDirs,
    sessionId: params.session_id,
    role: params.role || 'both',
    dateFrom: params.date_from,
    dateTo: params.date_to,
    includeSubagents: params.include_subagents ?? false,
    maxResults: Infinity,
    offset: 0,
    caseSensitive: params.case_sensitive ?? false,
    regex: params.regex ?? false,
  });

  const note = unreadableNote(result.unreadable);
  const noteBlock = note ? `${note}\n\n` : '';

  if (result.results.length === 0) {
    return `${noteBlock}No results found for "${params.query}" (searched ${result.filesSearched} files).`;
  }

  // Apply session density boost before pagination
  const { results: boostedResults, sessionHitCounts } = applySessionDensityBoost(result.results);

  const offset = params.offset || 0;
  const sliced = boostedResults.slice(offset, offset + maxResults);
  const total = boostedResults.length;
  const endIndex = offset + sliced.length;
  if (sliced.length === 0) return `${noteBlock}No results after offset ${offset} for "${params.query}" (${total} in all).`;

  const header = `${noteBlock}Found ${total} result(s) for "${params.query}" (showing ${offset + 1}-${endIndex}, searched ${result.filesSearched} files):\n`;

  const formatted = sliced.map((r, i) =>
    formatSearchResult(r, offset + i, sessionHitCounts.get(r.sessionId)),
  );

  let footer = pageFooter(endIndex, maxResults, total, false, boostedResults[endIndex]?.score);

  // Add semantic hint if index is available
  const hint = await getSemanticHint(params.query, projectDirs);
  if (hint) {
    footer += `\n${hint}`;
  }

  return header + '\n' + formatted.join('\n\n') + footer;
}

async function performSemanticSearch(
  params: {
    query: string;
    project?: string;
    session_id?: string;
    role?: 'user' | 'assistant' | 'both';
    date_from?: string;
    date_to?: string;
    max_results?: number;
    offset?: number;
  },
  projectDirs: string[],
  maxResults: number,
  ctx?: ToolContext,
): Promise<string> {
  const config = getConfig();

  // Get singleton provider and initialize
  const provider = getOrCreateProvider(config);
  try {
    if (!provider.isReady()) {
      await provider.initialize();
    }

    const indexNote = await indexBeforeSemanticSearch(provider, projectDirs, ctx);
    const noteBlock = indexNote ? `${indexNote}\n\n` : '';

    const queryEmbedding = await provider.embedQuery(params.query);

    // Search each project dir (use first one for single project filter)
    const projectDir = projectDirs.length === 1 ? projectDirs[0] : undefined;

    // One more than the page needs: if it comes back, a next page exists
    const offset = params.offset || 0;
    const topK = offset + maxResults + 1;
    const vecResults = searchSemantic(provider.identity, queryEmbedding, {
      topK,
      projectDir,
      sessionId: params.session_id,
      speaker: params.role === 'both' ? undefined : params.role,
      dateFrom: params.date_from,
      dateTo: params.date_to,
    });
    const more = vecResults.length === topK;

    if (vecResults.length === 0) {
      return `${noteBlock}No semantic results found for "${params.query}". The index may be empty for the specified project. Run souvenir_index with action="status" to check.`;
    }

    // Convert all results to SearchResult format (no pagination yet)
    const metadataOf = sessionMetadataLookup();
    const allResults: SearchResult[] = vecResults.map((vr) => {
      const meta = metadataOf(vr.session_id, vr.project_dir);
      return {
        sessionId: vr.session_id,
        projectDir: vr.project_dir,
        entryUuid: vr.entry_uuid || undefined,
        role: vr.role || 'turn',
        content: vr.content_text,
        snippet: extractSmartSnippet(vr.content_text, params.query),
        timestamp: vr.timestamp || undefined,
        lineNumber: vr.line_number || 0,
        score: 1 - vr.distance, // Convert cosine distance to similarity
        sessionSummary: meta?.entry.summary,
        sessionFirstPrompt: meta?.entry.firstPrompt,
      };
    });

    // Apply session density boost before pagination
    const { results: boostedResults, sessionHitCounts } = applySessionDensityBoost(allResults);

    const sliced = boostedResults.slice(offset, offset + maxResults);
    const total = boostedResults.length;
    const endIndex = offset + sliced.length;
    if (sliced.length === 0) return `${noteBlock}No semantic results after offset ${offset} for "${params.query}" (${total} in all).`;

    const header = `${noteBlock}Found ${resultCount(total, more)} semantic result(s) for "${params.query}" (showing ${offset + 1}-${endIndex}):\n`;
    const formatted = sliced.map((r, i) => formatSearchResult(r, offset + i, sessionHitCounts.get(r.sessionId)));

    return header + '\n' + formatted.join('\n\n') + pageFooter(endIndex, maxResults, total, more, boostedResults[endIndex]?.score);
  } catch (err) {
    return `Semantic search error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function performHybridSearch(
  params: {
    query: string;
    project?: string;
    session_id?: string;
    role?: 'user' | 'assistant' | 'both';
    date_from?: string;
    date_to?: string;
    include_subagents?: boolean;
    max_results?: number;
    offset?: number;
    case_sensitive?: boolean;
    regex?: boolean;
  },
  projectDirs: string[],
  maxResults: number,
  ctx?: ToolContext,
): Promise<string> {
  // Each half fetches enough candidates for the requested page (twice its depth, as the merge
  // re-ranks them): fetching from the top for page 1 only made every later page empty
  const offset = params.offset || 0;
  const depth = (offset + maxResults) * 2;

  // Run text and semantic search in parallel
  const textPromise = textSearch({
    query: params.query,
    projectDirs,
    sessionId: params.session_id,
    role: params.role || 'both',
    dateFrom: params.date_from,
    dateTo: params.date_to,
    includeSubagents: params.include_subagents ?? false,
    maxResults: depth,
    offset: 0,
    caseSensitive: params.case_sensitive ?? false,
    regex: params.regex ?? false,
  }).then(
    (result) => ({ ...result, error: null as string | null }),
    (err) => {
      logger.warn('Text search failed in hybrid mode:', err);
      return { results: [] as SearchResult[], totalMatches: 0, filesSearched: 0, unreadable: [] as string[], error: errorMessage(err) };
    },
  );

  const semanticPromise = (async () => {
    try {
      const config = getConfig();
      const provider = getOrCreateProvider(config);
      if (!provider.isReady()) {
        await provider.initialize();
      }

      const indexNote = await indexBeforeSemanticSearch(provider, projectDirs, ctx);

      const queryEmbedding = await provider.embedQuery(params.query);
      const projectDir = projectDirs.length === 1 ? projectDirs[0] : undefined;

      const results = searchSemantic(provider.identity, queryEmbedding, {
        topK: depth,
        projectDir,
        sessionId: params.session_id,
        speaker: params.role === 'both' ? undefined : params.role,
        dateFrom: params.date_from,
        dateTo: params.date_to,
      });

      return { results, error: null as string | null, indexNote };
    } catch (err) {
      logger.warn('Semantic search failed in hybrid mode:', err);
      return { results: [] as VecSearchResult[], error: errorMessage(err), indexNote: null };
    }
  })();

  const [textResult, semantic] = await Promise.all([textPromise, semanticPromise]);
  const vecResults = semantic.results;
  // Hybrid degrades to one side when the other fails, or searches an incomplete index: say so instead of hiding it
  const notices = [
    semantic.error && `Note: semantic search unavailable, showing text matches only (${semantic.error})`,
    textResult.error && `Note: text search failed, showing semantic matches only (${textResult.error})`,
    unreadableNote(textResult.unreadable),
    semantic.indexNote,
  ].filter(Boolean).join('\n');
  const noticeBlock = notices ? `${notices}\n\n` : '';

  // Merge results
  const merged = new Map<string, SearchResult>();

  // Add text results
  for (const r of textResult.results) {
    const key = `${r.sessionId}:${r.lineNumber}`;
    merged.set(key, { ...r, score: r.score * 0.4 }); // Text weight: 0.4
  }

  // Add/merge semantic results
  const metadataOf = sessionMetadataLookup();
  for (const vr of vecResults) {
    const meta = metadataOf(vr.session_id, vr.project_dir);
    const key = `${vr.session_id}:${vr.line_number}`;
    const similarity = 1 - vr.distance;
    const semanticScore = similarity * 0.6; // Semantic weight: 0.6

    const existing = merged.get(key);
    if (existing) {
      // Found in both - combine scores
      existing.score += semanticScore;
    } else {
      merged.set(key, {
        sessionId: vr.session_id,
        projectDir: vr.project_dir,
        entryUuid: vr.entry_uuid || undefined,
        role: vr.role || 'turn',
        content: vr.content_text,
        snippet: extractSmartSnippet(vr.content_text, params.query),
        timestamp: vr.timestamp || undefined,
        lineNumber: vr.line_number || 0,
        score: semanticScore,
        sessionSummary: meta?.entry.summary,
        sessionFirstPrompt: meta?.entry.firstPrompt,
      });
    }
  }

  // Sort by combined score, then apply session density boost
  const allResults = [...merged.values()].sort((a, b) => b.score - a.score);
  const { results: boostedResults, sessionHitCounts } = applySessionDensityBoost(allResults);

  const sliced = boostedResults.slice(offset, offset + maxResults);
  const total = boostedResults.length;

  if (sliced.length === 0) {
    return total === 0
      ? `${noticeBlock}No results found for "${params.query}".`
      : `${noticeBlock}No hybrid results after offset ${offset} for "${params.query}" (${total} in all).`;
  }

  // Either half may hold candidates beyond the depth fetched
  const more = textResult.totalMatches > textResult.results.length || vecResults.length === depth;
  const endIndex = offset + sliced.length;

  const header = `${noticeBlock}Found ${resultCount(total, more)} hybrid result(s) for "${params.query}" (showing ${offset + 1}-${endIndex}):\n`;
  const formatted = sliced.map((r, i) => formatSearchResult(r, offset + i, sessionHitCounts.get(r.sessionId)));

  const footer = pageFooter(endIndex, maxResults, total, more, boostedResults[endIndex]?.score);

  return header + '\n' + formatted.join('\n\n') + footer;
}

/**
 * Generate a hint about semantic search availability for text search results.
 *
 * Two strategies depending on provider state:
 * - Provider loaded in memory: embed query + KNN count → "Hint: N+ semantic results (best: X.XX)"
 * - Provider not loaded: SQL COUNT on chunks → "Hint: Semantic index available (N chunks)"
 * - No DB: null (no hint)
 */
async function getSemanticHint(query: string, projectDirs: string[]): Promise<string | null> {
  try {
    // Check if there's an index at all before loading the provider
    const projectDir = projectDirs.length === 1 ? projectDirs[0] : undefined;
    if (projectDir) {
      const count = getProjectChunkCount(projectDir);
      if (count === 0) return null;
    }

    // Load provider (singleton — first call loads the model, subsequent calls are instant)
    const config = getConfig();
    const provider = getOrCreateProvider(config);
    if (!provider.isReady()) {
      await provider.initialize();
    }

    const queryEmbedding = await provider.embedQuery(query);
    const probeResults = searchSemantic(provider.identity, queryEmbedding, { topK: 5, projectDir });
    if (probeResults.length > 0) {
      const bestScore = (1 - probeResults[0].distance).toFixed(2);
      return `--- Hint: ${probeResults.length}+ semantic results available (best score: ${bestScore}). Use mode="semantic" or mode="hybrid" for meaning-based search. ---`;
    }

    return null;
  } catch {
    // Hint is non-critical — fail silently
    return null;
  }
}

// ---------------------------------------------------------------------------
// Docs search (source = docs/code/config/project)
// ---------------------------------------------------------------------------

function formatRelativeTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 0) return 'just now';
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return `${Math.floor(diffMs / (1000 * 60))}min ago`;
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatDocResult(
  result: DocVecSearchResult,
  index: number,
): string {
  const score = (1 - result.distance).toFixed(2);
  const modified = result.file_modified ? formatRelativeTime(result.file_modified) : '???';

  const lines = [
    `--- Result ${index + 1} (score: ${score}) ---`,
    `File: ${result.file_path} [${result.category}]`,
    `  Lines ${result.start_line}-${result.end_line} | Modified: ${modified}`,
  ];

  if (result.section_path) {
    lines.push(`  Section: ${result.section_path}`);
  }

  // Snippet: first 250 chars of content
  const snippet = result.content_text.length > 250
    ? result.content_text.slice(0, 250).replace(/\n/g, ' ') + '...'
    : result.content_text.replace(/\n/g, ' ');
  lines.push(`> ${snippet}`);

  return lines.join('\n');
}

async function performDocsSearch(
  params: {
    query: string;
    mode?: 'text' | 'semantic' | 'hybrid';
    source?: SearchSource;
    max_results?: number;
    offset?: number;
  },
  config: ReturnType<typeof getConfig>,
  source: SearchSource,
  mode: string,
): Promise<string> {
  const projectRoot = config.cwd;

  if (!docsDbExists(projectRoot)) {
    return 'No docs database found. Use souvenir_docs action="add" to track project files first.';
  }

  // Determine category filter
  let categoryFilter: DocCategory | undefined;
  if (source === 'docs') categoryFilter = 'doc';
  else if (source === 'code') categoryFilter = 'code';
  else if (source === 'config') categoryFilter = 'config';
  // 'project' = all categories in docs DB, no filter

  if (mode === 'text') {
    return 'Text search in docs is not yet supported. Use mode="semantic" or mode="hybrid" for docs search.';
  }

  // Semantic or hybrid search in docs
  const provider = getOrCreateProvider(config);
  if (!provider.isReady()) {
    await provider.initialize();
  }

  const queryEmbedding = await provider.embedQuery(params.query);
  const maxResults = Math.min(params.max_results || 10, 50);
  const offset = params.offset || 0;

  // One more than the page needs: if it comes back, a next page exists
  const topK = offset + maxResults + 1;
  const vecResults = searchDocsSemantic(projectRoot, provider.identity, queryEmbedding, {
    topK,
    category: categoryFilter,
  });
  const more = vecResults.length === topK;

  if (vecResults.length === 0) {
    const label = categoryFilter ? `${categoryFilter} files` : 'project files';
    return `No results found for "${params.query}" in ${label}. Check that files are indexed with souvenir_docs action="status".`;
  }

  const sliced = vecResults.slice(offset, offset + maxResults);
  const total = vecResults.length;
  const endIndex = offset + sliced.length;
  if (sliced.length === 0) return `No results after offset ${offset} for "${params.query}" (${total} in all).`;

  const sourceLabel = categoryFilter || 'project';
  const header = `Found ${resultCount(total, more)} result(s) in ${sourceLabel} files for "${params.query}" (showing ${offset + 1}-${endIndex}):\n`;
  const formatted = sliced.map((r, i) => formatDocResult(r, offset + i));

  const next = vecResults[endIndex];
  let footer = pageFooter(endIndex, maxResults, total, more, next && 1 - next.distance);

  // Cross-reference: check transcripts for related content
  const xrefHint = await getTranscriptsXrefHint(params.query, config);
  if (xrefHint) {
    footer += `\n${xrefHint}`;
  }

  return header + '\n' + formatted.join('\n\n') + footer;
}

// ---------------------------------------------------------------------------
// Cross-referencing hints
// ---------------------------------------------------------------------------

/**
 * Quick KNN probe in docs DB when searching transcripts.
 * Shows count + best score + most recent file modification.
 */
async function getDocsXrefHint(
  query: string,
  config: ReturnType<typeof getConfig>,
): Promise<string | null> {
  try {
    const projectRoot = config.cwd;
    if (!docsDbExists(projectRoot)) return null;

    const chunkCount = getDocsChunkCount(projectRoot);
    if (chunkCount === 0) return null;

    const provider = getOrCreateProvider(config);
    if (!provider.isReady()) {
      await provider.initialize();
    }

    const queryEmbedding = await provider.embedQuery(query);
    const probeResults = searchDocsSemantic(projectRoot, provider.identity, queryEmbedding, { topK: 5 });

    if (probeResults.length > 0) {
      const bestScore = (1 - probeResults[0].distance).toFixed(2);
      const bestFile = probeResults[0].file_path;
      const modified = probeResults[0].file_modified
        ? formatRelativeTime(probeResults[0].file_modified)
        : '';
      return `--- Docs hint: ${probeResults.length}+ results in project files (best: ${bestScore} in ${bestFile}${modified ? `, modified ${modified}` : ''}). Use source="project" to search docs/code. ---`;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Quick KNN probe in transcripts DB when searching docs.
 * Shows count + best score + recency.
 */
async function getTranscriptsXrefHint(
  query: string,
  config: ReturnType<typeof getConfig>,
): Promise<string | null> {
  try {
    const projectDir = config.currentProject;
    if (!projectDir) return null;

    const count = getProjectChunkCount(projectDir);
    if (count === 0) return null;

    const provider = getOrCreateProvider(config);
    if (!provider.isReady()) {
      await provider.initialize();
    }

    const queryEmbedding = await provider.embedQuery(query);
    const probeResults = searchSemantic(provider.identity, queryEmbedding, { topK: 5, projectDir });

    if (probeResults.length > 0) {
      const bestScore = (1 - probeResults[0].distance).toFixed(2);
      const ts = probeResults[0].timestamp
        ? formatRelativeTime(probeResults[0].timestamp)
        : '';
      return `--- Transcripts hint: ${probeResults.length}+ results in conversations (best: ${bestScore}${ts ? `, ${ts}` : ''}). Use source="transcripts" to search past discussions. ---`;
    }

    return null;
  } catch {
    return null;
  }
}
