---
name: souvenir-docs
description: Add project files (docs, code, config) to the souvenir semantic search index for the current project.
user-invocable: true
argument-hint: [path|list|status|build|sections <path>]
---

# /souvenir-docs — Index project files for semantic search

Index project documentation, code, and configuration files so they can be searched via `souvenir_search`.

## Behavior

Parse the arguments to determine the action:

- **A path** (`$ARGUMENTS` is a file or directory path): call `souvenir_docs action="add" path="$ARGUMENTS"`, then call `souvenir_docs action="build"` to index immediately.
- **`list`**: call `souvenir_docs action="list"` to show tracked sources.
- **`status`**: call `souvenir_docs action="status"` to show index statistics.
- **`build`**: call `souvenir_docs action="build"` to index new/changed files.
- **`sections <path>`**: call `souvenir_docs action="sections" path="<path>"` to show markdown heading hierarchy.
- **No arguments**: call `souvenir_docs action="list"`. If no sources exist, suggest common paths to add (docs/, src/, README.md).

## After adding and building

Inform the user they can now search with:
- `souvenir_search source="docs" query="..."` — search documentation
- `souvenir_search source="code" query="..."` — search code
- `souvenir_search source="project" query="..."` — search all project files
- `souvenir_search source="all" query="..."` — search everything (transcripts + project)
