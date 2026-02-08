#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { logger } from './utils/logger.js';
import { setCurrentProjectFromRoots } from './config.js';
import { handleRecallSearch } from './tools/search.js';
import { handleRecallRead } from './tools/read.js';
import { handleRecallSessions } from './tools/sessions.js';
import { handleRecallProjects } from './tools/projects.js';
import { handleRecallIndex } from './tools/index-mgmt.js';

const server = new McpServer({
  name: 'claude-recall',
  version: '0.1.0',
});

// --- recall_search ---
server.tool(
  'recall_search',
  `Search through past Claude Code conversation transcripts. Finds relevant conversations by matching your query against user messages, assistant responses, and session summaries. Returns ranked results with context snippets, timestamps, and session info.

Modes: "text" (default, fast, exact/regex), "semantic" (meaning-based, requires recall_index build first), "hybrid" (both combined).

Each result includes a session_id and entry_uuid. To read full context around a result, use recall_read with around_uuid=<entry_uuid> and session_id=<session_id>.

Pagination: Results include "Page X/Y" footer. Use offset parameter to get next pages.`,
  {
    query: z.string().describe('Search query. For text mode: substring or regex. For semantic mode: natural language description of what you\'re looking for.'),
    mode: z.enum(['text', 'semantic', 'hybrid']).optional().describe('Search mode. Default: "text". "semantic" requires prior indexing via recall_index.'),
    project: z.string().optional().describe('Project directory name (e.g. "D--projet-claude-plugins") or path. Default: current project. Use "all" for all projects.'),
    session_id: z.string().optional().describe('Limit search to a specific session UUID. Use "current" to auto-resolve the most recent session.'),
    role: z.enum(['user', 'assistant', 'both']).optional().describe('Filter by message role. Default: "both".'),
    date_from: z.string().optional().describe('ISO date string. Only search entries after this date.'),
    date_to: z.string().optional().describe('ISO date string. Only search entries before this date.'),
    include_subagents: z.boolean().optional().describe('Also search subagent/sidechain transcripts. Default: false.'),
    max_results: z.number().int().min(1).max(50).optional().describe('Maximum results to return. Default: 10.'),
    offset: z.number().int().min(0).optional().describe('Skip first N results for pagination. Default: 0.'),
    case_sensitive: z.boolean().optional().describe('For text mode: case-sensitive matching. Default: false.'),
    regex: z.boolean().optional().describe('For text mode: treat query as regex pattern. Default: false.'),
  },
  async (params) => {
    try {
      const text = await handleRecallSearch(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('recall_search error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- recall_read ---
server.tool(
  'recall_read',
  `Read conversation entries from a specific Claude Code session transcript. Returns formatted messages with timestamps, roles, and content. Use this after recall_search to read the full context around a search result, or to browse a session chronologically. Automatically skips internal entries (file snapshots, thinking blocks) and condenses tool calls for readability. Use detail_level to control verbosity and before_turns/after_turns for asymmetric message navigation.

Reading modes:
- Default (no from_line): reads the LAST entries (most recent). Best for catching up after context compaction.
- from_line=N: reads forward from line N. Use pagination hints (Earlier/Later) to navigate in both directions.
- around_uuid: centers around a specific entry UUID from a search result.

Pagination: Each response includes a footer with page position and navigation hints for adjacent pages (entry count + character size preview). Use max_entries=1 with around_uuid to read a single entry without truncation. Truncated entries include a drill-down hint.`,
  {
    session_id: z.string().describe('Session UUID to read from. Use "current" to auto-resolve the most recent session.'),
    project: z.string().optional().describe('Project directory name. Default: current project (also searches other projects if not found).'),
    around_uuid: z.string().optional().describe('Center the output around this entry UUID (from a search result). Returns context_turns before and after. Use with before_turns=0, after_turns=0, max_entries=1 to read a single entry without truncation.'),
    from_line: z.number().int().min(1).optional().describe('Start reading from this JSONL line number (1-based). When omitted, reads from the END of the session (most recent entries). Use values from pagination hints (Earlier/Later) to navigate.'),
    max_entries: z.number().int().min(1).max(200).optional().describe('Maximum conversation entries to return per page. Default: 20. Use 1 with around_uuid for full single-entry view without truncation.'),
    context_turns: z.number().int().min(1).max(20).optional().describe('When using around_uuid, number of conversation turns before and after to include. Default: 3.'),
    before_turns: z.number().int().min(0).max(20).optional().describe('When using around_uuid, number of conversation messages before the target. Overrides context_turns for the "before" direction.'),
    after_turns: z.number().int().min(0).max(20).optional().describe('When using around_uuid, number of conversation messages after the target. Overrides context_turns for the "after" direction.'),
    detail_level: z.enum(['conversation', 'compact', 'full']).optional().describe('Output detail level. "conversation" (default): text + tool usage summary. "compact": text + tool names. "full": everything including tool inputs/outputs.'),
    entry_types: z.string().optional().describe('Comma-separated types to include. Default: "user,assistant,summary". Add "progress" if needed.'),
  },
  async (params) => {
    try {
      const text = await handleRecallRead(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('recall_read error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- recall_sessions ---
server.tool(
  'recall_sessions',
  `List all conversation sessions for a project with their metadata (first prompt, summary, dates, message count). Use this to find which session to search or read. Results are sorted by most recent first by default. Includes orphan sessions (transcript files not in the index).

Typical workflow: recall_projects → recall_sessions (pick a session) → recall_read or recall_search with session_id.

Pagination: Shows "Showing X/Y sessions" footer. Increase max_results to see more.`,
  {
    project: z.string().optional().describe('Project directory name or path. Default: current project.'),
    search: z.string().optional().describe('Filter sessions where summary or firstPrompt contains this text (case-insensitive).'),
    date_from: z.string().optional().describe('Only sessions created after this ISO date.'),
    date_to: z.string().optional().describe('Only sessions created before this ISO date.'),
    sort: z.enum(['newest', 'oldest', 'messages']).optional().describe('Sort order. Default: "newest".'),
    max_results: z.number().int().min(1).max(50).optional().describe('Maximum sessions to return. Default: 20.'),
    include_sidechains: z.boolean().optional().describe('Include sidechain/subagent sessions. Default: false.'),
  },
  async (params) => {
    try {
      const text = await handleRecallSessions(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('recall_sessions error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- recall_projects ---
server.tool(
  'recall_projects',
  `List all Claude Code projects that have conversation history. Shows project path, directory name (used as identifier in other tools), number of sessions, and date range. The current project is marked with [current]. Use this to discover available projects before using other tools.

Typical workflow: recall_projects → recall_sessions project="<dir_name>" → recall_read or recall_search.`,
  {
    search: z.string().optional().describe('Filter projects whose path contains this text.'),
  },
  async (params) => {
    try {
      const text = await handleRecallProjects(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('recall_projects error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- recall_index ---
server.tool(
  'recall_index',
  `Manage the semantic search index used by recall_search in "semantic" or "hybrid" mode. Use action "status" to check what's indexed, "build" to index new/updated sessions incrementally, or "rebuild" to re-index everything from scratch. First-time indexing of a large project may take several minutes.`,
  {
    action: z.enum(['status', 'build', 'rebuild']).describe('"status": show indexing state. "build": incrementally index new content. "rebuild": drop and re-index everything.'),
    project: z.string().optional().describe('Project to index. Default: current project. Use "all" for all projects.'),
    session_id: z.string().optional().describe('Index only a specific session.'),
  },
  async (params) => {
    try {
      const text = await handleRecallIndex(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('recall_index error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- Start server ---
async function main() {
  logger.info('Starting claude-recall MCP server...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('claude-recall MCP server running on stdio');

  // Request workspace roots from Claude Code as fallback for project detection.
  // Primary detection uses process.cwd(), roots is a backup via MCP protocol.
  try {
    const { roots } = await server.server.listRoots();
    logger.info('MCP roots received:', roots.map((r) => r.uri));
    setCurrentProjectFromRoots(roots);
  } catch (err) {
    logger.info('Could not get MCP roots (client may not support it):', err);
  }
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
