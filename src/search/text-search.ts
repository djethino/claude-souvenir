import { parseTranscript, extractText } from '../transcript/parser.js';
import { listTranscriptFiles, getSessionMetadata } from '../transcript/discovery.js';
import { logger } from '../utils/logger.js';
import type { SearchResult } from '../transcript/types.js';
import { basename } from 'path';

export interface TextSearchOptions {
  query: string;
  projectDirs: string[];
  sessionId?: string;
  role?: 'user' | 'assistant' | 'both';
  dateFrom?: string;
  dateTo?: string;
  maxResults?: number;
  offset?: number;
  caseSensitive?: boolean;
  regex?: boolean;
  includeSubagents?: boolean;
}

const CONTEXT_CHARS = 100;

/**
 * Extract a snippet around the match position.
 */
function extractSnippet(text: string, query: string, caseSensitive: boolean): string {
  const searchText = caseSensitive ? text : text.toLowerCase();
  const searchQuery = caseSensitive ? query : query.toLowerCase();

  const idx = searchText.indexOf(searchQuery);
  if (idx === -1) return text.slice(0, 200);

  const start = Math.max(0, idx - CONTEXT_CHARS);
  const end = Math.min(text.length, idx + query.length + CONTEXT_CHARS);

  let snippet = text.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';

  return snippet.replace(/\n/g, ' ');
}

/**
 * Score a match based on quality.
 */
function scoreMatch(text: string, query: string, caseSensitive: boolean): number {
  const t = caseSensitive ? text : text.toLowerCase();
  const q = caseSensitive ? query : query.toLowerCase();

  // Exact full match
  if (t === q) return 1.0;

  // Word boundary match
  const wordBoundaryRegex = new RegExp(`\\b${escapeRegex(q)}\\b`, caseSensitive ? '' : 'i');
  if (wordBoundaryRegex.test(text)) return 0.8;

  // Start of text
  if (t.startsWith(q)) return 0.7;

  // Substring match
  if (t.includes(q)) return 0.5;

  return 0.3;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Perform text search across transcript files.
 */
export async function textSearch(options: TextSearchOptions): Promise<{
  results: SearchResult[];
  totalMatches: number;
  filesSearched: number;
}> {
  const {
    query,
    projectDirs,
    sessionId,
    role = 'both',
    dateFrom,
    dateTo,
    maxResults = 10,
    offset = 0,
    caseSensitive = false,
    regex = false,
  } = options;

  const allResults: SearchResult[] = [];
  let filesSearched = 0;

  // Compile regex if needed
  let regexPattern: RegExp | null = null;
  if (regex) {
    try {
      regexPattern = new RegExp(query, caseSensitive ? 'g' : 'gi');
    } catch (err) {
      throw new Error(`Invalid regex pattern: ${query} - ${err}`);
    }
  }

  const includeSubagents = options.includeSubagents ?? false;

  // Determine which files to search
  for (const projectDir of projectDirs) {
    const files = listTranscriptFiles(projectDir, {
      includeSubagents,
      sessionId,
    });

    for (const filePath of files) {
      // If filtering by session (and not using subagent discovery which already filters), check filename
      if (sessionId && !includeSubagents) {
        const fileName = basename(filePath, '.jsonl');
        if (fileName !== sessionId) continue;
      }

      filesSearched++;

      // Determine include types based on role
      const includeTypes: string[] = ['summary'];
      if (role === 'both' || role === 'user') includeTypes.push('user');
      if (role === 'both' || role === 'assistant') includeTypes.push('assistant');

      try {
        const stream = parseTranscript(filePath, {
          includeTypes,
          containsText: regex ? undefined : query,
          caseInsensitive: !caseSensitive,
        });

        for await (const { entry, lineNumber } of stream) {
          // Date filters
          if (dateFrom && entry.timestamp && entry.timestamp < dateFrom) continue;
          if (dateTo && entry.timestamp && entry.timestamp > dateTo) continue;

          const text = extractText(entry);
          if (!text) continue;

          // Match check
          let matched = false;
          let snippet = '';
          let score = 0;

          if (regex && regexPattern) {
            regexPattern.lastIndex = 0;
            matched = regexPattern.test(text);
            if (matched) {
              regexPattern.lastIndex = 0;
              const m = regexPattern.exec(text);
              snippet = m ? extractSnippet(text, m[0], caseSensitive) : text.slice(0, 200);
              score = 0.7;
            }
          } else {
            const textLower = caseSensitive ? text : text.toLowerCase();
            const queryLower = caseSensitive ? query : query.toLowerCase();
            matched = textLower.includes(queryLower);
            if (matched) {
              snippet = extractSnippet(text, query, caseSensitive);
              score = scoreMatch(text, query, caseSensitive);
            }
          }

          if (matched) {
            const entrySessionId = entry.sessionId || basename(filePath, '.jsonl');
            const meta = getSessionMetadata(entrySessionId, projectDir);

            allResults.push({
              sessionId: entrySessionId,
              projectDir,
              entryUuid: entry.uuid,
              role: entry.type === 'user' ? 'user' : entry.type === 'assistant' ? 'assistant' : 'summary',
              content: text.slice(0, 500),
              snippet,
              timestamp: entry.timestamp,
              lineNumber,
              score,
              sessionSummary: meta?.entry.summary,
              sessionFirstPrompt: meta?.entry.firstPrompt,
            });
          }
        }
      } catch (err) {
        logger.warn(`Error searching ${filePath}:`, err);
      }
    }
  }

  // Sort by score descending, then by timestamp descending
  allResults.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.timestamp || '').localeCompare(a.timestamp || '');
  });

  return {
    results: allResults.slice(offset, offset + maxResults),
    totalMatches: allResults.length,
    filesSearched,
  };
}
