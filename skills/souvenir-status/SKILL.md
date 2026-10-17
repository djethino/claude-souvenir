---
name: souvenir-status
description: Show souvenir's semantic search state - settings, embedding server health, index size and compatibility.
user-invocable: true
---

# /souvenir-status — Semantic search state

1. Call `souvenir_index action="check"` (settings, server, test embedding, index compatibility).
2. Call `souvenir_index action="status"` (chunks per project, last indexing).

Summarize for the user in their language, in a few lines:

- Embedding: provider, model, server URL, OK or failing (with the reason).
- Transcript index: chunks, projects indexed, built with which model, compatible or not.
- Docs index of this project, if any.

If something is wrong (server down, configuration error, incompatible index), say what it means and suggest `/asymptomatik-souvenir:souvenir-init` to fix it. Do not change anything yourself.
