/**
 * SQLite schema for the local docs/code vector database.
 * Stored at <project>/.claude/ASymptOmatik/souvenir/docs.db
 */

/** 3: vectors moved to doc_chunk_vectors (category / file filter metadata), embedding identity. */
export const DOCS_SCHEMA_VERSION = 3;

export const DOCS_CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS doc_sources (
    source_id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('file', 'directory')),
    pattern TEXT,
    category TEXT CHECK(category IS NULL OR category IN ('doc', 'code', 'config')),
    recursive INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS doc_chunks (
    chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('doc', 'code', 'config')),
    content_text TEXT NOT NULL,
    embed_text TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    section_path TEXT,
    file_modified TEXT NOT NULL,
    UNIQUE(file_path, start_line)
  );

  CREATE TABLE IF NOT EXISTS doc_sections (
    section_id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    heading TEXT NOT NULL,
    level INTEGER NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER,
    section_path TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS doc_index_state (
    file_path TEXT PRIMARY KEY,
    file_size INTEGER NOT NULL,
    file_mtime TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS doc_snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_doc_chunks_file ON doc_chunks(file_path);
  CREATE INDEX IF NOT EXISTS idx_doc_chunks_category ON doc_chunks(category);
  CREATE INDEX IF NOT EXISTS idx_doc_sections_file ON doc_sections(file_path);
  CREATE INDEX IF NOT EXISTS idx_snapshots_path ON doc_snapshots(file_path);
  CREATE INDEX IF NOT EXISTS idx_snapshots_created ON doc_snapshots(created_at);
`;

/** Vector table of schema 2 (no filter columns), migrated into DOC_CHUNK_VECTORS. */
export const LEGACY_DOCS_VEC_TABLE = 'vec_doc_chunks';

export const DOC_CHUNK_VECTORS = 'doc_chunk_vectors';

/**
 * sqlite-vec table for doc embeddings, created once the embedding size is known. The search
 * filters are metadata columns so that sqlite-vec applies them during the KNN.
 */
export function createDocChunkVectorsTable(dimensions: number): string {
  return `CREATE VIRTUAL TABLE ${DOC_CHUNK_VECTORS} USING vec0 (
    chunk_id INTEGER PRIMARY KEY,
    category TEXT,
    file_path TEXT,
    embedding float[${dimensions}] distance_metric=cosine
  );`;
}
