# Souvenir

Claude Code plugin (`asymptomatik-souvenir`) that gives Claude a memory across sessions: search past conversations by meaning or by exact text, search your project files, and recover earlier versions of tracked files.

## Why

Claude Code has no memory between sessions. Every conversation starts from zero — previous decisions, discussions, and context are gone. The user ends up re-explaining the same things, and Claude ends up re-discovering what was already established.

After context compaction, it gets worse: the summary captures *what* was done but loses *why* — the trade-offs considered, the approaches rejected, the edge cases discovered along the way. Claude fills these gaps with plausible reasoning that may contradict what was actually decided.

| Without | With souvenir |
|---------|---------------|
| "We discussed this yesterday" → "I don't have access to previous conversations" | `souvenir_search` → answer in seconds |
| After compaction: lost decisions, re-does work | Full transcript searchable, recovers exact context |
| Indexed file overwritten by mistake → gone | Automatic snapshots, diff and restore for tracked files |
| New session on existing project → starts blind | Indexed project files, searchable by meaning not just keywords |

## What it does

- **Search past conversations** — what was discussed, decided or built, in this project or across all of them
- **Search project files** — index docs, code and config of the current project for search by meaning
- **File versioning** — automatic snapshots of tracked files, with history, diff and restore (3-day retention)
- **Read transcripts** — browse a past session or jump to the exact moment a search found
- **Stay up to date by itself** — new messages are indexed in the background as you work

## How it works

1. Claude Code already writes every conversation to `~/.claude/projects/` as transcript files.
2. After each interaction, a background hook reads what is new, splits it into chunks (one user message with its reply, or one standalone reply) and turns each chunk into a vector with an **embedding model**.
3. Vectors are stored in a local SQLite database with [sqlite-vec](https://github.com/asg017/sqlite-vec).
4. When Claude searches, the query is turned into a vector too, and the closest chunks are returned. The default **hybrid** mode combines this meaning-based search with exact text matching.

The embedding model runs on a server of your choice:

- **Ollama (default)** — a local [Ollama](https://ollama.com) server with the `embeddinggemma` model. Everything stays on your machine.
- **Any OpenAI-compatible API** — OpenAI, LM Studio, vLLM, a llama.cpp server, Ollama's `/v1` endpoint... Text chunks are then sent to that server.

Text search (`mode="text"`) never needs the embedding server.

## Requirements

- **Node.js >= 22.13** on your `PATH` (souvenir uses Node's built-in `node:sqlite`)
- Windows x64, Linux x64 or macOS (Intel and Apple Silicon). Linux arm64 is not supported yet (no sqlite-vec build).
- An embedding server: [install Ollama](https://ollama.com/download) for the default setup. The model is downloaded automatically on first use (or run `ollama pull embeddinggemma` beforehand).

## Installation

```
/plugin marketplace add djethino/asymptomatik-claude-plugins
/plugin install asymptomatik-souvenir@asymptomatik
```

Then run **`/asymptomatik-souvenir:souvenir-init`**: it checks the setup, helps fix or change it, and builds the first index.

> Upgrading from `claude-souvenir` (≤ 0.3): the plugin was renamed (Claude Code reserves the `claude-` prefix). Uninstall `claude-souvenir`, install `asymptomatik-souvenir`. Your index is kept and migrated automatically on first start (about a minute for a large history).

## Commands

| Command | What it does |
|---------|--------------|
| `/asymptomatik-souvenir:souvenir-init` | Guided setup: checks the embedding server, changes the settings with you, builds the first index |
| `/asymptomatik-souvenir:souvenir-status` | Settings, server health, index size and whether it matches the current model |
| `/asymptomatik-souvenir:souvenir-docs <path>` | Add project files to the search index (`list`, `status`, `build`, `sections <file>` also work) |

You can also just ask ("set up souvenir", "is souvenir working?"): Claude uses the same steps.

## Configuration

Souvenir works without configuration if Ollama runs locally. Settings are plugin options, changed with `/asymptomatik-souvenir:souvenir-init` or directly with `/plugin configure asymptomatik-souvenir@asymptomatik` (then `/reload-plugins`).

| Option | Default (empty) | Description |
|--------|-----------------|-------------|
| `embedding_provider` | `ollama` | `ollama` (Ollama API) or `openai` (any OpenAI-compatible `/v1/embeddings`) |
| `embedding_url` | `http://localhost:11434` · `https://api.openai.com/v1` | Server base URL; for `openai` it ends in `/v1` |
| `embedding_model` | `embeddinggemma` · `text-embedding-3-small` | Model name as the server knows it |
| `embedding_dimensions` | native size | Shorter vectors, only for models that support it (OpenAI text-embedding-3, Matryoshka models) |
| `embedding_api_key` | none | Only if the server requires one. Stored in your system's secure storage |
| `db_path` | `~/.claude/ASymptOmatik/souvenir/souvenir.db` | Absolute path of the transcript index |

Examples:

| Setup | Options |
|-------|---------|
| Ollama on another machine | `embedding_url` = `http://192.168.1.10:11434` |
| Another Ollama model | `embedding_model` = `nomic-embed-text` |
| LM Studio | `embedding_provider` = `openai`, `embedding_url` = `http://localhost:1234/v1`, `embedding_model` = the model id shown by LM Studio |
| OpenAI | `embedding_provider` = `openai`, `embedding_api_key` = your key |

**Models.** Many embedding models expect a prefix on documents and queries; souvenir adds the right one for known models: embeddinggemma, nomic-embed-text, mxbai-embed-large, snowflake-arctic-embed (v1, v2), bge-large, bge-m3, multilingual-e5 / e5, qwen3-embedding, all-minilm, granite-embedding, paraphrase-multilingual, OpenAI text-embedding-3. Other models work too, without prefix.

**Changing the model.** Vectors from different models (or sizes) cannot be compared. After changing the provider, model or dimensions, searches report that the index is incompatible until you either restore the previous settings or re-embed everything: `/asymptomatik-souvenir:souvenir-init` guides you, or ask Claude to run `souvenir_index action="rebuild" project="all"`.

## Usage

Ask Claude in plain words; it picks the tools. Some examples:

| Scenario | Tool call Claude makes |
|----------|------------------------|
| "What did we decide about X?" | `souvenir_search query="decision about X"` |
| "Show me the session where we built the auth system" | `souvenir_search query="auth system implementation"`, then `souvenir_read` |
| "Search my project documentation" | `souvenir_docs action="add" path="docs"`, then `souvenir_search source="docs" query="..."` |
| "Find all sessions for this project" | `souvenir_sessions` |
| "Recover context after compaction" | `souvenir_search query="..." session_id="current"` |
| "Show me the project structure" | `souvenir_tree` or `souvenir_tree depth=2 stats=true` |
| "What changed since the last snapshot?" | `souvenir_docs action="diff" path="src/index.ts"` |
| "Recover a file after a destructive action" | `souvenir_docs action="restore" path="src/index.ts" snapshot_id=5` |

The first semantic search in a project indexes its existing history; with a long history this takes a few minutes. Progress is shown; press **Esc** to stop waiting (indexing continues in the background) and use `mode="text"` meanwhile. Later searches are incremental and near-instant.

## MCP tools

### souvenir_search

Search through transcripts and/or project files.

| Parameter | Description |
|-----------|-------------|
| `query` | Natural language search query, exact term, function name, error message... |
| `mode` | `hybrid` (default), `semantic`, or `text` |
| `source` | `transcripts` (default), `docs`, `code`, `config`, `project`, `all` |
| `project` | Project filter. Default: current. Use `"all"` for all projects |
| `session_id` | Limit to a session. Use `"current"` for the active session |
| `role` | `user` (passages containing a user message), `assistant` (containing a reply), or `both` |
| `date_from` / `date_to` | ISO date range filter |
| `include_subagents` | Include subagent/sidechain transcripts |
| `max_results` | 1-50, default 10 |
| `offset` | Pagination offset |
| `case_sensitive` | For text mode |
| `regex` | For text mode: treat query as regex |

Filters are applied inside the vector search, so a filtered search still returns up to `max_results` matches. When hybrid search cannot run one of its halves (embedding server down, incompatible index), the answer says so and shows the other half. Results include hints about matches in the other source (transcripts ↔ project files).

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
| `detail_level` | `conversation` (default), `compact`, `full`, `files` or `tools` |

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

Manage the transcript index.

| Parameter | Description |
|-----------|-------------|
| `action` | `status`, `check` (settings, server, test embedding, index compatibility), `build` (incremental), `rebuild` (from scratch; after a model change it resets the whole index), `vacuum` (compact the database) |
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
| `action` | `add`, `remove`, `list`, `status`, `build`, `clear`, `sections`, `history`, `diff`, `restore`, `vacuum` |
| `path` | File or directory path (relative to project root) |
| `pattern` | Glob filter for directories (e.g. `"*.md"`) |
| `category` | Override auto-detection: `doc`, `code`, or `config` |
| `source_id` | For remove: source ID from list output |
| `rebuild` | For build: re-index everything (also adopts a new embedding model) |
| `snapshot_id` | For diff/restore: snapshot ID from history output |

**Sections**: `action="sections"` with a markdown file path gives the heading hierarchy with line numbers.

**File versioning**: indexed files are snapshotted when background indexing detects a change (at most every 30 s). Snapshots are kept 3 days.

| Action | Description |
|--------|-------------|
| `history` | Version history for a file (or all versioned files if no path given) |
| `diff` | Compare a snapshot to the current file on disk. Defaults to the latest snapshot |
| `restore` | Overwrite the file with a snapshot. The current state is backed up first |

## Privacy and data

- Everything souvenir stores is local:
  - **Transcript index**: `~/.claude/ASymptOmatik/souvenir/souvenir.db` (or `db_path`), shared by all projects
  - **Project file index and snapshots**: `<project>/.claude/ASymptOmatik/souvenir/docs.db`, one per project
- With the default Ollama setup, no text leaves your machine. With the `openai` provider, the text of indexed chunks and of your search queries is sent to the configured server.
- Deleting these files removes the indexes; they are rebuilt from the transcripts on the next search.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "semantic search unavailable", or the status command shows the embedding failing | Start Ollama (`ollama serve` or the Ollama app), or fix `embedding_url` / `embedding_model` / `embedding_api_key`. `souvenir_index action="check"` gives the exact error |
| "index was built with … but the current embedding settings give …" | Settings changed since indexing: restore them, or re-embed with `souvenir_index action="rebuild" project="all"` |
| "requires Node.js >= 22.13" | Update Node.js; Claude Code runs the plugin with the `node` on your `PATH` |
| "no sqlite-vec binary for linux-arm64" | Platform not supported yet; text search still works |
| Settings change has no effect | Run `/reload-plugins` (or restart Claude Code) after `/plugin configure` |
| First start after upgrading is slow | One-time migration of the index (about a minute for ~500k chunks) |

Set `SOUVENIR_LOG_LEVEL=info` (or `debug`) in your environment to get detailed logs on stderr (`claude --debug` writes them to `~/.claude/debug/`).

## Architecture

### Two databases

- **Global DB** (`~/.claude/ASymptOmatik/souvenir/souvenir.db`) — transcript index, shared across all projects
- **Local DB** (`<project>/.claude/ASymptOmatik/souvenir/docs.db`) — project file index and snapshots, per project

All plugin data lives under `.claude/ASymptOmatik/`, the shared namespace for ASymptOmatik plugins. Transcripts live in the user profile (`~/.claude/`), so the transcript index stays alongside them; project file indexes stay in the project's `.claude/` directory. No project data leaks into the global store, no cross-project data leaks into a project folder.

### Vector index

- Vectors live in sqlite-vec tables (`chunk_vectors`, `doc_chunk_vectors`) with cosine distance. Search filters are columns of the vector table (project as a partition key; session, speaker, timestamp, category, file as metadata), so sqlite-vec applies them while selecting the nearest vectors.
- Each index records the **embedding identity** it was built with (provider, model, vector size, prefixes). Searches and incremental indexing check it, so vectors from different models are never mixed.
- Vector size is measured from the model at startup, not configured.

### Background indexing

Hooks on Stop, UserPromptSubmit, PostToolUse and PreCompact start an asynchronous indexing run: at most one at a time across all sessions (PID lock), at least 30 s apart. It never blocks Claude.

### Multi-agent and multi-project

- **Global transcript index**: all sessions from all projects in one database; a search can span the current project, a specific one, or all — subagent transcripts included with `include_subagents=true`.
- **SQLite WAL mode**: several agents can search while background indexing writes.
- **Incremental indexing**: each transcript's progress is tracked (`index_state`); new sessions, including subagents', are picked up on the next hook.
- **Cross-agent visibility**: decisions made in a subagent are discoverable from the main agent, and vice versa.

### Source structure

```
src/
├── index.ts               # MCP server + tool definitions
├── background-index.ts    # Hook entry point: debounced background indexing
├── config.ts              # Project detection + effective configuration
├── options.ts             # Plugin options (userConfig) parsing
├── tools/                 # One handler per MCP tool (+ helpers.ts)
├── transcript/            # Project/session discovery, JSONL parser, formatting
├── indexer/background.ts  # In-server background indexing scheduler
├── db/
│   ├── sqlite.ts          # node:sqlite connection, sqlite-vec loading, transactions
│   ├── identity.ts        # Embedding identity of an index, vector table helpers
│   ├── schema.ts          # Transcript DB schema
│   ├── store.ts           # Transcript DB: migration, vectors, search
│   └── indexer.ts         # Transcript indexer
├── docs/                  # Project file index: schema, store, chunker, indexer, diff
├── embedding/
│   ├── provider.ts        # Provider interface + shared base (prefixes, size detection)
│   ├── models.ts          # Known models and their input prefixes
│   ├── ollama.ts          # Ollama provider (default)
│   ├── openai.ts          # OpenAI-compatible provider
│   └── chunker.ts         # Transcript → chunks
├── search/                # Text search, scoring, density boost
└── utils/                 # Logger, paths
```

## Development

```bash
git clone https://github.com/djethino/claude-souvenir.git
cd claude-souvenir
npm install
npm run build
```

Add the clone as a local marketplace (`/plugin marketplace add <path>`), install the plugin from it, and run `/reload-plugins` after each build.

`dist/` (bundled with esbuild, every npm dependency included) and `vendor/sqlite-vec/bin/` are **committed**: Claude Code installs plugins from git and never runs a build or install script. Run `npm run build` before every commit that touches `src/`; CI fails if `dist/` or the vendored binaries are out of date. The package version is the single source of truth: the build fails if `.claude-plugin/plugin.json` differs.

Technical details:

- TypeScript (ESM), bundled into `dist/index.js` (MCP server) and `dist/background-index.js` (hooks)
- No runtime dependency to install: `@modelcontextprotocol/sdk` and `zod` are bundled, SQLite is `node:sqlite`, sqlite-vec is vendored per platform (`vendor/sqlite-vec/README.md`)
- Auto-detected file categories: `.md .txt .rst .adoc` (doc), `.ts .tsx .js .jsx .mjs .cjs .py .go .rs .java .c .cpp .h .hpp .cs .rb .php .swift .kt .lua .sh .bash .ps1 .bat .vue .svelte .css .scss .less .html .xml .sql .graphql .gql .gd .gdshader` (code), `.json .yaml .yml .toml .ini .editorconfig` (config)

## Ecosystem

Souvenir is part of a plugin suite that addresses Claude's structural limitations at different layers.

| Layer | Plugin | Role |
|-------|--------|------|
| **Memory** | **asymptomatik-souvenir** (this plugin) | The *what*. Indexes conversations and project files for search. Gives Claude access to everything that was said and done. |
| **Behavior** | **[asymptomatik-metacognition](https://github.com/djethino/claude-metacognition)** | The *when*. Injects reflection questions, preserves context after compaction, and nudges Claude to use souvenir at the right moments. |
Souvenir is a passive memory layer — it indexes and serves data, but never decides when Claude should search. Metacognition detects souvenir and, at session start and after compaction, reminds Claude that past context can be recovered with `souvenir_search` — exactly when Claude most needs it and is least likely to think of it. Each plugin works without the other.

## License

MIT — Copyright (c) 2025 ASymptOmatik
