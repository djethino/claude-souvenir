import type { SQLInputValue } from 'node:sqlite';
import { existsSync, statSync as fsStatSync } from 'fs';
import { getDbPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import { CREATE_TABLES, SCHEMA_VERSION, CHUNK_VECTORS, LEGACY_VEC_TABLE, createChunkVectorsTable } from './schema.js';
import { type Db, openDatabase, inTransaction, vectorBlob, getRow } from './sqlite.js';
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
  content_text: string;
  embed_text: string;
  timestamp: string | null;
  line_number: number | null;
}

export interface VecSearchResult extends ChunkRow {
  distance: number;
}

export interface IndexStateRow {
  file_path: string;
  file_size: number;
  last_line: number;
  indexed_at: string;
}

let _db: Db | null = null;

/** Hint appended to index mismatch errors: a model change requires re-embedding everything. */
const REBUILD_HINT = 'rebuild it with souvenir_index action="rebuild" project="all" (re-embeds every indexed chunk)';

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
 * Which speakers a chunk contains (a "turn" is a user message plus the reply that follows it).
 * BigInt because sqlite-vec INTEGER columns reject JS numbers (bound as REAL).
 */
function chunkSpeakers(role: string | null, contentText: string): { hasUser: bigint; hasAssistant: bigint } {
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
        const rows = page.all(last) as unknown as ChunkRow[];
        if (rows.length === 0) break;
        for (const r of rows) {
          const id = BigInt(r.chunk_id);
          const vector = legacyVector.get(id) as { embedding: Uint8Array } | undefined;
          if (!vector || alreadyMoved.get(id)) continue;
          const { hasUser, hasAssistant } = chunkSpeakers(r.role, r.content_text);
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
 * Make the vector table usable for the given embedding identity before indexing.
 * - No index yet: create the vector table with the identity's size.
 * - Same identity: nothing to do.
 * - Different identity: throw IndexMismatchError, unless resetAll, which drops every vector and
 *   chunk (they all need re-embedding with the new model) and recreates the table.
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
      db.prepare('DELETE FROM chunks').run();
      db.prepare('DELETE FROM index_state').run();
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

/**
 * Insert chunks with their embeddings in a single transaction.
 */
export function insertChunks(
  chunks: Array<{
    session_id: string;
    project_dir: string;
    entry_uuid?: string;
    role?: string;
    content_text: string;
    embed_text: string;
    timestamp?: string;
    line_number?: number;
  }>,
  embeddings: Float32Array[],
): number {
  const db = getDb();

  if (chunks.length !== embeddings.length) {
    throw new Error(`Chunk count (${chunks.length}) doesn't match embedding count (${embeddings.length})`);
  }

  const insertChunk = db.prepare(`
    INSERT OR IGNORE INTO chunks (session_id, project_dir, entry_uuid, role, content_text, embed_text, timestamp, line_number)
    VALUES (@session_id, @project_dir, @entry_uuid, @role, @content_text, @embed_text, @timestamp, @line_number)
  `);

  const insertVec = db.prepare(`
    INSERT INTO ${CHUNK_VECTORS} (chunk_id, project_dir, session_id, role, has_user, has_assistant, timestamp, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;

  inTransaction(db, () => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = insertChunk.run({
        session_id: chunk.session_id,
        project_dir: chunk.project_dir,
        entry_uuid: chunk.entry_uuid || null,
        role: chunk.role || null,
        content_text: chunk.content_text,
        embed_text: chunk.embed_text,
        timestamp: chunk.timestamp || null,
        line_number: chunk.line_number ?? null,
      });

      if (result.changes > 0) {
        const { hasUser, hasAssistant } = chunkSpeakers(chunk.role ?? null, chunk.content_text);
        // sqlite-vec only accepts integer primary keys: a JS number binds as REAL, BigInt as INTEGER
        insertVec.run(
          BigInt(result.lastInsertRowid), chunk.project_dir, chunk.session_id, chunk.role ?? '',
          hasUser, hasAssistant, chunk.timestamp ?? '', vectorBlob(embeddings[i]),
        );
        inserted++;
      }
    }
  });

  return inserted;
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
 * Get index state for a file.
 */
export function getIndexState(filePath: string): IndexStateRow | null {
  const db = getDb();
  return getRow<IndexStateRow>(db, 'SELECT * FROM index_state WHERE file_path = ?', filePath);
}

/**
 * Update index state for a file.
 */
export function setIndexState(filePath: string, fileSize: number, lastLine: number): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO index_state (file_path, file_size, last_line, indexed_at)
    VALUES (?, ?, ?, ?)
  `).run(filePath, fileSize, lastLine, new Date().toISOString());
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
    fileCount: number;
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

  const projects = chunkStats.map((row) => {
    const lastIndexed = db.prepare(`
      SELECT MAX(indexed_at) as last
      FROM index_state
      WHERE file_path LIKE ?
    `).get(`%${row.project_dir}%`) as { last: string | null } | undefined;

    return {
      projectDir: row.project_dir,
      chunkCount: row.chunk_count,
      fileCount: 0, // computed below
      lastIndexed: lastIndexed?.last || null,
    };
  });

  const totalChunks = chunkStats.reduce((sum, r) => sum + r.chunk_count, 0);

  // Get DB file size
  const dbPath = getDbPath();
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = fsStatSync(dbPath).size;
  } catch { /* ignore */ }

  return {
    totalChunks,
    totalFiles: fileStats.total,
    projects,
    dbSizeBytes,
  };
}

/**
 * Clear all indexed data for a project.
 */
export function clearProject(projectDir: string): void {
  const db = getDb();

  inTransaction(db, () => {
    // Get chunk IDs to remove from vec table
    const chunkIds = db.prepare('SELECT chunk_id FROM chunks WHERE project_dir = ?')
      .all(projectDir) as Array<{ chunk_id: number }>;

    if (tableExists(db, CHUNK_VECTORS)) {
      const deleteVector = db.prepare(`DELETE FROM ${CHUNK_VECTORS} WHERE chunk_id = ?`);
      for (const { chunk_id } of chunkIds) {
        deleteVector.run(BigInt(chunk_id));
      }
    }

    db.prepare('DELETE FROM chunks WHERE project_dir = ?').run(projectDir);

    // Clear index state for files in this project
    db.prepare('DELETE FROM index_state WHERE file_path LIKE ?').run(`%${projectDir}%`);
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
