#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { logger } from './utils/logger.js';
import { setCurrentProjectFromRoots } from './config.js';
import { handleSouvenirSearch } from './tools/search.js';
import { handleSouvenirRead } from './tools/read.js';
import { handleSouvenirSessions } from './tools/sessions.js';
import { handleSouvenirProjects } from './tools/projects.js';
import { handleSouvenirIndex } from './tools/index-mgmt.js';
import { handleSouvenirDocs } from './tools/docs.js';
import { handleSouvenirTree } from './tools/tree.js';
import { scheduleBackgroundIndex } from './indexer/background.js';

const server = new McpServer({
  name: 'claude-souvenir',
  version: '0.1.0',
});

/**
 * Wrap a tool handler to add background indexing:
 * - Before: check trigger flag (from Stop hook) → schedule index
 * - After: schedule background index for next cycle
 */
function withBackgroundIndex<T>(handler: (params: T) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>) {
  return async (params: T) => {
    const result = await handler(params);
    scheduleBackgroundIndex();
    return result;
  };
}

// --- souvenir_search ---
server.tool(
  'souvenir_search',
  `Search through conversation transcripts AND/OR project files (docs, code, config). Returns ranked results with context snippets, timestamps, and session/file info.

Sources:
- "transcripts" (default): search past Claude Code conversations. Results include cross-reference hints if project docs are indexed.
- "docs": search only indexed documentation files (.md, .txt, .rst).
- "code": search only indexed code files (.ts, .py, .go, etc.).
- "config": search only indexed config files (.json, .yaml, etc.).
- "project": search all indexed project files (docs + code + config).
- "all": search both transcripts AND project files.

Modes:
- "hybrid" (default): combines text matching AND meaning-based search. Best for most queries.
- "text": exact substring or regex matching only. Use ONLY for specific literal strings. Only works with source="transcripts".
- "semantic": meaning-based only. Understands natural language queries in any language.

IMPORTANT: For conceptual queries ("what did we decide about X", "discussion about Y"), ALWAYS use hybrid or semantic mode.

Each transcript result includes a session_id and entry_uuid. Use souvenir_read with around_uuid to read context.
Each docs result includes file_path and line range. Navigate project files directly.

Cross-referencing: When searching one source, results include hints about matches in the other source (count + best score + recency).

Typical workflow: souvenir_search (find relevant entries) → souvenir_read around_uuid (read context). For docs: souvenir_docs add path="src" → souvenir_docs build → souvenir_search source="code".`,
  {
    query: z.string().describe('Search query. Describe what you\'re looking for in natural language. For text mode only: substring or regex pattern.'),
    mode: z.enum(['text', 'semantic', 'hybrid']).optional().describe('Search mode. Default: "hybrid". Use "text" only for exact literal matches (variable names, error codes, UUIDs).'),
    source: z.enum(['transcripts', 'docs', 'code', 'config', 'project', 'all']).optional().describe('Where to search. Default: "transcripts". Use "project" for all indexed project files, "all" for everything.'),
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
  withBackgroundIndex(async (params) => {
    try {
      const text = await handleSouvenirSearch(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('souvenir_search error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }),
);

// --- souvenir_read ---
server.tool(
  'souvenir_read',
  `Read conversation entries from a specific Claude Code session transcript. Returns formatted messages with timestamps, roles, and content. Use this after souvenir_search to read the full context around a search result, or to browse a session chronologically. Automatically skips internal entries (file snapshots, thinking blocks) and condenses tool calls for readability. Use detail_level to control verbosity and before_turns/after_turns for asymmetric message navigation.

IMPORTANT: session_id must come from souvenir_search results or souvenir_sessions output. Do NOT guess or fabricate session IDs.

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
  withBackgroundIndex(async (params) => {
    try {
      const text = await handleSouvenirRead(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('souvenir_read error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }),
);

// --- souvenir_sessions ---
server.tool(
  'souvenir_sessions',
  `List all conversation sessions for a project with their metadata (first prompt, summary, dates, message count). Use this to find which session to search or read. Results are sorted by most recent first by default. Includes orphan sessions (transcript files not in the index).

Typical workflow: souvenir_projects → souvenir_sessions (pick a session) → souvenir_read or souvenir_search with session_id.

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
  withBackgroundIndex(async (params) => {
    try {
      const text = await handleSouvenirSessions(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('souvenir_sessions error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }),
);

// --- souvenir_projects ---
server.tool(
  'souvenir_projects',
  `List all Claude Code projects that have conversation history. Shows project path, directory name (used as identifier in other tools), number of sessions, and date range. The current project is marked with [current]. Projects whose original path no longer exists are marked [orphan].

Actions:
- "list" (default): Show all projects with status. Also detects orphaned index data (projects in the semantic index but no longer on disk).
- "clean": Remove index data for orphaned projects. Frees space in the semantic search database. Transcript files in ~/.claude/projects/ are preserved.

Typical workflow: souvenir_projects → souvenir_sessions project="<dir_name>" → souvenir_read or souvenir_search.`,
  {
    action: z.enum(['list', 'clean']).optional().describe('Default: "list". Use "clean" to remove orphaned project data from the semantic index.'),
    search: z.string().optional().describe('Filter projects whose path contains this text.'),
  },
  withBackgroundIndex(async (params) => {
    try {
      const text = await handleSouvenirProjects(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('souvenir_projects error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }),
);

// --- souvenir_index ---
server.tool(
  'souvenir_index',
  `Manage the semantic search index used by souvenir_search in "semantic" or "hybrid" mode. Use action "status" to check what's indexed, "build" to index new/updated sessions incrementally, or "rebuild" to re-index everything from scratch. First-time indexing of a large project may take several minutes.`,
  {
    action: z.enum(['status', 'build', 'rebuild']).describe('"status": show indexing state. "build": incrementally index new content. "rebuild": drop and re-index everything.'),
    project: z.string().optional().describe('Project to index. Default: current project. Use "all" for all projects.'),
    session_id: z.string().optional().describe('Index only a specific session.'),
  },
  withBackgroundIndex(async (params) => {
    try {
      const text = await handleSouvenirIndex(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('souvenir_index error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }),
);

// --- souvenir_docs ---
server.tool(
  'souvenir_docs',
  `Manage project documentation and code indexing for semantic search. This indexes LOCAL project files (docs, code, config) into a separate database from conversation transcripts.

Actions:
- "add": Track a file or directory for indexing. Provide path (relative to project root). For directories, optionally set pattern (e.g. "*.md") and category.
- "remove": Stop tracking a source. Provide source_id (from "list") or path.
- "list": Show all tracked sources and resolved file counts.
- "status": Show index statistics (chunks, files, sections, pending changes).
- "build": Index new/changed files incrementally. Use rebuild=true to re-index everything.
- "clear": Remove all indexed data (sources are preserved).
- "sections": Show markdown section table of contents for a file. Provide path. Returns heading hierarchy with line numbers for navigation.

Categories are auto-detected by extension: doc (.md, .txt), code (.ts, .py, .go...), config (.json, .yaml...).
Override with the category parameter if needed.

Typical workflow: souvenir_docs add path="src" → souvenir_docs add path="docs" → souvenir_docs build → souvenir_search source="docs". For markdown navigation: souvenir_docs sections path="docs/guide.md".`,
  {
    action: z.enum(['add', 'remove', 'list', 'status', 'build', 'clear', 'sections']).describe('Action to perform.'),
    path: z.string().optional().describe('For "add": file or directory path relative to project root. For "remove": path to untrack.'),
    pattern: z.string().optional().describe('For "add" with directory: glob pattern to filter files (e.g. "*.md", "*.{ts,js}"). Default: all supported extensions.'),
    category: z.enum(['doc', 'code', 'config']).optional().describe('Override auto-detection. Force all files from this source to a specific category.'),
    source_id: z.number().int().optional().describe('For "remove": source ID to remove (from "list" output).'),
    rebuild: z.boolean().optional().describe('For "build": drop and re-index everything. Default: false (incremental).'),
  },
  withBackgroundIndex(async (params) => {
    try {
      const text = await handleSouvenirDocs(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('souvenir_docs error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }),
);

// --- souvenir_tree ---
server.tool(
  'souvenir_tree',
  `Display the directory tree of the current project. Useful for quickly understanding the codebase structure.

Automatically skips noise directories: node_modules, .git, build, dist, __pycache__, .venv, etc.
Shows hidden directories selectively: .claude-plugin, .github, .vscode are shown; other dot-directories are hidden.

Output format: Standard ASCII tree with connectors, ending with a file/directory count summary.

Use path to explore a subdirectory. Use pattern to filter files by extension. Use directories_only for a high-level structure overview.`,
  {
    path: z.string().optional().describe('Subdirectory to display (relative to project root). Default: project root.'),
    depth: z.number().int().min(1).max(10).optional().describe('Maximum depth to display. Default: 3.'),
    pattern: z.string().optional().describe('Filter files by pattern: "*.ts", "*.{ts,js}", or exact filename. Directories are shown only if they contain matching files.'),
    directories_only: z.boolean().optional().describe('Show only directories, no files. Default: false.'),
  },
  withBackgroundIndex(async (params) => {
    try {
      const text = await handleSouvenirTree(params);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('souvenir_tree error:', msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }),
);

// --- Start server ---
async function main() {
  logger.info('Starting claude-souvenir MCP server...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('claude-souvenir MCP server running on stdio');

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
