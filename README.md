# Claude Souvenir

MCP server plugin for Claude Code that provides semantic search across conversation history and project files.

## What It Does

Claude Souvenir gives Claude persistent memory across sessions:

- **Search past conversations** — Find what was discussed, decided, or built in any previous session
- **Search project files** — Index docs, code, and config files for semantic search within the current project
- **File versioning** — Automatic snapshots every ~30s when files change, with history browsing, diff, and restore (3-day retention)
- **Read session transcripts** — Browse or jump to specific moments in past conversations
- **Cross-project search** — Search across all projects or filter by project, date, role
- **Background indexing** — Automatically indexes new content via hooks (Stop, UserPromptSubmit, PostToolUse, PreCompact)

### Use Cases

| Scenario | How |
|----------|-----|
| "What did we decide about X?" | `souvenir_search query="decision about X"` |
| "Show me the session where we built the auth system" | `souvenir_search query="auth system implementation"` then `souvenir_read` |
| "Search my project documentation" | `souvenir_docs add path="docs"` then `souvenir_search source="docs" query="..."` |
| "What files were discussed in that session?" | `souvenir_read session_id="..." detail_level="full"` |
| "Find all sessions for this project" | `souvenir_sessions` |
| "Recover context after compaction" | `souvenir_search query="..." session_id="current"` |
| "Show me the project structure" | `souvenir_tree` or `souvenir_tree depth=2 stats=true` |
| "What TypeScript files exist in src?" | `souvenir_tree path="src" pattern="*.ts" show_lines=true` |
| "What versions of this file exist?" | `souvenir_docs action="history" path="src/index.ts"` |
| "What changed since the last snapshot?" | `souvenir_docs action="diff" path="src/index.ts"` |
| "Recover a file after a destructive action" | `souvenir_docs action="restore" path="src/index.ts" snapshot_id=5` |

## Installation

### Prerequisites

- **Ollama** running locally with the `embeddinggemma` model:
  ```bash
  ollama pull embeddinggemma
  ```

### From Marketplace

```bash
/plugin marketplace add djethino/asymptomatik-claude-plugins
/plugin install claude-souvenir
```

### From Plugin Repository

```bash
/plugin marketplace add djethino/claude-souvenir
/plugin install claude-souvenir
```

### Local Development

```bash
git clone https://github.com/djethino/claude-souvenir.git
cd claude-souvenir
npm install
npm run build
node deploy.js
# Restart Claude Code
```

### Skill

After installation, use `/claude-souvenir:souvenir-docs` to quickly add files to the index:

```
/souvenir-docs ./src
/souvenir-docs status
/souvenir-docs list
```

## MCP Tools

### souvenir_search

Search through transcripts and/or project files.

| Parameter | Description |
|-----------|-------------|
| `query` | Natural language search query |
| `mode` | `hybrid` (default), `semantic`, or `text` |
| `source` | `transcripts` (default), `docs`, `code`, `config`, `project`, `all` |
| `project` | Project filter. Default: current. Use `"all"` for all projects |
| `session_id` | Limit to a session. Use `"current"` for the active session |
| `role` | `user`, `assistant`, or `both` |
| `date_from` / `date_to` | ISO date range filter |
| `include_subagents` | Include subagent/sidechain transcripts |
| `max_results` | 1-50, default 10 |
| `offset` | Pagination offset |
| `case_sensitive` | For text mode |
| `regex` | For text mode: treat query as regex |

**Cross-referencing**: When searching transcripts, results include hints about matches in project docs (and vice versa).

### souvenir_read

Read conversation entries from a session transcript.

| Parameter | Description |
|-----------|-------------|
| `session_id` | Session UUID (from search results or `souvenir_sessions`) or `"current"` |
| `around_uuid` | Center output around a specific entry UUID from search results |
| `from_line` | Start from JSONL line number. Omit to read from the end (most recent) |
| `max_entries` | Entries per page (1-200, default 20) |
| `context_turns` | Turns before/after when using `around_uuid` (default 3) |
| `before_turns` / `after_turns` | Asymmetric context around target |
| `detail_level` | `conversation` (default), `compact`, or `full` |

Pagination hints are included in every response for navigation.

### souvenir_sessions

List all sessions for a project.

| Parameter | Description |
|-----------|-------------|
| `project` | Project filter |
| `search` | Filter by summary or first prompt text |
| `date_from` / `date_to` | Date range |
| `sort` | `newest` (default), `oldest`, or `messages` |
| `max_results` | 1-50, default 20 |
| `include_sidechains` | Include subagent sessions |

### souvenir_projects

List all projects with conversation history.

| Parameter | Description |
|-----------|-------------|
| `action` | `list` (default) or `clean` (remove orphaned index data) |
| `search` | Filter by path |

Detects orphaned projects (path no longer exists on disk) and orphaned index data.

### souvenir_index

Manage the semantic search index for transcripts.

| Parameter | Description |
|-----------|-------------|
| `action` | `status`, `build` (incremental), or `rebuild` (full re-index) |
| `project` | Project filter. Use `"all"` for all projects |
| `session_id` | Index a specific session only |

### souvenir_tree

Display the directory tree of the current project with smart defaults.

| Parameter | Description |
|-----------|-------------|
| `path` | Subdirectory to display (relative to project root). Default: project root |
| `depth` | Maximum depth 1-10. Default: 3 |
| `pattern` | Filter files by pattern: `"*.ts"`, `"*.{ts,js}"`, or exact filename. Directories with no matching files are pruned |
| `directories_only` | Show only directories, no files. Default: false |
| `show_lines` | Show line count per file (e.g. `config.ts  (142L)`). Default: false |
| `show_modified` | Show relative modification time (e.g. `2h ago`). Default: false |
| `stats` | Add extension breakdown in footer (count + total lines per extension). Default: false |
| `max_files` | Cap file output (1-10000). Directories always shown. Truncated count reported in footer |

**Skipped automatically**: `node_modules`, `.git`, `build`, `dist`, `__pycache__`, `.venv`, `.claude`, and other noise directories. Hidden dot-directories are skipped except `.claude-plugin`, `.github`, `.vscode`, `.husky`, `.circleci`, `.devcontainer`, `.docker`.

### souvenir_docs

Manage project file indexing (docs, code, config) and file versioning.

| Parameter | Description |
|-----------|-------------|
| `action` | `add`, `remove`, `list`, `status`, `build`, `clear`, `sections`, `history`, `diff`, `restore` |
| `path` | File or directory path (relative to project root) |
| `pattern` | Glob filter for directories (e.g. `"*.md"`) |
| `category` | Override auto-detection: `doc`, `code`, or `config` |
| `source_id` | For remove: source ID from list output |
| `rebuild` | For build: re-index everything |
| `snapshot_id` | For diff/restore: snapshot ID from history output |

**Sections**: Use `action="sections"` with a markdown file path to get the heading hierarchy with line numbers.

**File Versioning**: Indexed files are automatically snapshotted every ~30s when changes are detected during background indexing. Snapshots are stored in the project's docs DB with a 3-day retention period.

| Action | Description |
|--------|-------------|
| `history` | Show version history for a file (or list all versioned files if no path given) |
| `diff` | Compare a snapshot to the current file on disk. Defaults to latest snapshot if no `snapshot_id` |
| `restore` | Overwrite the file with a snapshot's content. A backup of the current state is saved automatically before restoring |

## Architecture

### Two-Database Design

- **Global DB** (`~/.claude/ASymptOmatik/souvenir/souvenir.db`) — Transcript index, shared across all projects
- **Local DB** (`<project>/.claude/ASymptOmatik/souvenir/docs.db`) — Project file index, per-project

All plugin data lives under `.claude/ASymptOmatik/`, the shared namespace for ASymptOmatik plugins. This follows Claude Code's own data partitioning: transcripts live in the user profile (`~/.claude/`), so the transcript index stays alongside them. Project file indexes stay in the project's `.claude/` directory. No project data leaks into the global store, no cross-project data leaks into a project folder.

### Embedding

- **Model**: EmbeddingGemma via Ollama (768 dimensions, BF16)
- **Asymmetric prefixes**: Documents get `"title: none | text: "`, queries get `"task: search result | query: "`
- **Vector search**: sqlite-vec with cosine distance

### Background Indexing

Hooks trigger background indexing on Stop, UserPromptSubmit, PostToolUse, and PreCompact events. Indexing runs asynchronously and does not block Claude's workflow.

> **First run note**: The first semantic search (or `souvenir_index build`) triggers an initial indexation of all existing transcripts for the current project. If you have a long conversation history, this can take several minutes depending on your hardware and the number of sessions. Subsequent runs are incremental and near-instant — only new content is indexed.

### Multi-Agent & Multi-Project

Souvenir is built for environments where multiple Claude instances work in parallel (subagents, concurrent sessions) and across multiple projects.

- **Global transcript index**: All sessions from all projects are indexed in a single database (`souvenir.db`). A search can span the current project, a specific project, or all projects — subagent and sidechain transcripts are included when `include_subagents=true`.
- **Per-project doc index**: Each project has its own `docs.db`. Project file indexes never leak across project boundaries. Workspaces with multiple projects each maintain independent doc indexes.
- **SQLite WAL mode**: Both databases use Write-Ahead Logging, which allows concurrent readers without blocking. Multiple agents can search simultaneously while background indexing writes new data.
- **Incremental indexing**: Each session's index state is tracked independently (`index_state` table). If a subagent creates a new session, background indexing picks it up automatically on the next hook trigger. No manual intervention needed.
- **Cross-agent visibility**: When one agent searches, it can find content from any other agent's sessions — decisions made in a subagent are discoverable from the main agent, and vice versa.

### Source Structure

```
src/
├── index.ts              # MCP server + tool definitions
├── config.ts             # Project detection + configuration
├── tools/
│   ├── search.ts         # souvenir_search handler
│   ├── read.ts           # souvenir_read handler
│   ├── sessions.ts       # souvenir_sessions handler
│   ├── projects.ts       # souvenir_projects handler
│   ├── index-mgmt.ts     # souvenir_index handler
│   ├── docs.ts           # souvenir_docs handler
│   └── tree.ts           # souvenir_tree handler
├── transcript/
│   ├── discovery.ts      # Project + session discovery
│   ├── parser.ts         # JSONL transcript parser
│   └── formatter.ts      # Output formatting + pagination
├── indexer/
│   ├── indexer.ts         # Transcript semantic indexer
│   └── background.ts     # Background indexing scheduler
├── docs/
│   ├── indexer.ts         # Project file indexer + snapshot capture
│   ├── store.ts           # Docs DB operations + snapshot CRUD
│   ├── diff.ts            # LCS-based unified diff (zero deps)
│   ├── schema.ts          # SQLite schema (v2: chunks, sections, snapshots)
│   └── chunker.ts         # File → chunk splitting by category
├── db/
│   ├── store.ts           # Global DB operations
│   └── embedding.ts       # Ollama embedding provider
├── search/
│   ├── text.ts            # Text/regex search engine
│   ├── semantic.ts        # Semantic vector search
│   └── hybrid.ts          # Hybrid scorer
└── utils/
    └── logger.ts          # Debug logging
```

## Technical Details

- **Language**: TypeScript (ESM, Node16 module resolution)
- **Runtime dependencies**: `@modelcontextprotocol/sdk`, `zod`, `better-sqlite3`, `sqlite-vec`
- **Node.js**: >= 18.0.0
- **Hook variable**: `${CLAUDE_PLUGIN_ROOT}` for path resolution
- **Auto-detected categories**: `.md .txt .rst .adoc` (doc), `.ts .js .py .go .rs .java .c .cpp .h .cs .rb .php .lua .sh .vue .svelte .css .html .xml .sql .gd` (code), `.json .yaml .yml .toml .ini .editorconfig` (config)

## Ecosystem

Souvenir is part of a plugin suite that addresses Claude's structural limitations at different layers.

| Layer | Plugin | Role |
|-------|--------|------|
| **Memory** | **claude-souvenir** (this plugin) | The *what*. Indexes conversations and project files for semantic search. Gives Claude access to everything that was said and done. |
| **Behavior** | **[claude-metacognition](https://github.com/djethino/claude-metacognition)** | The *when*. Injects reflection questions, preserves context after compaction, and nudges Claude to use souvenir at the right moments. |
| **Safety** | **[claude-code-safety-net](https://github.com/kenryu42/claude-code-safety-net)** | The *guardrail*. Blocks destructive commands (`rm -rf`, `git push --force`). |

### How souvenir and metacognition interact

Souvenir is a passive memory layer — it indexes and serves data, but never decides when Claude should search. That decision comes from metacognition, which detects souvenir's presence and:

- At **new session start**: injects a project tree and suggests `souvenir_search` for past work context
- After **context compaction**: reminds Claude that the summary is incomplete and that `souvenir_search` can recover lost discussions and decisions

This matters because compaction is exactly when Claude *most* needs memory assistance, but also when it's *least* likely to think of using it (tunnel vision on the summarized task). Metacognition provides that nudge.

Without metacognition, souvenir works fully — all MCP tools remain available. But Claude will rarely use them proactively after compaction, which is their primary value. Without souvenir, metacognition still provides reflection and context preservation, but loses the ability to recover deep context from past sessions.

## License

MIT — Copyright (c) 2025 ASymptOmatik
