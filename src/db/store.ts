import type { SQLInputValue } from 'node:sqlite';
import { existsSync, statSync as fsStatSync } from 'fs';
import { isAbsolute, relative, sep } from 'path';
import { getDbPath, getProjectsDir } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import { CREATE_TABLES, CREATE_INDEXES, SCHEMA_VERSION, CHUNK_VECTORS, LEGACY_VEC_TABLE, chunksTableSql, createChunkVectorsTable } from './schema.js';
import { type Db, openDatabase, inTransaction, vectorBlob, getRow, allRows, iterateRows } from './sqlite.js';
import {
  IndexMismatchError, assertSameIdentity, deleteOrphanVectors, getStoredIdentity, migrateLegacyIdentity,
  setStoredIdentity, tableExists, vectorTableDimensions,
} from './identity.js';
import type { EmbeddingIdentity } from '../embedding/provider.js';

export interface ChunkRow {
  chunk_id: number;
  session_id: string;
  project_dir: string;
  entry_uuid: string | null;
  role: string | null;
  /**
   * The text embedded for this chunk (one part of a long exchange, see embedding/chunker.ts), or
   * null for a chunk of an archived transcript: its text is re-made from the archive
   * (embedding/chunk-text.ts) with the fields below.
   */
  content_text: string | null;
  timestamp: string | null;
  line_number: number | null;
  part: number;
  /** Last archive line of the exchange the chunk was cut from (null when content_text is kept) */
  end_line: number | null;
  /** Where the chunk is in the exchange's text: [text_start, text_end) */
  text_start: number | null;
  text_end: number | null;
  /** Chunker format that made the chunk (CHUNK_TEXT_FORMAT), null when content_text is kept */
  text_format: number | null;
}

/** A chunk whose text is known: kept in the database, or re-made from the archive. */
export type TextChunkRow = ChunkRow & { content_text: string };

export interface VecSearchResult extends ChunkRow {
  distance: number;
}

export interface IndexStateRow {
  /** Archived transcript (transcript_files.file_key) */
  file_path: string;
  file_size: number;
  last_line: number;
  indexed_at: string;
}

let _db: Db | null = null;

/** Hint appended to index mismatch errors: a model change requires re-embedding everything. */
const REBUILD_HINT = 'rebuild it with souvenir_index action="rebuild" project="all" (re-embeds every indexed chunk)';

/** Metadata key marking a project whose chunks lack vectors (kept through an embedding model change). */
const PENDING_VECTORS_KEY = 'pending_vectors:';

/**
 * Get or create the SQLite database connection. The vector table is created by
 * prepareVectorIndex() once the embedding size is known.
 */
export function getDb(): Db {
  if (_db) return _db;

  const db = openDatabase(getDbPath(), 'transcripts');
  try {
    db.exec(CREATE_TABLES);
    migrateLegacyIdentity(db);
    migrateLegacyVectors(db);
    migrateChunksTable(db);
    migrateIndexStateKeys(db);
    db.exec(CREATE_INDEXES);

    // Store schema version
    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  } catch (err) {
    // Keep no half-initialized connection: the next call retries from scratch
    db.close();
    throw err;
  }

  _db = db;
  logger.info('Database initialized');
  return db;
}

/**
 * Which speakers a chunk of schema 2 contains (a "turn" is a user message plus the reply that
 * follows it). BigInt because sqlite-vec INTEGER columns reject JS numbers (bound as REAL).
 */
function legacyChunkSpeakers(role: string | null, contentText: string): { hasUser: bigint; hasAssistant: bigint } {
  if (role === 'turn') return { hasUser: 1n, hasAssistant: contentText.includes('\nASSISTANT: ') ? 1n : 0n };
  if (role === 'assistant') return { hasUser: 0n, hasAssistant: 1n };
  return { hasUser: 0n, hasAssistant: 0n };
}

/**
 * Schema 1 kept vectors in vec_chunks without filter columns. Move them into chunk_vectors,
 * in one transaction (vec0 tables cannot be renamed). Also run when a session still on an older
 * version re-created vec_chunks after the migration: its rows are moved over the same way.
 */
function migrateLegacyVectors(db: Db): void {
  if (!tableExists(db, LEGACY_VEC_TABLE)) return;

  const legacyDims = vectorTableDimensions(db, LEGACY_VEC_TABLE);
  const currentDims = tableExists(db, CHUNK_VECTORS) ? vectorTableDimensions(db, CHUNK_VECTORS) : null;
  const started = Date.now();
  let moved = 0;

  inTransaction(db, () => {
    if (currentDims !== null && currentDims !== legacyDims) {
      // Written by an older version with other settings: not comparable with the current index
      logger.warn(`Dropping ${LEGACY_VEC_TABLE} (${legacyDims}d): incompatible with ${CHUNK_VECTORS} (${currentDims}d)`);
    } else {
      if (currentDims === null) db.exec(createChunkVectorsTable(legacyDims));
      const page = db.prepare('SELECT chunk_id, project_dir, session_id, role, timestamp, content_text FROM chunks WHERE chunk_id > ? ORDER BY chunk_id LIMIT 5000');
      const legacyVector = db.prepare(`SELECT embedding FROM ${LEGACY_VEC_TABLE} WHERE chunk_id = ?`);
      const alreadyMoved = db.prepare(`SELECT chunk_id FROM ${CHUNK_VECTORS} WHERE chunk_id = ?`);
      const insert = db.prepare(`INSERT INTO ${CHUNK_VECTORS} (chunk_id, project_dir, session_id, role, has_user, has_assistant, timestamp, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (let last = 0; ;) {
        const rows = page.all(last) as unknown as TextChunkRow[]; // schema 1 chunks all have their text
        if (rows.length === 0) break;
        for (const r of rows) {
          const id = BigInt(r.chunk_id);
          const vector = legacyVector.get(id) as { embedding: Uint8Array } | undefined;
          if (!vector || alreadyMoved.get(id)) continue;
          const { hasUser, hasAssistant } = legacyChunkSpeakers(r.role, r.content_text);
          insert.run(id, r.project_dir, r.session_id, r.role ?? '', hasUser, hasAssistant, r.timestamp ?? '', vector.embedding);
          moved++;
        }
        last = rows[rows.length - 1].chunk_id;
      }
      const orphans = deleteOrphanVectors(db, CHUNK_VECTORS, 'chunks');
      if (orphans > 0) logger.info(`Deleted ${orphans} vectors of chunks that no longer exist`);
    }
    db.exec(`DROP TABLE ${LEGACY_VEC_TABLE}`);
  });

  // The copy went through the WAL and freed the old table's pages: give the space back
  db.exec('PRAGMA incremental_vacuum');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  logger.info(`Moved ${moved} vectors from ${LEGACY_VEC_TABLE} to ${CHUNK_VECTORS} in ${Date.now() - started} ms`);
}

/**
 * Re-create the chunks table of an older schema in the current form, keeping every chunk and its
 * chunk_id so that the vectors stay attached to their chunks:
 * - schema 2 kept a second, shorter copy of the text (embed_text, dropped) and had no part number;
 * - schema 3 required content_text; chunks now made from the archive keep no text.
 * The chunks kept keep their text (content_text).
 */
function migrateChunksTable(db: Db): void {
  const columns = allRows<{ name: string }>(db, 'PRAGMA table_info(chunks)').map((c) => c.name);
  if (columns.includes('text_format')) return;

  const started = Date.now();
  const part = columns.includes('part') ? 'part' : '0';
  inTransaction(db, () => {
    db.exec(`
      ${chunksTableSql('chunks_new')}
      INSERT INTO chunks_new (chunk_id, session_id, project_dir, entry_uuid, role, content_text, timestamp, line_number, part)
        SELECT chunk_id, session_id, project_dir, entry_uuid, role, content_text, timestamp, line_number, ${part} FROM chunks;
      DROP TABLE chunks;
      ALTER TABLE chunks_new RENAME TO chunks;
    `);
    // Ids above the highest kept one may be reused: no vector may remain for them
    if (tableExists(db, CHUNK_VECTORS)) {
      const orphans = deleteOrphanVectors(db, CHUNK_VECTORS, 'chunks');
      if (orphans > 0) logger.info(`Deleted ${orphans} vectors of chunks that no longer exist`);
    }
  });
  db.exec('PRAGMA incremental_vacuum');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  logger.info(`Chunks table migrated to schema ${SCHEMA_VERSION} in ${Date.now() - started} ms`);
}

/**
 * Schema 2 keyed the index progress by the transcript's absolute path; it is now keyed by the
 * archived transcript (path relative to the projects folder), whose line numbers are the same.
 */
function migrateIndexStateKeys(db: Db): void {
  const rows = allRows<{ file_path: string }>(db, 'SELECT file_path FROM index_state').filter((r) => isAbsolute(r.file_path));
  if (rows.length === 0) return;
  const projectsDir = getProjectsDir();
  const rename = db.prepare('UPDATE OR REPLACE index_state SET file_path = ? WHERE file_path = ?');
  inTransaction(db, () => {
    for (const { file_path } of rows) {
      rename.run(relative(projectsDir, file_path).split(sep).join('/'), file_path);
    }
  });
  logger.info(`Index progress of ${rows.length} transcripts keyed by archive path`);
}

/**
 * Make the vector table usable for the given embedding identity before indexing.
 * - No index yet: create the vector table with the identity's size.
 * - Same identity: nothing to do.
 * - Different identity: throw IndexMismatchError, unless resetAll, which drops every vector (they
 *   all need re-embedding with the new model) and recreates the table. Chunks of archived
 *   transcripts are deleted (re-created from the archive); the chunks of partial sessions are the
 *   only trace of them and are kept, marked to be embedded again (see getChunksWithoutVectors).
 */
export function prepareVectorIndex(identity: EmbeddingIdentity, options: { resetAll?: boolean } = {}): void {
  const db = getDb();
  const stored = getStoredIdentity(db);
  if (!options.resetAll) {
    assertSameIdentity(stored, identity, 'transcript', REBUILD_HINT);
  }

  inTransaction(db, () => {
    if (options.resetAll) {
      if (tableExists(db, CHUNK_VECTORS)) db.exec(`DROP TABLE ${CHUNK_VECTORS}`);
      db.exec('DELETE FROM chunks WHERE session_id IN (SELECT session_id FROM transcript_files)');
      db.exec('DELETE FROM index_state');
      const markPending = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
      for (const { project_dir } of allRows<{ project_dir: string }>(db, 'SELECT DISTINCT project_dir FROM chunks')) {
        markPending.run(PENDING_VECTORS_KEY + project_dir, new Date().toISOString());
      }
    }
    if (!tableExists(db, CHUNK_VECTORS)) db.exec(createChunkVectorsTable(identity.dimensions));
    setStoredIdentity(db, identity);
  });
}

/**
 * Throw when the transcript index cannot be searched with the given identity: no index yet,
 * or built with other embedding settings.
 */
export function assertSearchable(identity: EmbeddingIdentity): void {
  const db = getDb();
  const stored = getStoredIdentity(db);
  if (!stored || !tableExists(db, CHUNK_VECTORS)) {
    throw new IndexMismatchError('No semantic index found. Run souvenir_index with action="build" first to create the index.');
  }
  assertSameIdentity(stored, identity, 'transcript', REBUILD_HINT);
}

/** Identity the transcript index was built with, or null when there is none. */
export function getIndexIdentity(): EmbeddingIdentity | null {
  return getStoredIdentity(getDb());
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export interface NewChunk {
  session_id: string;
  project_dir: string;
  entry_uuid?: string;
  role: string;
  /** Text to embed; not stored: it is re-made from the archive with the fields below */
  content_text: string;
  timestamp?: string;
  line_number: number;
  part: number;
  end_line: number;
  text_start: number;
  text_end: number;
  text_format: number;
  hasUser: boolean;
  hasAssistant: boolean;
}

/**
 * Insert chunks with their embeddings in a single transaction. Their text is not stored: the
 * archive holds it (see embedding/chunk-text.ts).
 */
export function insertChunks(chunks: NewChunk[], embeddings: Float32Array[]): number {
  const db = getDb();

  if (chunks.length !== embeddings.length) {
    throw new Error(`Chunk count (${chunks.length}) doesn't match embedding count (${embeddings.length})`);
  }

  const insertChunk = db.prepare(`
    INSERT OR IGNORE INTO chunks (session_id, project_dir, entry_uuid, role, timestamp, line_number, part, end_line, text_start, text_end, text_format)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;

  inTransaction(db, () => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = insertChunk.run(
        chunk.session_id, chunk.project_dir, chunk.entry_uuid || null, chunk.role,
        chunk.timestamp || null, chunk.line_number, chunk.part,
        chunk.end_line, chunk.text_start, chunk.text_end, chunk.text_format,
      );

      if (result.changes > 0) {
        insertVector(db, BigInt(result.lastInsertRowid), chunk, chunk.hasUser, chunk.hasAssistant, embeddings[i]);
        inserted++;
      }
    }
  });

  return inserted;
}

/** sqlite-vec only accepts integer primary keys: a JS number binds as REAL, BigInt as INTEGER. */
function insertVector(
  db: Db,
  chunkId: bigint,
  chunk: { project_dir: string; session_id: string; role: string | null; timestamp?: string | null },
  hasUser: boolean,
  hasAssistant: boolean,
  embedding: Float32Array,
): void {
  db.prepare(`
    INSERT INTO ${CHUNK_VECTORS} (chunk_id, project_dir, session_id, role, has_user, has_assistant, timestamp, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chunkId, chunk.project_dir, chunk.session_id, chunk.role ?? '',
    hasUser ? 1n : 0n, hasAssistant ? 1n : 0n, chunk.timestamp ?? '', vectorBlob(embedding),
  );
}

/** Whether an embedding model change left chunks of this project without vectors (see prepareVectorIndex). */
export function hasPendingVectors(projectDir: string): boolean {
  return getRow(getDb(), 'SELECT 1 AS pending FROM metadata WHERE key = ?', PENDING_VECTORS_KEY + projectDir) !== null;
}

/**
 * One page of a project's chunks, in chunk id order after afterChunkId: those without a vector,
 * and the last chunk id of the page (null when the pages are done).
 */
export function getChunksWithoutVectors(projectDir: string, afterChunkId: number, limit: number): { missing: ChunkRow[]; lastChunkId: number | null } {
  const db = getDb();
  const page = allRows<ChunkRow>(db, 'SELECT * FROM chunks WHERE project_dir = ? AND chunk_id > ? ORDER BY chunk_id LIMIT ?', projectDir, afterChunkId, limit);
  if (page.length === 0) return { missing: [], lastChunkId: null };
  const hasVector = db.prepare(`SELECT 1 FROM ${CHUNK_VECTORS} WHERE chunk_id = ?`);
  return { missing: page.filter((c) => !hasVector.get(BigInt(c.chunk_id))), lastChunkId: page[page.length - 1].chunk_id };
}

/** Give vectors to existing chunks (re-embedded after a model change). */
export function insertVectors(chunks: TextChunkRow[], embeddings: Float32Array[]): void {
  const db = getDb();
  inTransaction(db, () => {
    chunks.forEach((c, i) => {
      const { hasUser, hasAssistant } = legacyChunkSpeakers(c.role, c.content_text);
      insertVector(db, BigInt(c.chunk_id), c, hasUser === 1n, hasAssistant === 1n, embeddings[i]);
    });
  });
}

/** The project's chunks all have vectors again. */
export function clearPendingVectors(projectDir: string): void {
  getDb().prepare('DELETE FROM metadata WHERE key = ?').run(PENDING_VECTORS_KEY + projectDir);
}

/**
 * Search for similar chunks using vector KNN. Filters are applied by sqlite-vec while it selects
 * the k nearest vectors (partition + metadata columns), so a filtered search still returns up to
 * topK matching chunks. Throws IndexMismatchError when the index was built with another identity.
 */
export function searchSemantic(
  identity: EmbeddingIdentity,
  queryEmbedding: Float32Array,
  options: {
    topK?: number;
    projectDir?: string;
    sessionId?: string;
    /** Only chunks containing a message from this speaker */
    speaker?: 'user' | 'assistant';
    dateFrom?: string;
    dateTo?: string;
  } = {},
): VecSearchResult[] {
  assertSearchable(identity);
  const db = getDb();
  const filters: string[] = [];
  const params: SQLInputValue[] = [vectorBlob(queryEmbedding), options.topK || 10];

  if (options.projectDir) { filters.push('project_dir = ?'); params.push(options.projectDir); }
  if (options.sessionId) { filters.push('session_id = ?'); params.push(options.sessionId); }
  if (options.speaker === 'user') filters.push('has_user = 1');
  if (options.speaker === 'assistant') filters.push('has_assistant = 1');
  // '' marks chunks without timestamp: a date filter excludes them, as SQL NULL would
  if (options.dateFrom || options.dateTo) filters.push("timestamp != ''");
  if (options.dateFrom) { filters.push('timestamp >= ?'); params.push(options.dateFrom); }
  if (options.dateTo) { filters.push('timestamp <= ?'); params.push(options.dateTo); }

  return db.prepare(`
    SELECT c.*, v.distance
    FROM (
      SELECT chunk_id, distance FROM ${CHUNK_VECTORS}
      WHERE embedding MATCH ? AND k = ?${filters.map((f) => ` AND ${f}`).join('')}
    ) v
    JOIN chunks c ON c.chunk_id = v.chunk_id
    ORDER BY v.distance
  `).all(...params) as unknown as VecSearchResult[];
}

/**
 * Every chunk of a partial session, in transcript order: the only content left of it. Its chunks
 * keep their text (only chunks of archived transcripts are re-made from the archive).
 */
export function getSessionChunks(projectDir: string, sessionId: string): TextChunkRow[] {
  return allRows<TextChunkRow>(getDb(), 'SELECT * FROM chunks WHERE project_dir = ? AND session_id = ? AND content_text IS NOT NULL ORDER BY line_number, part', projectDir, sessionId);
}

/**
 * Chunks of the partial sessions of a project (sessions with no archived transcript) whose text
 * matches, one at a time: LIKE for plain text (case-insensitive for ASCII), every chunk when the
 * caller filters them itself (regex, case-insensitive text beyond ASCII).
 */
export function iteratePartialSessionChunks(projectDir: string, likePattern: string | null): Generator<TextChunkRow> {
  const archived = 'session_id NOT IN (SELECT session_id FROM transcript_files WHERE project_dir = ?) AND content_text IS NOT NULL';
  return likePattern === null
    ? iterateRows<TextChunkRow>(getDb(), `SELECT * FROM chunks WHERE project_dir = ? AND ${archived}`, projectDir, projectDir)
    : iterateRows<TextChunkRow>(getDb(), `SELECT * FROM chunks WHERE project_dir = ? AND ${archived} AND content_text LIKE ? ESCAPE '\\'`, projectDir, projectDir, likePattern);
}

/**
 * Get index state for an archived transcript.
 */
export function getIndexState(fileKey: string): IndexStateRow | null {
  const db = getDb();
  return getRow<IndexStateRow>(db, 'SELECT * FROM index_state WHERE file_path = ?', fileKey);
}

/**
 * Update index state for an archived transcript.
 */
export function setIndexState(fileKey: string, archivedBytes: number, lastLine: number): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO index_state (file_path, file_size, last_line, indexed_at)
    VALUES (?, ?, ?, ?)
  `).run(fileKey, archivedBytes, lastLine, new Date().toISOString());
}

/**
 * Get aggregate index status.
 */
export function getIndexStatus(projectDir?: string): {
  totalChunks: number;
  totalFiles: number;
  projects: Array<{
    projectDir: string;
    chunkCount: number;
    lastIndexed: string | null;
  }>;
  dbSizeBytes: number;
} {
  const db = getDb();

  const projectFilter = projectDir ? 'WHERE project_dir = ?' : '';
  const params = projectDir ? [projectDir] : [];

  const chunkStats = db.prepare(`
    SELECT project_dir, COUNT(*) as chunk_count
    FROM chunks ${projectFilter}
    GROUP BY project_dir
  `).all(...params) as Array<{ project_dir: string; chunk_count: number }>;

  const fileStats = db.prepare(`
    SELECT COUNT(*) as total FROM index_state
  `).get() as { total: number };

  const lastIndexedOf = db.prepare("SELECT MAX(indexed_at) as last FROM index_state WHERE file_path LIKE ? ESCAPE '\\'");
  const projects = chunkStats.map((row) => ({
    projectDir: row.project_dir,
    chunkCount: row.chunk_count,
    lastIndexed: (lastIndexedOf.get(`${escapeLike(row.project_dir)}/%`) as { last: string | null } | undefined)?.last || null,
  }));

  const totalChunks = chunkStats.reduce((sum, r) => sum + r.chunk_count, 0);

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = fsStatSync(getDbPath()).size;
  } catch { /* not created yet */ }

  return {
    totalChunks,
    totalFiles: fileStats.total,
    projects,
    dbSizeBytes,
  };
}

/** A string matched literally by LIKE … ESCAPE '\'. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Delete the chunks of a project's archived transcripts and their index progress, to re-create
 * them from the archive (rebuild). The chunks of partial sessions are kept: nothing can re-create
 * them.
 */
export function clearArchivedChunks(projectDir: string, sessionId?: string): void {
  const db = getDb();
  const sessionFilter = sessionId ? 'AND session_id = ?' : '';
  const params = sessionId ? [projectDir, projectDir, sessionId] : [projectDir, projectDir];

  inTransaction(db, () => {
    const chunkIds = allRows<{ chunk_id: number }>(db, `
      SELECT chunk_id FROM chunks
      WHERE project_dir = ? AND session_id IN (SELECT session_id FROM transcript_files WHERE project_dir = ?) ${sessionFilter}`, ...params);
    if (tableExists(db, CHUNK_VECTORS)) {
      const deleteVector = db.prepare(`DELETE FROM ${CHUNK_VECTORS} WHERE chunk_id = ?`);
      for (const { chunk_id } of chunkIds) deleteVector.run(BigInt(chunk_id));
    }
    const deleteChunk = db.prepare('DELETE FROM chunks WHERE chunk_id = ?');
    for (const { chunk_id } of chunkIds) deleteChunk.run(chunk_id);

    if (sessionId) {
      db.prepare('DELETE FROM index_state WHERE file_path IN (SELECT file_key FROM transcript_files WHERE project_dir = ? AND (session_id = ? OR parent_session_id = ?))')
        .run(projectDir, sessionId, sessionId);
    } else {
      db.prepare('DELETE FROM index_state WHERE file_path IN (SELECT file_key FROM transcript_files WHERE project_dir = ?)').run(projectDir);
    }
  });

  incrementalVacuum();
}

/**
 * Delete everything souvenir kept of a project: archived transcripts and files, chunks, vectors.
 * For a project whose transcripts Claude Code deleted, this is the last copy of its conversations:
 * only on the user's explicit request (souvenir_projects action="clean").
 */
export function deleteProject(projectDir: string): void {
  const db = getDb();

  inTransaction(db, () => {
    const chunkIds = allRows<{ chunk_id: number }>(db, 'SELECT chunk_id FROM chunks WHERE project_dir = ?', projectDir);
    if (tableExists(db, CHUNK_VECTORS)) {
      const deleteVector = db.prepare(`DELETE FROM ${CHUNK_VECTORS} WHERE chunk_id = ?`);
      for (const { chunk_id } of chunkIds) deleteVector.run(BigInt(chunk_id));
    }
    db.prepare('DELETE FROM chunks WHERE project_dir = ?').run(projectDir);
    db.prepare('DELETE FROM index_state WHERE file_path IN (SELECT file_key FROM transcript_files WHERE project_dir = ?)').run(projectDir);
    db.prepare('DELETE FROM transcript_lines WHERE file_key IN (SELECT file_key FROM transcript_files WHERE project_dir = ?)').run(projectDir);
    db.prepare('DELETE FROM transcript_files WHERE project_dir = ?').run(projectDir);
    db.prepare('DELETE FROM transcript_attachments WHERE project_dir = ?').run(projectDir);
    db.prepare('DELETE FROM metadata WHERE key = ?').run(PENDING_VECTORS_KEY + projectDir);
  });

  incrementalVacuum();
}

/**
 * Reclaim disk space from deleted rows (incremental auto-vacuum).
 */
export function incrementalVacuum(): void {
  try {
    const db = getDb();
    db.exec('PRAGMA incremental_vacuum');
  } catch (err) {
    logger.error('Incremental vacuum error:', err);
  }
}

/**
 * Full VACUUM — compacts the entire database. Slower but reclaims all free space.
 */
export function fullVacuum(): void {
  const db = getDb();
  db.exec('VACUUM');
}

/**
 * Get the number of indexed chunks for a project.
 * Does NOT create the DB if it doesn't exist — returns 0 silently.
 */
export function getProjectChunkCount(projectDir: string): number {
  try {
    const dbPath = getDbPath();
    if (!existsSync(dbPath)) return 0;
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as cnt FROM chunks WHERE project_dir = ?').get(projectDir) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}
