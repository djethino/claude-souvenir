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

- **Global DB** (`~/.claude/claude-souvenir/souvenir.db`) — Transcript index, shared across all projects
- **Local DB** (`<project>/.souvenir/docs.db`) — Project file index, per-project

### Embedding

- **Model**: EmbeddingGemma via Ollama (768 dimensions, BF16)
- **Asymmetric prefixes**: Documents get `"title: none | text: "`, queries get `"task: search result | query: "`
- **Vector search**: sqlite-vec with cosine distance

### Background Indexing

Hooks trigger background indexing on Stop, UserPromptSubmit, PostToolUse, and PreCompact events. Indexing runs asynchronously and does not block Claude's workflow.

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
│   └── docs.ts           # souvenir_docs handler
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
