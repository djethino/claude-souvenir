import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, existsSync, statSync as fsStatSync } from 'fs';
import { dirname } from 'path';
import { getDbPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import { CREATE_TABLES, SCHEMA_VERSION, createVecTable } from './schema.js';

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

let _db: Database.Database | null = null;
let _dimensions: number = 768;

/**
 * Get or create the SQLite database connection.
 */
export function getDb(dimensions?: number): Database.Database {
  if (_db) return _db;

  if (dimensions) _dimensions = dimensions;

  const dbPath = getDbPath();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  logger.info(`Opening database at ${dbPath}`);
  _db = new Database(dbPath);

  // Load sqlite-vec extension
  sqliteVec.load(_db);

  // Enable WAL mode for better concurrent read performance
  _db.pragma('journal_mode = WAL');

  // Create schema
  _db.exec(CREATE_TABLES);
  _db.exec(createVecTable(_dimensions));

  // Store schema version
  _db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );

  logger.info('Database initialized');
  return _db;
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
    INSERT OR IGNORE INTO vec_chunks (chunk_id, embedding)
    VALUES (?, ?)
  `);

  let inserted = 0;

  const transaction = db.transaction(() => {
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
        // sqlite-vec requires BigInt for primary key (uses sqlite3_bind_int64)
        const chunkId = BigInt(result.lastInsertRowid);
        // Convert Float32Array to Buffer for sqlite-vec
        const buffer = Buffer.from(embeddings[i].buffer);
        insertVec.run(chunkId, buffer);
        inserted++;
      }
    }
  });

  transaction();
  return inserted;
}

/**
 * Search for similar chunks using vector KNN.
 */
export function searchSemantic(
  queryEmbedding: Float32Array,
  options: {
    topK?: number;
    projectDir?: string;
    sessionId?: string;
    role?: string;
    dateFrom?: string;
    dateTo?: string;
  } = {},
): VecSearchResult[] {
  const db = getDb();
  const topK = options.topK || 10;

  // Build the query with optional filters
  const queryBuffer = Buffer.from(queryEmbedding.buffer);

  // sqlite-vec KNN query
  const baseQuery = `
    SELECT c.*, v.distance
    FROM vec_chunks v
    JOIN chunks c ON c.chunk_id = v.chunk_id
    WHERE v.embedding MATCH ?
      AND k = ?
      ${options.projectDir ? 'AND c.project_dir = ?' : ''}
      ${options.sessionId ? 'AND c.session_id = ?' : ''}
      ${options.role ? 'AND c.role = ?' : ''}
      ${options.dateFrom ? 'AND c.timestamp >= ?' : ''}
      ${options.dateTo ? 'AND c.timestamp <= ?' : ''}
    ORDER BY v.distance
  `;

  const params: unknown[] = [queryBuffer, topK];
  if (options.projectDir) params.push(options.projectDir);
  if (options.sessionId) params.push(options.sessionId);
  if (options.role) params.push(options.role);
  if (options.dateFrom) params.push(options.dateFrom);
  if (options.dateTo) params.push(options.dateTo);

  try {
    return db.prepare(baseQuery).all(...params) as VecSearchResult[];
  } catch (err) {
    logger.error('Semantic search error:', err);
    return [];
  }
}

/**
 * Get index state for a file.
 */
export function getIndexState(filePath: string): IndexStateRow | null {
  const db = getDb();
  return db.prepare('SELECT * FROM index_state WHERE file_path = ?').get(filePath) as IndexStateRow | null;
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

  db.transaction(() => {
    // Get chunk IDs to remove from vec table
    const chunkIds = db.prepare('SELECT chunk_id FROM chunks WHERE project_dir = ?')
      .all(projectDir) as Array<{ chunk_id: number }>;

    for (const { chunk_id } of chunkIds) {
      db.prepare('DELETE FROM vec_chunks WHERE chunk_id = ?').run(BigInt(chunk_id));
    }

    db.prepare('DELETE FROM chunks WHERE project_dir = ?').run(projectDir);

    // Clear index state for files in this project
    db.prepare('DELETE FROM index_state WHERE file_path LIKE ?').run(`%${projectDir}%`);
  })();
}

/**
 * Clear all indexed data.
 */
export function clearAll(): void {
  const db = getDb();

  db.transaction(() => {
    db.prepare('DELETE FROM vec_chunks').run();
    db.prepare('DELETE FROM chunks').run();
    db.prepare('DELETE FROM index_state').run();
  })();
}

/**
 * Get the stored embedding provider info.
 */
export function getStoredProvider(): { name: string; dimensions: number } | null {
  const db = getDb();
  const name = db.prepare('SELECT value FROM metadata WHERE key = ?').get('embedding_provider') as { value: string } | undefined;
  const dims = db.prepare('SELECT value FROM metadata WHERE key = ?').get('embedding_dimensions') as { value: string } | undefined;

  if (!name || !dims) return null;
  return { name: name.value, dimensions: parseInt(dims.value, 10) };
}

/**
 * Store the current embedding provider info.
 */
export function setStoredProvider(name: string, dimensions: number): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('embedding_provider', name);
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('embedding_dimensions', String(dimensions));
}
