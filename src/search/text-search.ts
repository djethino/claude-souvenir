import { parseTranscript, extractText } from '../transcript/parser.js';
import { getSessions } from '../archive/catalog.js';
import { getArchivedFiles } from '../archive/store.js';
import { escapeLike, iteratePartialSessionChunks } from '../db/store.js';
import { logger } from '../utils/logger.js';
import type { SearchResult, SessionInfo } from '../transcript/types.js';

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
 * Perform text search in the archived transcripts, and in the excerpts of partial sessions
 * (transcripts Claude Code deleted before souvenir archived them).
 */
export async function textSearch(options: TextSearchOptions): Promise<{
  results: SearchResult[];
  totalMatches: number;
  filesSearched: number;
  /** "session: error" for each transcript that could not be read */
  unreadable: string[];
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
  // Transcripts that failed mid-read: reported with the results, which lack their matches
  const unreadable: string[] = [];

  let regexPattern: RegExp | null = null;
  if (regex) {
    try {
      regexPattern = new RegExp(query, caseSensitive ? 'g' : 'gi');
    } catch (err) {
      throw new Error(`Invalid regex pattern: ${query} - ${err}`);
    }
  }

  /** Whether a text matches, with its snippet and score. */
  const match = (text: string): { snippet: string; score: number } | null => {
    if (regexPattern) {
      regexPattern.lastIndex = 0;
      const m = regexPattern.exec(text);
      return m ? { snippet: extractSnippet(text, m[0], caseSensitive), score: 0.7 } : null;
    }
    const found = caseSensitive ? text.includes(query) : text.toLowerCase().includes(query.toLowerCase());
    return found ? { snippet: extractSnippet(text, query, caseSensitive), score: scoreMatch(text, query, caseSensitive) } : null;
  };

  const includeSubagents = options.includeSubagents ?? false;
  const includeTypes: string[] = ['summary'];
  if (role === 'both' || role === 'user') includeTypes.push('user');
  if (role === 'both' || role === 'assistant') includeTypes.push('assistant');

  for (const projectDir of projectDirs) {
    // Session titles for the results, read once per project (a session can match thousands of times)
    const sessions = new Map<string, SessionInfo>(getSessions(projectDir, { includeSidechains: true }).map((s) => [s.sessionId, s]));

    const files = getArchivedFiles(projectDir).filter((f) => {
      if (f.parent_session_id !== null && !includeSubagents) return false;
      return !sessionId || f.session_id === sessionId || (includeSubagents && f.parent_session_id === sessionId);
    });

    for (const file of files) {
      filesSearched++;
      const meta = sessions.get(file.session_id);
      try {
        const stream = parseTranscript(file.file_key, {
          includeTypes,
          containsText: regex ? undefined : query,
          caseInsensitive: !caseSensitive,
        });

        for await (const { entry, lineNumber } of stream) {
          if (dateFrom && entry.timestamp && entry.timestamp < dateFrom) continue;
          if (dateTo && entry.timestamp && entry.timestamp > dateTo) continue;

          const text = extractText(entry);
          if (!text) continue;
          const found = match(text);
          if (!found) continue;

          allResults.push({
            sessionId: file.session_id,
            projectDir,
            entryUuid: entry.uuid,
            role: entry.type === 'user' ? 'user' : entry.type === 'assistant' ? 'assistant' : 'summary',
            content: text.slice(0, 500),
            snippet: found.snippet,
            timestamp: entry.timestamp,
            lineNumber,
            score: found.score,
            sessionSummary: meta?.summary,
            sessionFirstPrompt: meta?.firstPrompt,
          });
        }
      } catch (err) {
        logger.warn(`Error searching ${file.file_key}:`, err);
        unreadable.push(`${file.session_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Partial sessions: only their excerpts remain ("USER: …\nASSISTANT: …"), searched as a whole
    // LIKE ignores case for ASCII letters only: other queries are matched in JS on every excerpt
    const likeIsSafe = !regex && (caseSensitive || !/[^\x00-\x7f]/.test(query));
    const like = likeIsSafe ? `%${escapeLike(query)}%` : null;
    for (const chunk of iteratePartialSessionChunks(projectDir, like)) {
      if (sessionId && chunk.session_id !== sessionId) continue;
      if (!includeSubagents && sessions.get(chunk.session_id)?.isSidechain) continue;
      if (dateFrom && chunk.timestamp && chunk.timestamp < dateFrom) continue;
      if (dateTo && chunk.timestamp && chunk.timestamp > dateTo) continue;
      if (role === 'user' && chunk.role !== 'turn') continue;
      if (role === 'assistant' && chunk.role !== 'assistant' && !chunk.content_text.includes('\nASSISTANT: ')) continue;
      const found = match(chunk.content_text);
      if (!found) continue;

      const meta = sessions.get(chunk.session_id);
      allResults.push({
        sessionId: chunk.session_id,
        projectDir,
        entryUuid: chunk.entry_uuid ?? undefined,
        role: `${chunk.role ?? 'turn'} (partial session excerpt)`,
        content: chunk.content_text.slice(0, 500),
        snippet: found.snippet,
        timestamp: chunk.timestamp ?? undefined,
        lineNumber: chunk.line_number ?? 0,
        score: found.score,
        sessionSummary: meta?.summary,
        sessionFirstPrompt: meta?.firstPrompt,
      });
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
    unreadable,
  };
}
