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
  content: string;
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

// --- Session index ---

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

export type DetailLevel = 'conversation' | 'compact' | 'full';

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
}
