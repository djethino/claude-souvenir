# Claude Souvenir

MCP server plugin for Claude Code that provides semantic search across conversation history and project files.

## What It Does

Claude Souvenir gives Claude persistent memory across sessions:

- **Search past conversations** — Find what was discussed, decided, or built in any previous session
- **Search project files** — Index docs, code, and config files for semantic search within the current project
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

Manage project file indexing (docs, code, config).

| Parameter | Description |
|-----------|-------------|
| `action` | `add`, `remove`, `list`, `status`, `build`, `clear`, `sections` |
| `path` | File or directory to track (relative to project root) |
| `pattern` | Glob filter for directories (e.g. `"*.md"`) |
| `category` | Override auto-detection: `doc`, `code`, or `config` |
| `source_id` | For remove: source ID from list output |
| `rebuild` | For build: re-index everything |

**Sections**: Use `action="sections"` with a markdown file path to get the heading hierarchy with line numbers.

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
│   ├── indexer.ts         # Project file indexer
│   └── store.ts           # Docs DB operations
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
- **Auto-detected categories**: `.md .txt .rst` (doc), `.ts .js .py .go .rs .java .c .cpp .h` (code), `.json .yaml .yml .toml .env` (config)

## See Also

- **[claude-metacognition](https://github.com/djethino/claude-metacognition)** — Metacognitive reflection hooks: pre-task questions, post-task verification, post-compaction context. Complements souvenir with behavioral guidance.
- **[claude-code-safety-net](https://github.com/kenryu42/claude-code-safety-net)** — Blocks destructive commands. Security layer for Claude Code.

## License

MIT — Copyright (c) 2025 ASymptOmatik
