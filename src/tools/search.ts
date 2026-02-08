import { textSearch } from '../search/text-search.js';
import { formatSearchResult } from '../transcript/formatter.js';
import { listProjectDirs, getSessionMetadata, resolveCurrentSession } from '../transcript/discovery.js';
import { getConfig } from '../config.js';
import { resolveProjectDir } from '../utils/paths.js';
import { getDb, searchSemantic, getStoredProvider } from '../db/store.js';
import { createEmbeddingProvider } from './helpers.js';
import { logger } from '../utils/logger.js';
import type { SearchResult } from '../transcript/types.js';

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

export async function handleRecallSearch(params: {
  query: string;
  mode?: 'text' | 'semantic' | 'hybrid';
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
}): Promise<string> {
  const config = getConfig();
  const mode = params.mode || 'text';

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

  if (mode === 'text') {
    return await performTextSearch(params, projectDirs, maxResults);
  }

  if (mode === 'semantic') {
    return await performSemanticSearch(params, projectDirs, maxResults);
  }

  if (mode === 'hybrid') {
    return await performHybridSearch(params, projectDirs, maxResults);
  }

  return `Unknown search mode: "${mode}". Use "text", "semantic", or "hybrid".`;
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
  const result = await textSearch({
    query: params.query,
    projectDirs,
    sessionId: params.session_id,
    role: params.role || 'both',
    dateFrom: params.date_from,
    dateTo: params.date_to,
    includeSubagents: params.include_subagents ?? false,
    maxResults,
    offset: params.offset || 0,
    caseSensitive: params.case_sensitive ?? false,
    regex: params.regex ?? false,
  });

  if (result.results.length === 0) {
    return `No results found for "${params.query}" (searched ${result.filesSearched} files).`;
  }

  const offset = params.offset || 0;
  const showing = result.results.length;
  const total = result.totalMatches;
  const endIndex = offset + showing;
  const hasMore = endIndex < total;

  const header = `Found ${total} result(s) for "${params.query}" (showing ${offset + 1}-${endIndex}, searched ${result.filesSearched} files):\n`;

  const formatted = result.results.map((r, i) =>
    formatSearchResult(r, offset + i),
  );

  const footer = hasMore
    ? `\n--- Page ${Math.ceil(endIndex / maxResults)}/${Math.ceil(total / maxResults)} | ${total - endIndex} more results | Next page: offset=${endIndex} ---`
    : `\n--- All ${total} results shown ---`;

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
): Promise<string> {
  const config = getConfig();

  // Check if index exists
  try {
    getDb(config.embeddingDimensions);
  } catch {
    return 'No semantic index found. Run recall_index with action="build" first to create the index.';
  }

  const stored = getStoredProvider();
  if (!stored) {
    return 'No semantic index found. Run recall_index with action="build" first.';
  }

  // Create provider and embed query
  const provider = createEmbeddingProvider(config);
  try {
    await provider.initialize();
    const queryEmbedding = await provider.embedQuery(params.query);

    // Map role filter
    let roleFilter: string | undefined;
    if (params.role === 'user') roleFilter = 'user';
    else if (params.role === 'assistant') roleFilter = 'assistant';

    // Search each project dir (use first one for single project filter)
    const projectDir = projectDirs.length === 1 ? projectDirs[0] : undefined;

    const vecResults = searchSemantic(queryEmbedding, {
      topK: maxResults + (params.offset || 0),
      projectDir,
      sessionId: params.session_id,
      role: roleFilter,
      dateFrom: params.date_from,
      dateTo: params.date_to,
    });

    if (vecResults.length === 0) {
      return `No semantic results found for "${params.query}". The index may be empty for the specified project. Run recall_index with action="status" to check.`;
    }

    // Convert to SearchResult format
    const offset = params.offset || 0;
    const sliced = vecResults.slice(offset, offset + maxResults);

    const results: SearchResult[] = sliced.map((vr) => {
      const meta = getSessionMetadata(vr.session_id);
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

    const total = vecResults.length;
    const endIndex = offset + results.length;
    const hasMore = endIndex < total;

    const header = `Found ${total} semantic result(s) for "${params.query}" (showing ${offset + 1}-${endIndex}):\n`;
    const formatted = results.map((r, i) => formatSearchResult(r, offset + i));

    const footer = hasMore
      ? `\n--- Page ${Math.ceil(endIndex / maxResults)}/${Math.ceil(total / maxResults)} | ${total - endIndex} more results | Next page: offset=${endIndex} ---`
      : `\n--- All ${total} results shown ---`;

    return header + '\n' + formatted.join('\n\n') + footer;
  } catch (err) {
    return `Semantic search error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await provider.dispose();
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
): Promise<string> {
  // Run text and semantic search in parallel
  const textPromise = textSearch({
    query: params.query,
    projectDirs,
    sessionId: params.session_id,
    role: params.role || 'both',
    dateFrom: params.date_from,
    dateTo: params.date_to,
    includeSubagents: params.include_subagents ?? false,
    maxResults: maxResults * 2,
    offset: 0,
    caseSensitive: params.case_sensitive ?? false,
    regex: params.regex ?? false,
  }).catch((err) => {
    logger.warn('Text search failed in hybrid mode:', err);
    return { results: [] as SearchResult[], totalMatches: 0, filesSearched: 0 };
  });

  const semanticPromise = (async () => {
    try {
      const config = getConfig();
      getDb(config.embeddingDimensions);
      const provider = createEmbeddingProvider(config);
      await provider.initialize();
      const queryEmbedding = await provider.embedQuery(params.query);

      let roleFilter: string | undefined;
      if (params.role === 'user') roleFilter = 'user';
      else if (params.role === 'assistant') roleFilter = 'assistant';

      const projectDir = projectDirs.length === 1 ? projectDirs[0] : undefined;

      const results = searchSemantic(queryEmbedding, {
        topK: maxResults * 2,
        projectDir,
        sessionId: params.session_id,
        role: roleFilter,
        dateFrom: params.date_from,
        dateTo: params.date_to,
      });

      await provider.dispose();
      return results;
    } catch {
      return [];
    }
  })();

  const [textResult, vecResults] = await Promise.all([textPromise, semanticPromise]);

  // Merge results
  const merged = new Map<string, SearchResult>();

  // Add text results
  for (const r of textResult.results) {
    const key = `${r.sessionId}:${r.lineNumber}`;
    merged.set(key, { ...r, score: r.score * 0.4 }); // Text weight: 0.4
  }

  // Add/merge semantic results
  for (const vr of vecResults) {
    const meta = getSessionMetadata(vr.session_id);
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

  // Sort by combined score
  const allResults = [...merged.values()].sort((a, b) => b.score - a.score);

  const offset = params.offset || 0;
  const sliced = allResults.slice(offset, offset + maxResults);

  if (sliced.length === 0) {
    return `No results found for "${params.query}".`;
  }

  const total = allResults.length;
  const endIndex = offset + sliced.length;
  const hasMore = endIndex < total;

  const header = `Found ${total} hybrid result(s) for "${params.query}" (showing ${offset + 1}-${endIndex}):\n`;
  const formatted = sliced.map((r, i) => formatSearchResult(r, offset + i));

  const footer = hasMore
    ? `\n--- Page ${Math.ceil(endIndex / maxResults)}/${Math.ceil(total / maxResults)} | ${total - endIndex} more results | Next page: offset=${endIndex} ---`
    : `\n--- All ${total} results shown ---`;

  return header + '\n' + formatted.join('\n\n') + footer;
}
