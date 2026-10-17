---
name: souvenir-init
description: Set up or change souvenir's semantic search (embedding server, model, database location), check that it works, and build the first index.
user-invocable: true
argument-hint: "[ollama | openai | change]"
---

# /souvenir-init — Set up semantic search

Guide the user through a working setup, in their language, one step at a time. Explain results in plain words; do not paste raw tool output.

## 1. Check the current setup

Call `souvenir_index action="check"`. It reports the effective settings, whether the embedding server answers, a test embedding, and whether the existing indexes match the current model.

- **Embedding OK and index compatible** → setup is fine. Say so, give the chunk count, and offer step 4 only if the user wants more projects indexed.
- **Embedding OK and index "not built yet"** → go to step 4.
- **Embedding FAILED** → step 2.
- **Index INCOMPATIBLE** → the settings changed since the index was built. Explain that searching needs either the previous settings back or a full re-embedding (step 4 with rebuild), and let the user choose.
- **Configuration error** → an option is invalid: show which one and go to step 3.

If `$ARGUMENTS` is `change`, `ollama` or `openai`, the user wants other settings: go to step 3 after the check.

## 2. Fix the embedding server

Default setup: a local [Ollama](https://ollama.com) server with the `embeddinggemma` model. Nothing leaves the machine.

- Ollama not installed: link https://ollama.com/download, ask the user to install and start it.
- Ollama installed but not answering: ask them to start it (`ollama serve`, or the Ollama app).
- The model is pulled automatically on first use; to avoid waiting later they can run `ollama pull embeddinggemma`.

Then run step 1 again. Offer step 3 if they prefer another server.

## 3. Change the settings

Settings are plugin options (`/plugin configure`). Ask only for what the user wants to change:

| Option | Meaning | Empty = |
|---|---|---|
| `embedding_provider` | `ollama` (Ollama API) or `openai` (any OpenAI-compatible `/v1/embeddings`: OpenAI, LM Studio, vLLM, llama.cpp server, Ollama's `/v1`) | `ollama` |
| `embedding_url` | Server base URL; for `openai` it ends in `/v1` | `http://localhost:11434` / `https://api.openai.com/v1` |
| `embedding_model` | Model name as the server knows it | `embeddinggemma` / `text-embedding-3-small` |
| `embedding_dimensions` | Shorter vectors, only for models that support it (OpenAI text-embedding-3, Matryoshka models) | native size |
| `embedding_api_key` | Only if the server requires a key | none |
| `db_path` | Absolute path of the transcript index database | `<Claude config dir>/ASymptOmatik/souvenir/souvenir.db` |

Known models get their recommended input prefixes automatically (embeddinggemma, nomic-embed-text, mxbai-embed-large, snowflake-arctic-embed, bge, e5, qwen3-embedding, all-minilm, granite-embedding, OpenAI text-embedding-3...). Other models work, embedded without prefixes.

Apply the values:

1. Find the plugin id: run `claude plugin list --json` and take the `id` of the entry named `asymptomatik-souvenir` (e.g. `asymptomatik-souvenir@asymptomatik`).
2. Non-sensitive values: run `claude plugin configure <id> --values-stdin` with a JSON object of strings on stdin, e.g. `{"embedding_provider": "openai", "embedding_url": "http://localhost:1234/v1", "embedding_model": "text-embedding-nomic-embed-text-v1.5"}`. An empty string `""` clears an option.
3. **API key: never put it in a command** (it would be stored in the conversation). Ask the user to run `/plugin configure <id>` themselves and type it in the dialog.
4. Ask the user to run `/reload-plugins` so the server restarts with the new settings, then go back to step 1.

Changing the provider, model or dimensions makes existing indexes incompatible: step 1 will say so.

## 4. Build the index

- Current project only (quick): `souvenir_index action="build"`.
- All projects: `souvenir_index action="build" project="all"`. It embeds every past conversation and can take a long time with a large history; ask before starting.
- After a model change (index INCOMPATIBLE): `souvenir_index action="rebuild" project="all"` re-embeds everything. Ask first and say it replaces the whole index.

Progress is reported while it runs; indexing then keeps itself up to date in the background after every interaction.

## 5. Wrap up

Tell the user what is set up and that they can now ask things like "what did we decide about X last week?"; `/asymptomatik-souvenir:souvenir-status` shows the state at any time, `/asymptomatik-souvenir:souvenir-docs` adds project files to the search.
