#!/usr/bin/env node

import { McpServer, type CallToolResult, type InputRequiredResult } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { logger } from './utils/logger.js';
import { handleSouvenirSearch } from './tools/search.js';
import { handleSouvenirRead } from './tools/read.js';
import { handleSouvenirSessions } from './tools/sessions.js';
import { handleSouvenirProjects } from './tools/projects.js';
import { handleSouvenirIndex } from './tools/index-mgmt.js';
import { handleSouvenirDocs } from './tools/docs.js';
import { handleSouvenirTree } from './tools/tree.js';
import { scheduleBackgroundIndex, abortBackgroundIndex, waitForIndexing } from './indexer/background.js';
import type { ToolContext } from './tools/helpers.js';
import { disposeSingletonProvider, errorMessage } from './tools/helpers.js';
import { ConfirmationNeeded, confirmFor, type Confirm } from './tools/confirm.js';
import { registerSessionResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { closeDb } from './db/store.js';
import { closeDocsDb } from './docs/store.js';

/** Injected from package.json by scripts/build.mjs. */
declare const __SOUVENIR_VERSION__: string;

/** Read by Claude at the start of every session (MCP server instructions): when to reach for souvenir. */
const INSTRUCTIONS = `souvenir searches this user's past Claude Code conversations and the project's indexed files.

- When the user refers to earlier work ("like we did for X", "as decided last time", "the previous version"), search with souvenir_search before asking them or looking elsewhere, then souvenir_read around_uuid for the full context.
- After a context compaction, when the summary lacks a detail (a decision, an error message, a value), find it in the current session (souvenir_search with session_id "current") instead of asking the user to repeat it.
- For an overview of a directory, use souvenir_tree rather than chains of ls/find/Glob: one call, noise hidden, with line counts (show_lines), recent changes (show_modified) and an extension filter (pattern).
- When a file was damaged or lost (bad edit, wrong checkout, deletion), look at souvenir_docs "history" before any other attempt. Only the files added to souvenir_docs are kept (set up per project, on request: "list" shows them; nothing added means no snapshots); while Claude Code works, they are snapshotted at most every ~30 s, kept 3 days. Before "restore", "diff" the chosen snapshot against the current file to see what restoring would erase. Restore saves the current state as a snapshot first (it can be undone), unlike a git checkout, which discards uncommitted work for good.
- For work done in another project, search with project "all" (souvenir_projects lists them).
- To learn why some code or a commit changed, search the commit hash or the file name in the conversations: the session that made the change holds the reason.`;

const server = new McpServer({ name: 'souvenir', version: __SOUVENIR_VERSION__ }, { instructions: INSTRUCTIONS });

/** Tools that change nothing: Claude Code runs their calls in parallel with other read-only calls. */
const READ_ONLY = { readOnlyHint: true } as const;

/**
 * Claude Code saves a text result longer than 50,000 characters to a file and gives Claude only a
 * reference to it, unless the tool raises its own threshold. 100,000 characters is about the
 * default MCP output budget (MAX_MCP_OUTPUT_TOKENS = 25,000 tokens): long reads and trees stay
 * in the conversation instead of being redirected to a file early.
 */
const LARGE_RESULT_META = { 'anthropic/maxResultSizeChars': 100_000 };

/**
 * Turn a handler returning text into an MCP tool callback: a thrown error becomes an error result,
 * a pending confirmation becomes the question to the user (see tools/confirm.ts), and every call
 * schedules a background index of the current project.
 */
function toolHandler<T>(name: string, handler: (params: T, ctx: ToolContext) => Promise<string>) {
  return async (params: T, ctx: ToolContext): Promise<CallToolResult | InputRequiredResult> => {
    try {
      const text = await handler(params, ctx);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      if (err instanceof ConfirmationNeeded) return err.toInputRequired();
      const msg = errorMessage(err);
      logger.error(`${name} error:`, msg);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    } finally {
      scheduleBackgroundIndex();
    }
  };
}

/** Confirmation of destructive actions for one tool call. */
function confirm(ctx: ToolContext): Confirm {
  return confirmFor(ctx, () => server.server.getClientCapabilities());
}

// --- souvenir_search ---
server.registerTool(
  'souvenir_search',
  {
    description: `Search conversation transcripts and/or project files. Returns ranked results with context snippets, timestamps, and source info.

ALWAYS use the default hybrid mode — it handles both exact strings and natural language queries. Only switch to "text" if you need regex, or to "semantic" to exclude literal matches.

Sources:
- "transcripts" (default): past conversations.
- "code": semantic search through indexed code — finds patterns by meaning, not just by string. Use Grep for exact literal matches, use this for conceptual queries ("find error handling", "where is auth checked", "deprecated patterns", "fallback logic").
- "docs": indexed documentation. "config": indexed config files.
- "project": all indexed project files (docs+code+config). "all": transcripts + project files.

Results include session_id + entry_uuid (transcripts) or file_path + line range (docs). Cross-reference hints show matches in the other source when available.

Workflow: souvenir_search → souvenir_read around_uuid for full context.`,
    annotations: READ_ONLY,
    inputSchema: z.object({
      query: z.string().describe('What you are looking for. Works with natural language, exact terms, function names, error messages — hybrid mode handles all of these.'),
      mode: z.enum(['text', 'semantic', 'hybrid']).optional().describe('Default: "hybrid" (text + semantic combined). Use "text" only for regex patterns. Use "semantic" for pure meaning-based search.'),
      source: z.enum(['transcripts', 'docs', 'code', 'config', 'project', 'all']).optional().describe('Default: "transcripts". Use "all" to search conversations AND project files together. Use "project" for indexed files only.'),
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
    }),
  },
  toolHandler('souvenir_search', (params, ctx) => handleSouvenirSearch(params, ctx)),
);

// --- souvenir_read ---
server.registerTool(
  'souvenir_read',
  {
    description: `Read a Claude Code session transcript. Returns clean, formatted messages — internal noise (file snapshots, thinking blocks) is automatically filtered out, and tool calls are condensed into readable summaries.

IMPORTANT: session_id must be "current" (this session) or come from souvenir_search or souvenir_sessions. Do NOT guess session IDs.

Reading modes:
- Default (no from_line): reads the LAST entries (most recent). Best for catching up after compaction.
- from_line=N: reads forward from line N. Follow pagination hints (Earlier/Later) to navigate.
- around_uuid=<uuid>: centers on a search result. Use before_turns/after_turns to control how much context to include (e.g. before_turns=0, after_turns=5 to read only what follows).
- detail_level="files": extracts all unique file paths accessed during the session, grouped by action (modified/read/searched). One-call answer to "what files did this session touch?"
- detail_level="tools": tool usage summary with call counts and error indicators.

Pagination: footer shows page position and navigation hints. Use max_entries=1 with around_uuid to read a single full entry without truncation.`,
    annotations: READ_ONLY,
    _meta: LARGE_RESULT_META,
    inputSchema: z.object({
      session_id: z.string().describe('Session UUID to read from. Use "current" for the most recent session.'),
      project: z.string().optional().describe('Project directory name. Default: current project (also searches other projects if not found).'),
      around_uuid: z.string().optional().describe('Center output around this entry UUID (from a search result). Use max_entries=1 to read the full entry without truncation.'),
      from_line: z.number().int().min(1).optional().describe('Start reading from this JSONL line number (1-based). When omitted, reads from the END of the session (most recent entries). Use values from pagination hints (Earlier/Later) to navigate.'),
      max_entries: z.number().int().min(1).max(200).optional().describe('Maximum conversation entries to return per page. Default: 20. Use 1 with around_uuid for full single-entry view without truncation.'),
      context_turns: z.number().int().min(1).max(20).optional().describe('When using around_uuid, number of conversation turns before and after to include. Default: 3.'),
      before_turns: z.number().int().min(0).max(20).optional().describe('When using around_uuid, number of conversation messages before the target. Overrides context_turns for the "before" direction.'),
      after_turns: z.number().int().min(0).max(20).optional().describe('When using around_uuid, number of conversation messages after the target. Overrides context_turns for the "after" direction.'),
      detail_level: z.enum(['conversation', 'compact', 'full', 'files', 'tools']).optional().describe('Output detail level. "conversation" (default): text + tool summary. "compact": condensed. "full": everything. "files": unique file paths accessed, grouped by action (read/write/search). "tools": tool usage counts with error indicators.'),
      entry_types: z.string().optional().describe('Comma-separated types to include. Default: "user,assistant,summary". Add "progress" if needed.'),
    }),
  },
  toolHandler('souvenir_read', (params, _ctx) => handleSouvenirRead(params)),
);

// --- souvenir_sessions ---
server.registerTool(
  'souvenir_sessions',
  {
    description: `List all conversation sessions for a project with their metadata (first prompt, summary, dates, entry count as souvenir_read pages them). Use this to find which session to search or read. Results are sorted by most recent first by default. Includes orphan sessions (transcript files not in the index).

Typical workflow: souvenir_projects → souvenir_sessions (pick a session) → souvenir_read or souvenir_search with session_id.

Pagination: Shows "Showing X/Y sessions" footer. Increase max_results to see more.`,
    annotations: READ_ONLY,
    inputSchema: z.object({
      project: z.string().optional().describe('Project directory name or path. Default: current project.'),
      search: z.string().optional().describe('Filter sessions where summary or firstPrompt contains this text (case-insensitive).'),
      date_from: z.string().optional().describe('Only sessions created after this ISO date.'),
      date_to: z.string().optional().describe('Only sessions created before this ISO date.'),
      sort: z.enum(['newest', 'oldest', 'messages']).optional().describe('Sort order. Default: "newest". "messages": most entries first.'),
      max_results: z.number().int().min(1).max(50).optional().describe('Maximum sessions to return. Default: 20.'),
      include_sidechains: z.boolean().optional().describe('Include sidechain/subagent sessions. Default: false.'),
    }),
  },
  toolHandler('souvenir_sessions', (params, _ctx) => handleSouvenirSessions(params)),
);

// --- souvenir_projects ---
server.registerTool(
  'souvenir_projects',
  {
    description: `List all Claude Code projects that have conversation history. Shows project path, directory name (used as identifier in other tools), number of sessions, and date range. The current project is marked with [current]. Projects whose original path no longer exists are marked [orphan].

Actions:
- "list" (default): Show all projects with status. Also detects orphaned index data (projects in the semantic index but no longer on disk).
- "clean": Remove index data for orphaned projects. Frees space in the semantic search database. Transcript files in ~/.claude/projects/ are preserved, but for a project whose transcripts Claude Code already deleted, the index is the last copy of its conversations. Asks the user to confirm when the client supports it.

Typical workflow: souvenir_projects → souvenir_sessions project="<dir_name>" → souvenir_read or souvenir_search.`,
    inputSchema: z.object({
      action: z.enum(['list', 'clean']).optional().describe('Default: "list". Use "clean" to remove orphaned project data from the semantic index.'),
      search: z.string().optional().describe('Filter projects whose path contains this text.'),
    }),
  },
  toolHandler('souvenir_projects', (params, ctx) => handleSouvenirProjects(params, confirm(ctx))),
);

// --- souvenir_index ---
server.registerTool(
  'souvenir_index',
  {
    description: `Manage the semantic search index that powers hybrid and semantic search modes. Without this index, only text mode works.

Indexing runs automatically in the background after each interaction. Use this tool to check status, force immediate indexing, or rebuild from scratch.

- "status": show what's indexed and which embedding model built it.
- "check": verify the configuration end to end (settings, embedding server, a test embedding, index compatibility). Use it when semantic search fails or after changing settings.
- "build": index new/updated sessions now (incremental).
- "rebuild": drop and re-index from scratch. After an embedding model change it resets the whole index (use project="all" to re-index every project now). First-time indexing may take several minutes. Asks the user to confirm when the client supports it.
- "vacuum": compact the database file to reclaim disk space from deleted data.`,
    inputSchema: z.object({
      action: z.enum(['status', 'check', 'build', 'rebuild', 'vacuum']).describe('"status": show indexing state. "check": verify configuration and embedding server. "build": incrementally index new content. "rebuild": drop and re-index everything. "vacuum": compact database file.'),
      project: z.string().optional().describe('Project to index. Default: current project. Use "all" for all projects.'),
      session_id: z.string().optional().describe('Index only a specific session.'),
    }),
  },
  toolHandler('souvenir_index', (params, ctx) => handleSouvenirIndex(params, ctx, confirm(ctx))),
);

// --- souvenir_docs ---
server.registerTool(
  'souvenir_docs',
  {
    description: `This tool powers souvenir_search source="code"/"docs"/"config"/"project". Without it, semantic code search has nothing to search through. Add project files here so you can then ask conceptual questions via souvenir_search ("where is auth checked?", "find deprecated patterns", "how does error handling work?") that Grep cannot answer.

The added files are also versioned: while Claude Code works, they are snapshotted at most every ~30 s, kept 3 days (files never added have no snapshots; "list" shows what is tracked). After a destructive action (bad checkout, accidental delete, broken refactor): "history", then "diff" the chosen snapshot against the current file to see what restoring would erase, then "restore" (it saves the current state as a snapshot first, so it can be undone).

Setup (once per project): "add" path="src" → "add" path="docs" → "build". After that, background indexing keeps everything up to date.

Actions — Setup: "add", "remove", "list", "build" (incremental), "clear".
Actions — Navigation: "status", "sections" (markdown TOC with line numbers).
Actions — Versioning: "history", "diff", "restore".
Actions — Maintenance: "vacuum" (compact DB).
"restore", "clear" and "build" with rebuild=true ask the user to confirm when the client supports it.

Categories auto-detected by extension: doc (.md, .txt), code (.ts, .py, .go...), config (.json, .yaml...). Override with category parameter.`,
    inputSchema: z.object({
      action: z.enum(['add', 'remove', 'list', 'status', 'build', 'clear', 'sections', 'history', 'diff', 'restore', 'vacuum']).describe('Action to perform.'),
      path: z.string().optional().describe('For "add"/"remove"/"sections"/"history"/"diff"/"restore": file or directory path relative to project root.'),
      pattern: z.string().optional().describe('For "add" with directory: glob pattern to filter files (e.g. "*.md", "*.{ts,js}"). Default: all supported extensions.'),
      category: z.enum(['doc', 'code', 'config']).optional().describe('Override auto-detection. Force all files from this source to a specific category.'),
      source_id: z.number().int().optional().describe('For "remove": source ID to remove (from "list" output).'),
      rebuild: z.boolean().optional().describe('For "build": drop and re-index everything. Default: false (incremental).'),
      snapshot_id: z.number().int().optional().describe('For "diff": compare this snapshot to current file. For "restore": snapshot ID to restore (from "history" output).'),
    }),
  },
  toolHandler('souvenir_docs', (params, ctx) => handleSouvenirDocs(params, confirm(ctx))),
);

// --- souvenir_tree ---
server.registerTool(
  'souvenir_tree',
  {
    description: `Get a clean, noise-free overview of the project structure in one call — no need to chain Glob, ls, or find. Use this FIRST when discovering a codebase, checking what exists in a directory, or understanding how a project is organized.

Unlike raw directory listings, this automatically hides noise (node_modules, .git, build, dist, __pycache__, .venv...) and selectively shows useful hidden dirs (.github, .vscode, .claude-plugin).

Key features beyond a simple tree:
- pattern: filter by extension ("*.ts", "*.{ts,js}") — shows only matching files, prunes empty dirs
- show_lines: see line counts per file — instantly spot where the main logic lives
- show_modified: see when files were last touched — understand what was recently worked on
- stats: get a stack breakdown by extension in the footer
- directories_only: high-level architecture overview

Output: Standard ASCII tree with connectors + file/directory count summary.`,
    annotations: READ_ONLY,
    _meta: LARGE_RESULT_META,
    inputSchema: z.object({
      path: z.string().optional().describe('Subdirectory to display (relative to project root). Default: project root.'),
      depth: z.number().int().min(1).max(10).optional().describe('Maximum depth to display. Default: 3.'),
      pattern: z.string().optional().describe('Filter files by pattern: "*.ts", "*.{ts,js}", or exact filename. Directories are shown only if they contain matching files.'),
      directories_only: z.boolean().optional().describe('Show only directories, no files. Default: false.'),
      show_lines: z.boolean().optional().describe('Show line count per file (e.g. "config.ts  (142L)"). Helps identify where the main logic lives. Default: false.'),
      show_modified: z.boolean().optional().describe('Show relative modification time per file (e.g. "2h ago"). Helps understand what was recently worked on. Default: false.'),
      stats: z.boolean().optional().describe('Add extension breakdown summary in footer (file count and total lines per extension). Default: false.'),
      max_files: z.number().int().min(1).max(10000).optional().describe('Maximum number of files to show. Directories are always shown. Truncated files show "N more files not shown". Prevents context flooding on large repos.'),
    }),
  },
  toolHandler('souvenir_tree', (params, _ctx) => handleSouvenirTree(params)),
);

registerSessionResources(server);
registerPrompts(server);

// --- Start server ---
async function main() {
  logger.info('Starting souvenir MCP server...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('souvenir MCP server running on stdio');
}

// --- Graceful shutdown ---
// When Claude Code exits, it sends SIGTERM/SIGINT to the MCP server process.
// Without cleanup: background indexing keeps the process alive (async I/O pending),
// SQLite WAL files remain locked, and deploy/restart fails with EPERM.

let _shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;

  logger.info(`Received ${signal}, shutting down...`);

  // 1. Stop accepting new background indexing work
  abortBackgroundIndex();

  // 2. Wait for in-progress indexing to finish current file (5s timeout)
  await waitForIndexing(5_000);

  // 3. Dispose embedding provider
  try {
    await disposeSingletonProvider();
  } catch (err) {
    logger.warn('Provider dispose error:', err);
  }

  // 4. Close database connections (releases WAL/SHM locks)
  try { closeDocsDb(); } catch (err) { logger.warn('DocsDb close error:', err); }
  try { closeDb(); } catch (err) { logger.warn('Db close error:', err); }

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
process.on('SIGHUP', () => { gracefulShutdown('SIGHUP'); });

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
