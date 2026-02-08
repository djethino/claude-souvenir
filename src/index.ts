#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { logger } from './utils/logger.js';
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
  `Search through past Claude Code conversation transcripts. Finds relevant conversations by matching your query against user messages, assistant responses, and session summaries. Use mode "text" for exact/regex matching (fast, no setup needed), "semantic" for meaning-based search (requires indexing first via recall_index), or "hybrid" for both combined. Returns ranked results with context snippets, timestamps, and session info. Default scope is the current project; set project to "all" to search all projects.`,
  {
    query: z.string().describe('Search query. For text mode: substring or regex. For semantic mode: natural language description of what you\'re looking for.'),
    mode: z.enum(['text', 'semantic', 'hybrid']).optional().describe('Search mode. Default: "text". "semantic" requires prior indexing via recall_index.'),
    project: z.string().optional().describe('Project directory name (e.g. "D--projet-claude-plugins") or path. Default: current project. Use "all" for all projects.'),
    session_id: z.string().optional().describe('Limit search to a specific session UUID.'),
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
  `Read conversation entries from a specific Claude Code session transcript. Returns formatted messages with timestamps, roles, and content. Use this after recall_search to read the full context around a search result, or to browse a session chronologically. Automatically skips internal entries (file snapshots, thinking blocks) and optionally condenses tool calls for readability.`,
  {
    session_id: z.string().describe('Session UUID to read from.'),
    project: z.string().optional().describe('Project directory name. Default: current project (also searches other projects if not found).'),
    around_uuid: z.string().optional().describe('Center the output around this entry UUID (from a search result). Returns context_turns before and after.'),
    from_line: z.number().int().min(1).optional().describe('Start reading from this JSONL line number (1-based). Default: 1.'),
    max_entries: z.number().int().min(1).max(100).optional().describe('Maximum conversation entries to return. Default: 20.'),
    context_turns: z.number().int().min(1).max(20).optional().describe('When using around_uuid, number of conversation turns before and after to include. Default: 3.'),
    include_tool_details: z.boolean().optional().describe('Show full tool call inputs/outputs. Default: false (shows condensed summary).'),
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
  `List all conversation sessions for a project with their metadata (first prompt, summary, dates, message count). Use this to find which session to search or read. Results are sorted by most recent first by default.`,
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
  `List all Claude Code projects that have conversation history. Shows project path, directory name (used as identifier in other tools), number of sessions, and date range. Use this to discover what projects are available before searching across them.`,
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
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
