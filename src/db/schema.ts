/**
 * SQLite schema for the souvenir vector database.
 */

/** 2: vectors moved to chunk_vectors (project partition + filter metadata), embedding identity. */
export const SCHEMA_VERSION = 2;

export const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chunks (
    chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_dir TEXT NOT NULL,
    entry_uuid TEXT,
    role TEXT,
    content_text TEXT NOT NULL,
    embed_text TEXT NOT NULL,
    timestamp TEXT,
    line_number INTEGER,
    UNIQUE(session_id, line_number)
  );

  CREATE TABLE IF NOT EXISTS index_state (
    file_path TEXT PRIMARY KEY,
    file_size INTEGER NOT NULL,
    last_line INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_dir);
  CREATE INDEX IF NOT EXISTS idx_chunks_role ON chunks(role);
  CREATE INDEX IF NOT EXISTS idx_chunks_timestamp ON chunks(timestamp);
`;

/** Vector table of schema 1 (no filter columns), migrated into CHUNK_VECTORS. */
export const LEGACY_VEC_TABLE = 'vec_chunks';

export const CHUNK_VECTORS = 'chunk_vectors';

/**
 * sqlite-vec table, created once the embedding size is known (run separately since it needs
 * the extension loaded). Search filters are columns of the vector table so that sqlite-vec
 * applies them during the KNN instead of after it: project_dir partitions the vectors, the
 * other columns are metadata. NULL is not allowed in metadata, '' stands for a missing timestamp.
 */
export function createChunkVectorsTable(dimensions: number): string {
  return `CREATE VIRTUAL TABLE ${CHUNK_VECTORS} USING vec0 (
    chunk_id INTEGER PRIMARY KEY,
    project_dir TEXT PARTITION KEY,
    session_id TEXT,
    role TEXT,
    has_user INTEGER,
    has_assistant INTEGER,
    timestamp TEXT,
    embedding float[${dimensions}] distance_metric=cosine
  );`;
}
