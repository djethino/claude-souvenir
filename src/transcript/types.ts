/**
 * TypeScript interfaces for Claude Code transcript JSONL entries.
 */

// --- Content block types ---

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  /** A string, or blocks (text, image …) for results that are not plain text */
  content: string | Array<{ type: string; text?: string }>;
  tool_use_id: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// --- Base entry ---

export interface BaseEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  userType?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
}

// --- Entry types ---

export interface UserEntry extends BaseEntry {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
}

export interface AssistantEntry extends BaseEntry {
  type: 'assistant';
  message: {
    model?: string;
    id?: string;
    role: 'assistant';
    content: ContentBlock[];
    stop_reason?: string | null;
    usage?: {
      input_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens: number;
    };
  };
}

export interface SummaryEntry extends BaseEntry {
  type: 'summary';
  summary: string;
  leafUuid?: string;
}

export interface ProgressEntry extends BaseEntry {
  type: 'progress';
  data?: {
    type?: string;
    hookEvent?: string;
    hookName?: string;
    command?: string;
  };
}

export interface FileHistorySnapshotEntry extends BaseEntry {
  type: 'file-history-snapshot';
  snapshot?: unknown;
}

export type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | SummaryEntry
  | ProgressEntry
  | FileHistorySnapshotEntry;

// --- Sessions as souvenir knows them (archive/catalog.ts) ---

/**
 * What souvenir kept of a session:
 * - complete: every line, in the archive (whether Claude Code still has the transcript or not)
 * - partial: Claude Code deleted the transcript before souvenir archived transcripts (before
 *   0.6.0): only the search index excerpts remain (first 2,000 characters of each exchange)
 * - lost: listed in Claude Code's old sessions-index.json, but nothing of it was kept
 */
export type SessionAvailability = 'complete' | 'partial' | 'lost';

export interface SessionInfo {
  sessionId: string;
  projectDir: string;
  /** Archived transcript, null when the session is not archived */
  fileKey: string | null;
  firstPrompt: string;
  /** Title: the one the user gave, else the generated one or an old summary ('' when none) */
  summary: string;
  /** Entries souvenir_read pages through (excerpts for a partial session) */
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
  availability: SessionAvailability;
  /** Claude Code deleted the transcript file (the archive still has it when complete) */
  sourceDeleted: boolean;
}

// --- Session index (Claude Code's sessions-index.json, no longer written) ---

export interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

export interface SessionIndex {
  version: number;
  originalPath: string;
  entries: SessionIndexEntry[];
}

// --- Detail level for output formatting ---

export type DetailLevel = 'conversation' | 'compact' | 'full' | 'files' | 'tools';

// --- Search result ---

export interface SearchResult {
  sessionId: string;
  projectDir: string;
  entryUuid?: string;
  role: string;
  content: string;
  snippet: string;
  timestamp?: string;
  lineNumber: number;
  score: number;
  sessionSummary?: string;
  sessionFirstPrompt?: string;
  /** Other sessions holding a copy of this same entry (resumed or forked sessions, see search/copies.ts) */
  alsoInSessions?: string[];
}
