/**
 * SQLite schema for the souvenir database: the archive of every transcript (the source of truth,
 * Claude Code deletes its own files after a while) and the semantic index built from it.
 */

/**
 * 2: vectors moved to chunk_vectors (project partition + filter metadata), embedding identity.
 * 3: transcript archive (transcript_files, transcript_lines, transcript_attachments); chunks keep
 *    their whole text (no embed_text copy), a long one is embedded in several parts.
 * 4: chunks of archived transcripts keep no text: where it is in the archive (lines, characters),
 *    re-made from the archive when read (embedding/chunk-text.ts). content_text stays for the chunks
 *    of partial sessions (their only copy) and for chunks made before.
 */
export const SCHEMA_VERSION = 4;

/**
 * The chunks table. content_text: the chunk's text, or NULL when it is re-made from the archive:
 * the text of the exchange starting at line_number and ending at end_line, cut at
 * [text_start, text_end), by the chunker of format text_format.
 */
export function chunksTableSql(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
    chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_dir TEXT NOT NULL,
    entry_uuid TEXT,
    role TEXT,
    content_text TEXT,
    timestamp TEXT,
    line_number INTEGER,
    part INTEGER NOT NULL DEFAULT 0,
    end_line INTEGER,
    text_start INTEGER,
    text_end INTEGER,
    text_format INTEGER,
    UNIQUE(session_id, line_number, part)
  );`;
}

export const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  ${chunksTableSql('chunks')}

  CREATE TABLE IF NOT EXISTS index_state (
    file_path TEXT PRIMARY KEY,
    file_size INTEGER NOT NULL,
    last_line INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transcript_files (
    file_key TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    archived_bytes INTEGER NOT NULL DEFAULT 0,
    line_count INTEGER NOT NULL DEFAULT 0,
    entry_count INTEGER NOT NULL DEFAULT 0,
    first_timestamp TEXT,
    last_timestamp TEXT,
    first_prompt TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    custom_title TEXT NOT NULL DEFAULT '',
    git_branch TEXT NOT NULL DEFAULT '',
    project_path TEXT NOT NULL DEFAULT '',
    source_gone_at TEXT,
    error TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transcript_lines (
    file_key TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (file_key, line_number)
  );

  CREATE TABLE IF NOT EXISTS transcript_attachments (
    file_key TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL,
    session_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/** Indexes, created after the migrations (a migrated table is re-created without them). */
export const CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_dir);
  CREATE INDEX IF NOT EXISTS idx_chunks_role ON chunks(role);
  CREATE INDEX IF NOT EXISTS idx_chunks_timestamp ON chunks(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tfiles_session ON transcript_files(session_id);
  CREATE INDEX IF NOT EXISTS idx_tfiles_project ON transcript_files(project_dir);
  CREATE INDEX IF NOT EXISTS idx_tattach_session ON transcript_attachments(session_id);
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
