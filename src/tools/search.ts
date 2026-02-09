import { textSearch } from '../search/text-search.js';
import { formatSearchResult } from '../transcript/formatter.js';
import { listProjectDirs, getSessionMetadata, resolveCurrentSession } from '../transcript/discovery.js';
import { getConfig } from '../config.js';
import { resolveProjectDir } from '../utils/paths.js';
import { getDb, searchSemantic, getStoredProvider, getProjectChunkCount } from '../db/store.js';
import { getOrCreateProvider } from './helpers.js';
import { buildIndex } from '../db/indexer.js';
import { logger } from '../utils/logger.js';
import { applySessionDensityBoost } from '../search/density-boost.js';
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
  const mode = params.mode || 'hybrid';

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
  // Fetch all results (no pagination) so density boost can re-rank across sessions
  const result = await textSearch({
    query: params.query,
    projectDirs,
    sessionId: params.session_id,
    role: params.role || 'both',
    dateFrom: params.date_from,
    dateTo: params.date_to,
    includeSubagents: params.include_subagents ?? false,
    maxResults: 10000,
    offset: 0,
    caseSensitive: params.case_sensitive ?? false,
    regex: params.regex ?? false,
  });

  if (result.results.length === 0) {
    return `No results found for "${params.query}" (searched ${result.filesSearched} files).`;
  }

  // Apply session density boost before pagination
  const { results: boostedResults, sessionHitCounts } = applySessionDensityBoost(result.results);

  const offset = params.offset || 0;
  const sliced = boostedResults.slice(offset, offset + maxResults);
  const total = boostedResults.length;
  const endIndex = offset + sliced.length;
  const hasMore = endIndex < total;

  const header = `Found ${total} result(s) for "${params.query}" (showing ${offset + 1}-${endIndex}, searched ${result.filesSearched} files):\n`;

  const formatted = sliced.map((r, i) =>
    formatSearchResult(r, offset + i, sessionHitCounts.get(r.sessionId)),
  );

  let footer = hasMore
    ? `\n--- Page ${Math.ceil(endIndex / maxResults)}/${Math.ceil(total / maxResults)} | ${total - endIndex} more results | Next page: offset=${endIndex} ---`
    : `\n--- All ${total} results shown ---`;

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
): Promise<string> {
  const config = getConfig();

  // Get singleton provider and initialize
  const provider = getOrCreateProvider(config);
  try {
    if (!provider.isReady()) {
      await provider.initialize();
    }

    // Auto-index for single-project searches (the common case)
    if (projectDirs.length === 1) {
      try {
        await buildIndex(provider, projectDirs, { rebuild: false });
      } catch (err) {
        logger.warn('Auto-index failed, continuing with existing index:', err);
      }
    } else {
      // Multi-project: check that index exists (no auto-index to avoid long waits)
      try {
        getDb(config.embeddingDimensions);
      } catch {
        return 'No semantic index found. Run recall_index with action="build" first to create the index.';
      }
      const stored = getStoredProvider();
      if (!stored) {
        return 'No semantic index found. Run recall_index with action="build" first.';
      }
    }

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

    // Convert all results to SearchResult format (no pagination yet)
    const allResults: SearchResult[] = vecResults.map((vr) => {
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

    // Apply session density boost before pagination
    const { results: boostedResults, sessionHitCounts } = applySessionDensityBoost(allResults);

    const offset = params.offset || 0;
    const sliced = boostedResults.slice(offset, offset + maxResults);
    const total = boostedResults.length;
    const endIndex = offset + sliced.length;
    const hasMore = endIndex < total;

    const header = `Found ${total} semantic result(s) for "${params.query}" (showing ${offset + 1}-${endIndex}):\n`;
    const formatted = sliced.map((r, i) => formatSearchResult(r, offset + i, sessionHitCounts.get(r.sessionId)));

    const footer = hasMore
      ? `\n--- Page ${Math.ceil(endIndex / maxResults)}/${Math.ceil(total / maxResults)} | ${total - endIndex} more results | Next page: offset=${endIndex} ---`
      : `\n--- All ${total} results shown ---`;

    return header + '\n' + formatted.join('\n\n') + footer;
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
      const provider = getOrCreateProvider(config);
      if (!provider.isReady()) {
        await provider.initialize();
      }

      // Auto-index for single-project (same as performSemanticSearch)
      if (projectDirs.length === 1) {
        try {
          await buildIndex(provider, projectDirs, { rebuild: false });
        } catch (err) {
          logger.warn('Auto-index failed in hybrid mode:', err);
        }
      } else {
        // Multi-project: just ensure DB exists
        getDb(config.embeddingDimensions);
      }

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

  // Sort by combined score, then apply session density boost
  const allResults = [...merged.values()].sort((a, b) => b.score - a.score);
  const { results: boostedResults, sessionHitCounts } = applySessionDensityBoost(allResults);

  const offset = params.offset || 0;
  const sliced = boostedResults.slice(offset, offset + maxResults);

  if (sliced.length === 0) {
    return `No results found for "${params.query}".`;
  }

  const total = boostedResults.length;
  const endIndex = offset + sliced.length;
  const hasMore = endIndex < total;

  const header = `Found ${total} hybrid result(s) for "${params.query}" (showing ${offset + 1}-${endIndex}):\n`;
  const formatted = sliced.map((r, i) => formatSearchResult(r, offset + i, sessionHitCounts.get(r.sessionId)));

  const footer = hasMore
    ? `\n--- Page ${Math.ceil(endIndex / maxResults)}/${Math.ceil(total / maxResults)} | ${total - endIndex} more results | Next page: offset=${endIndex} ---`
    : `\n--- All ${total} results shown ---`;

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
    const probeResults = searchSemantic(queryEmbedding, { topK: 5, projectDir });
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
