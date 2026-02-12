/**
 * SQLite schema for the souvenir vector database.
 */

export const SCHEMA_VERSION = 1;

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

/**
 * sqlite-vec virtual table creation (run separately since it needs the extension loaded).
 */
export function createVecTable(dimensions: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0 (
    chunk_id INTEGER PRIMARY KEY,
    embedding float[${dimensions}] distance_metric=cosine
  );`;
}
