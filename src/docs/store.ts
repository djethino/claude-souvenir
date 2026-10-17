import type { SQLInputValue } from 'node:sqlite';
import { existsSync, statSync as fsStatSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { type Db, openDatabase, inTransaction, vectorBlob, getRow, allRows } from '../db/sqlite.js';
import {
  IndexMismatchError, assertSameIdentity, deleteOrphanVectors, getStoredIdentity, migrateLegacyIdentity,
  setStoredIdentity, tableExists, vectorTableDimensions,
} from '../db/identity.js';
import type { EmbeddingIdentity } from '../embedding/provider.js';
import {
  DOCS_CREATE_TABLES, DOCS_SCHEMA_VERSION, DOC_CHUNK_VECTORS, LEGACY_DOCS_VEC_TABLE, createDocChunkVectorsTable,
} from './schema.js';

export type DocCategory = 'doc' | 'code' | 'config';

export interface DocSourceRow {
  source_id: number;
  path: string;
  type: 'file' | 'directory';
  pattern: string | null;
  category: DocCategory | null;
  recursive: number;
  added_at: string;
}

export interface DocChunkRow {
  chunk_id: number;
  file_path: string;
  category: DocCategory;
  content_text: string;
  embed_text: string;
  start_line: number;
  end_line: number;
  section_path: string | null;
  file_modified: string;
}

export interface DocVecSearchResult extends DocChunkRow {
  distance: number;
}

export interface DocSectionRow {
  section_id: number;
  file_path: string;
  heading: string;
  level: number;
  start_line: number;
  end_line: number | null;
  section_path: string;
}

export interface DocIndexStateRow {
  file_path: string;
  file_size: number;
  file_mtime: string;
  indexed_at: string;
}

export interface DocSnapshotRow {
  snapshot_id: number;
  file_path: string;
  content: string;
  content_hash: string;
  file_size: number;
  created_at: string;
}

export interface DocSnapshotMeta {
  snapshot_id: number;
  file_path: string;
  content_hash: string;
  file_size: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// DB connection (singleton per project path)
// ---------------------------------------------------------------------------

let _docsDb: Db | null = null;
let _docsDbPath: string | null = null;

/** Hint appended to docs index mismatch errors. */
const DOCS_REBUILD_HINT = 'rebuild it with souvenir_docs action="build" rebuild=true (re-embeds every indexed file)';

function getLocalDocsDbPath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'ASymptOmatik', 'souvenir', 'docs.db');
}

/**
 * Get or create the docs database of a project. The vector table is created by
 * prepareDocsVectorIndex() once the embedding size is known.
 */
export function getDocsDb(projectRoot: string): Db {
  const dbPath = getLocalDocsDbPath(projectRoot);

  if (_docsDb && _docsDbPath === dbPath) return _docsDb;

  // Close previous if different path
  if (_docsDb) {
    _docsDb.close();
    _docsDb = null;
    _docsDbPath = null;
  }

  const db = openDatabase(dbPath, 'docs');
  try {
    db.exec(DOCS_CREATE_TABLES);
    migrateLegacyIdentity(db);
    migrateLegacyDocVectors(db);

    db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(DOCS_SCHEMA_VERSION),
    );
  } catch (err) {
    // Keep no half-initialized connection: the next call retries from scratch
    db.close();
    throw err;
  }

  _docsDb = db;
  _docsDbPath = dbPath;
  logger.info('Docs database initialized');
  return db;
}

/**
 * Schema 2 kept doc vectors in vec_doc_chunks without filter columns. Move them into
 * doc_chunk_vectors in one transaction (vec0 tables cannot be renamed).
 */
function migrateLegacyDocVectors(db: Db): void {
  if (!tableExists(db, LEGACY_DOCS_VEC_TABLE)) return;

  const legacyDims = vectorTableDimensions(db, LEGACY_DOCS_VEC_TABLE);
  const currentDims = tableExists(db, DOC_CHUNK_VECTORS) ? vectorTableDimensions(db, DOC_CHUNK_VECTORS) : null;
  let moved = 0;

  inTransaction(db, () => {
    if (currentDims !== null && currentDims !== legacyDims) {
      logger.warn(`Dropping ${LEGACY_DOCS_VEC_TABLE} (${legacyDims}d): incompatible with ${DOC_CHUNK_VECTORS} (${currentDims}d)`);
    } else {
      if (currentDims === null) db.exec(createDocChunkVectorsTable(legacyDims));
      const legacyVector = db.prepare(`SELECT embedding FROM ${LEGACY_DOCS_VEC_TABLE} WHERE chunk_id = ?`);
      const alreadyMoved = db.prepare(`SELECT chunk_id FROM ${DOC_CHUNK_VECTORS} WHERE chunk_id = ?`);
      const insert = db.prepare(`INSERT INTO ${DOC_CHUNK_VECTORS} (chunk_id, category, file_path, embedding) VALUES (?, ?, ?, ?)`);
      const chunks = allRows<{ chunk_id: number; category: string; file_path: string }>(
        db, 'SELECT chunk_id, category, file_path FROM doc_chunks ORDER BY chunk_id',
      );
      for (const c of chunks) {
        const id = BigInt(c.chunk_id);
        const vector = legacyVector.get(id) as { embedding: Uint8Array } | undefined;
        if (!vector || alreadyMoved.get(id)) continue;
        insert.run(id, c.category, c.file_path, vector.embedding);
        moved++;
      }
      const orphans = deleteOrphanVectors(db, DOC_CHUNK_VECTORS, 'doc_chunks');
      if (orphans > 0) logger.info(`Deleted ${orphans} doc vectors of chunks that no longer exist`);
    }
    db.exec(`DROP TABLE ${LEGACY_DOCS_VEC_TABLE}`);
  });

  // The copy went through the WAL and freed the old table's pages: give the space back
  db.exec('PRAGMA incremental_vacuum');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  logger.info(`Moved ${moved} doc vectors from ${LEGACY_DOCS_VEC_TABLE} to ${DOC_CHUNK_VECTORS}`);
}

/**
 * Make the docs vector table usable for the given embedding identity before indexing (see
 * prepareVectorIndex in db/store.ts). resetAll drops every doc vector and chunk; sources and
 * snapshots are kept.
 */
export function prepareDocsVectorIndex(
  projectRoot: string,
  identity: EmbeddingIdentity,
  options: { resetAll?: boolean } = {},
): void {
  const db = getDocsDb(projectRoot);
  if (!options.resetAll) {
    assertSameIdentity(getStoredIdentity(db), identity, 'docs', DOCS_REBUILD_HINT);
  }

  inTransaction(db, () => {
    if (options.resetAll) {
      if (tableExists(db, DOC_CHUNK_VECTORS)) db.exec(`DROP TABLE ${DOC_CHUNK_VECTORS}`);
      db.prepare('DELETE FROM doc_chunks').run();
      db.prepare('DELETE FROM doc_sections').run();
      db.prepare('DELETE FROM doc_index_state').run();
    }
    if (!tableExists(db, DOC_CHUNK_VECTORS)) db.exec(createDocChunkVectorsTable(identity.dimensions));
    setStoredIdentity(db, identity);
  });
}

/** Throw when the docs index cannot be searched with the given identity. */
export function assertDocsSearchable(projectRoot: string, identity: EmbeddingIdentity): void {
  const db = getDocsDb(projectRoot);
  const stored = getStoredIdentity(db);
  if (!stored || !tableExists(db, DOC_CHUNK_VECTORS)) {
    throw new IndexMismatchError('No docs index found. Add sources with souvenir_docs action="add", then action="build".');
  }
  assertSameIdentity(stored, identity, 'docs', DOCS_REBUILD_HINT);
}

/** Identity the docs index was built with, or null when there is none. */
export function getDocsIndexIdentity(projectRoot: string): EmbeddingIdentity | null {
  return getStoredIdentity(getDocsDb(projectRoot));
}

export function closeDocsDb(): void {
  if (_docsDb) {
    _docsDb.close();
    _docsDb = null;
    _docsDbPath = null;
  }
}

export function docsDbExists(projectRoot: string): boolean {
  return existsSync(getLocalDocsDbPath(projectRoot));
}

// ---------------------------------------------------------------------------
// Sources CRUD
// ---------------------------------------------------------------------------

export function getDocSources(projectRoot: string): DocSourceRow[] {
  const db = getDocsDb(projectRoot);
  return allRows<DocSourceRow>(db, 'SELECT * FROM doc_sources ORDER BY added_at');
}

export function addDocSource(
  projectRoot: string,
  path: string,
  type: 'file' | 'directory',
  pattern?: string,
  category?: DocCategory,
): DocSourceRow {
  const db = getDocsDb(projectRoot);
  const result = db.prepare(`
    INSERT INTO doc_sources (path, type, pattern, category, recursive, added_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(path, type, pattern || null, category || null, new Date().toISOString());

  const row = getRow<DocSourceRow>(db, 'SELECT * FROM doc_sources WHERE source_id = ?', result.lastInsertRowid);
  if (!row) {
    throw new Error(`Doc source ${result.lastInsertRowid} not found right after insertion`);
  }
  return row;
}

export function removeDocSource(projectRoot: string, sourceId: number): boolean {
  const db = getDocsDb(projectRoot);
  const result = db.prepare('DELETE FROM doc_sources WHERE source_id = ?').run(sourceId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

export function insertDocChunks(
  projectRoot: string,
  chunks: Array<{
    file_path: string;
    category: DocCategory;
    content_text: string;
    embed_text: string;
    start_line: number;
    end_line: number;
    section_path: string | null;
    file_modified: string;
  }>,
  embeddings: Float32Array[],
): number {
  const db = getDocsDb(projectRoot);

  if (chunks.length !== embeddings.length) {
    throw new Error(`Chunk count (${chunks.length}) doesn't match embedding count (${embeddings.length})`);
  }

  const insertChunk = db.prepare(`
    INSERT OR IGNORE INTO doc_chunks (file_path, category, content_text, embed_text, start_line, end_line, section_path, file_modified)
    VALUES (@file_path, @category, @content_text, @embed_text, @start_line, @end_line, @section_path, @file_modified)
  `);

  const insertVec = db.prepare(`
    INSERT INTO ${DOC_CHUNK_VECTORS} (chunk_id, category, file_path, embedding)
    VALUES (?, ?, ?, ?)
  `);

  let inserted = 0;

  inTransaction(db, () => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = insertChunk.run({
        file_path: chunk.file_path,
        category: chunk.category,
        content_text: chunk.content_text,
        embed_text: chunk.embed_text,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        section_path: chunk.section_path,
        file_modified: chunk.file_modified,
      });

      if (result.changes > 0) {
        // sqlite-vec only accepts integer primary keys: a JS number binds as REAL, BigInt as INTEGER
        insertVec.run(BigInt(result.lastInsertRowid), chunk.category, chunk.file_path, vectorBlob(embeddings[i]));
        inserted++;
      }
    }
  });

  return inserted;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export function insertDocSections(
  projectRoot: string,
  sections: Array<{
    file_path: string;
    heading: string;
    level: number;
    start_line: number;
    end_line: number | null;
    section_path: string;
  }>,
): void {
  const db = getDocsDb(projectRoot);

  const insert = db.prepare(`
    INSERT INTO doc_sections (file_path, heading, level, start_line, end_line, section_path)
    VALUES (@file_path, @heading, @level, @start_line, @end_line, @section_path)
  `);

  inTransaction(db, () => {
    for (const section of sections) {
      insert.run({
        file_path: section.file_path,
        heading: section.heading,
        level: section.level,
        start_line: section.start_line,
        end_line: section.end_line,
        section_path: section.section_path,
      });
    }
  });
}

export function getDocSections(projectRoot: string, filePath: string): DocSectionRow[] {
  const db = getDocsDb(projectRoot);
  return allRows<DocSectionRow>(db, 'SELECT * FROM doc_sections WHERE file_path = ? ORDER BY start_line', filePath);
}

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

/**
 * KNN search over the docs index; category / file filters are applied by sqlite-vec during the
 * KNN (metadata columns). Throws IndexMismatchError when the index was built with another identity.
 */
export function searchDocsSemantic(
  projectRoot: string,
  identity: EmbeddingIdentity,
  queryEmbedding: Float32Array,
  options: {
    topK?: number;
    category?: DocCategory;
    filePath?: string;
  } = {},
): DocVecSearchResult[] {
  assertDocsSearchable(projectRoot, identity);
  const db = getDocsDb(projectRoot);
  const filters: string[] = [];
  const params: SQLInputValue[] = [vectorBlob(queryEmbedding), options.topK || 10];
  if (options.category) { filters.push('category = ?'); params.push(options.category); }
  if (options.filePath) { filters.push('file_path = ?'); params.push(options.filePath); }

  return db.prepare(`
    SELECT c.*, v.distance
    FROM (
      SELECT chunk_id, distance FROM ${DOC_CHUNK_VECTORS}
      WHERE embedding MATCH ? AND k = ?${filters.map((f) => ` AND ${f}`).join('')}
    ) v
    JOIN doc_chunks c ON c.chunk_id = v.chunk_id
    ORDER BY v.distance
  `).all(...params) as unknown as DocVecSearchResult[];
}

// ---------------------------------------------------------------------------
// Index state
// ---------------------------------------------------------------------------

export function getDocIndexState(projectRoot: string, filePath: string): DocIndexStateRow | null {
  const db = getDocsDb(projectRoot);
  return getRow<DocIndexStateRow>(db, 'SELECT * FROM doc_index_state WHERE file_path = ?', filePath);
}

export function setDocIndexState(
  projectRoot: string,
  filePath: string,
  fileSize: number,
  fileMtime: string,
): void {
  const db = getDocsDb(projectRoot);
  db.prepare(`
    INSERT OR REPLACE INTO doc_index_state (file_path, file_size, file_mtime, indexed_at)
    VALUES (?, ?, ?, ?)
  `).run(filePath, fileSize, fileMtime, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

export function clearDocFile(projectRoot: string, filePath: string): void {
  const db = getDocsDb(projectRoot);

  inTransaction(db, () => {
    const chunkIds = db.prepare('SELECT chunk_id FROM doc_chunks WHERE file_path = ?')
      .all(filePath) as Array<{ chunk_id: number }>;

    if (tableExists(db, DOC_CHUNK_VECTORS)) {
      const deleteVector = db.prepare(`DELETE FROM ${DOC_CHUNK_VECTORS} WHERE chunk_id = ?`);
      for (const { chunk_id } of chunkIds) {
        deleteVector.run(BigInt(chunk_id));
      }
    }

    db.prepare('DELETE FROM doc_chunks WHERE file_path = ?').run(filePath);
    db.prepare('DELETE FROM doc_sections WHERE file_path = ?').run(filePath);
    db.prepare('DELETE FROM doc_index_state WHERE file_path = ?').run(filePath);
  });
}

export function clearAllDocs(projectRoot: string): void {
  const db = getDocsDb(projectRoot);

  inTransaction(db, () => {
    if (tableExists(db, DOC_CHUNK_VECTORS)) db.prepare(`DELETE FROM ${DOC_CHUNK_VECTORS}`).run();
    db.prepare('DELETE FROM doc_chunks').run();
    db.prepare('DELETE FROM doc_sections').run();
    db.prepare('DELETE FROM doc_index_state').run();
  });

  docsIncrementalVacuum(projectRoot);
}

// ---------------------------------------------------------------------------
// Vacuum
// ---------------------------------------------------------------------------

/**
 * Reclaim disk space from deleted rows (incremental auto-vacuum).
 */
export function docsIncrementalVacuum(projectRoot: string): void {
  try {
    const db = getDocsDb(projectRoot);
    db.exec('PRAGMA incremental_vacuum');
  } catch (err) {
    logger.error('Docs incremental vacuum error:', err);
  }
}

/**
 * Full VACUUM — compacts the entire database. Slower but reclaims all free space.
 */
export function docsFullVacuum(projectRoot: string): void {
  const db = getDocsDb(projectRoot);
  db.exec('VACUUM');
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function getDocsIndexStatus(projectRoot: string): {
  totalChunks: number;
  totalFiles: number;
  totalSections: number;
  categories: Array<{ category: DocCategory; chunkCount: number }>;
  sources: DocSourceRow[];
  dbSizeBytes: number;
} {
  const db = getDocsDb(projectRoot);

  const chunkCount = (db.prepare('SELECT COUNT(*) as cnt FROM doc_chunks')
    .get() as { cnt: number }).cnt;
  const fileCount = (db.prepare('SELECT COUNT(*) as cnt FROM doc_index_state')
    .get() as { cnt: number }).cnt;
  const sectionCount = (db.prepare('SELECT COUNT(*) as cnt FROM doc_sections')
    .get() as { cnt: number }).cnt;

  const categories = db.prepare(`
    SELECT category, COUNT(*) as chunk_count
    FROM doc_chunks
    GROUP BY category
  `).all() as Array<{ category: DocCategory; chunk_count: number }>;

  const sources = allRows<DocSourceRow>(db, 'SELECT * FROM doc_sources ORDER BY added_at');

  const dbPath = getLocalDocsDbPath(projectRoot);
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = fsStatSync(dbPath).size;
  } catch { /* ignore */ }

  return {
    totalChunks: chunkCount,
    totalFiles: fileCount,
    totalSections: sectionCount,
    categories: categories.map((c) => ({ category: c.category, chunkCount: c.chunk_count })),
    sources,
    dbSizeBytes,
  };
}


// ---------------------------------------------------------------------------
// Snapshots (file versioning)
// ---------------------------------------------------------------------------

export function insertSnapshot(
  projectRoot: string,
  filePath: string,
  content: string,
  contentHash: string,
  fileSize: number,
): boolean {
  const db = getDocsDb(projectRoot);

  // Skip if the latest snapshot for this file has the same hash (no change)
  const latest = db.prepare(
    'SELECT content_hash FROM doc_snapshots WHERE file_path = ? ORDER BY created_at DESC LIMIT 1',
  ).get(filePath) as { content_hash: string } | undefined;

  if (latest && latest.content_hash === contentHash) {
    return false;
  }

  db.prepare(
    'INSERT INTO doc_snapshots (file_path, content, content_hash, file_size, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(filePath, content, contentHash, fileSize, new Date().toISOString());

  return true;
}

export function getSnapshotsForFile(
  projectRoot: string,
  filePath: string,
  limit = 50,
): DocSnapshotMeta[] {
  const db = getDocsDb(projectRoot);
  return allRows<DocSnapshotMeta>(
    db,
    'SELECT snapshot_id, file_path, content_hash, file_size, created_at FROM doc_snapshots WHERE file_path = ? ORDER BY created_at DESC LIMIT ?',
    filePath,
    limit,
  );
}

export function getVersionedFiles(
  projectRoot: string,
): Array<{ file_path: string; snapshot_count: number; latest: string; oldest: string }> {
  const db = getDocsDb(projectRoot);
  return db.prepare(`
    SELECT file_path, COUNT(*) as snapshot_count,
           MAX(created_at) as latest, MIN(created_at) as oldest
    FROM doc_snapshots
    GROUP BY file_path
    ORDER BY latest DESC
  `).all() as Array<{ file_path: string; snapshot_count: number; latest: string; oldest: string }>;
}

export function getSnapshotContent(
  projectRoot: string,
  snapshotId: number,
): DocSnapshotRow | null {
  const db = getDocsDb(projectRoot);
  return getRow<DocSnapshotRow>(db, 'SELECT * FROM doc_snapshots WHERE snapshot_id = ?', snapshotId);
}

export function cleanupOldSnapshots(projectRoot: string, maxAgeDays: number): number {
  const db = getDocsDb(projectRoot);
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare('DELETE FROM doc_snapshots WHERE created_at < ?').run(cutoff);

  const deleted = Number(result.changes);
  if (deleted > 0) {
    docsIncrementalVacuum(projectRoot);
  }

  return deleted;
}

export function getSnapshotStats(projectRoot: string): {
  totalSnapshots: number;
  totalFiles: number;
  totalSizeBytes: number;
} {
  const db = getDocsDb(projectRoot);

  const total = db.prepare('SELECT COUNT(*) as cnt FROM doc_snapshots')
    .get() as { cnt: number };
  const files = db.prepare('SELECT COUNT(DISTINCT file_path) as cnt FROM doc_snapshots')
    .get() as { cnt: number };
  const size = db.prepare('SELECT COALESCE(SUM(LENGTH(content)), 0) as total FROM doc_snapshots')
    .get() as { total: number };

  return {
    totalSnapshots: total.cnt,
    totalFiles: files.cnt,
    totalSizeBytes: size.total,
  };
}

// ---------------------------------------------------------------------------
// Chunk count (utility)
// ---------------------------------------------------------------------------

export function getDocsChunkCount(projectRoot: string, category?: DocCategory): number {
  try {
    const dbPath = getLocalDocsDbPath(projectRoot);
    if (!existsSync(dbPath)) return 0;
    const db = getDocsDb(projectRoot);
    if (category) {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM doc_chunks WHERE category = ?')
        .get(category) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    }
    const row = db.prepare('SELECT COUNT(*) as cnt FROM doc_chunks')
      .get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}
