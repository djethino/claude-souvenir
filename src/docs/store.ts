import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, existsSync, statSync as fsStatSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../utils/logger.js';
import { DOCS_CREATE_TABLES, DOCS_SCHEMA_VERSION, createDocsVecTable } from './schema.js';

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

// ---------------------------------------------------------------------------
// DB connection (singleton per project path)
// ---------------------------------------------------------------------------

let _docsDb: Database.Database | null = null;
let _docsDbPath: string | null = null;
let _docsDimensions: number = 768;

function getLocalDocsDbPath(projectRoot: string): string {
  return join(projectRoot, '.souvenir', 'docs.db');
}

export function getDocsDb(projectRoot: string, dimensions?: number): Database.Database {
  const dbPath = getLocalDocsDbPath(projectRoot);

  if (_docsDb && _docsDbPath === dbPath) return _docsDb;

  // Close previous if different path
  if (_docsDb) {
    _docsDb.close();
    _docsDb = null;
    _docsDbPath = null;
  }

  if (dimensions) _docsDimensions = dimensions;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  logger.info(`Opening docs database at ${dbPath}`);
  _docsDb = new Database(dbPath);
  _docsDbPath = dbPath;

  sqliteVec.load(_docsDb);
  _docsDb.pragma('journal_mode = WAL');
  _docsDb.pragma('busy_timeout = 5000');

  _docsDb.exec(DOCS_CREATE_TABLES);
  _docsDb.exec(createDocsVecTable(_docsDimensions));

  _docsDb.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(DOCS_SCHEMA_VERSION),
  );

  logger.info('Docs database initialized');
  return _docsDb;
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
  return db.prepare('SELECT * FROM doc_sources ORDER BY added_at').all() as DocSourceRow[];
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

  return db.prepare('SELECT * FROM doc_sources WHERE source_id = ?')
    .get(result.lastInsertRowid) as DocSourceRow;
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
    INSERT OR IGNORE INTO vec_doc_chunks (chunk_id, embedding)
    VALUES (?, ?)
  `);

  let inserted = 0;

  const transaction = db.transaction(() => {
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
        const chunkId = BigInt(result.lastInsertRowid);
        const buffer = Buffer.from(embeddings[i].buffer);
        insertVec.run(chunkId, buffer);
        inserted++;
      }
    }
  });

  transaction();
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

  db.transaction(() => {
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
  })();
}

export function getDocSections(projectRoot: string, filePath: string): DocSectionRow[] {
  const db = getDocsDb(projectRoot);
  return db.prepare(
    'SELECT * FROM doc_sections WHERE file_path = ? ORDER BY start_line',
  ).all(filePath) as DocSectionRow[];
}

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

export function searchDocsSemantic(
  projectRoot: string,
  queryEmbedding: Float32Array,
  options: {
    topK?: number;
    category?: DocCategory;
    filePath?: string;
  } = {},
): DocVecSearchResult[] {
  const db = getDocsDb(projectRoot);
  const topK = options.topK || 10;
  const queryBuffer = Buffer.from(queryEmbedding.buffer);

  const baseQuery = `
    SELECT c.*, v.distance
    FROM vec_doc_chunks v
    JOIN doc_chunks c ON c.chunk_id = v.chunk_id
    WHERE v.embedding MATCH ?
      AND k = ?
      ${options.category ? 'AND c.category = ?' : ''}
      ${options.filePath ? 'AND c.file_path = ?' : ''}
    ORDER BY v.distance
  `;

  const params: unknown[] = [queryBuffer, topK];
  if (options.category) params.push(options.category);
  if (options.filePath) params.push(options.filePath);

  try {
    return db.prepare(baseQuery).all(...params) as DocVecSearchResult[];
  } catch (err) {
    logger.error('Docs semantic search error:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Index state
// ---------------------------------------------------------------------------

export function getDocIndexState(projectRoot: string, filePath: string): DocIndexStateRow | null {
  const db = getDocsDb(projectRoot);
  return db.prepare('SELECT * FROM doc_index_state WHERE file_path = ?')
    .get(filePath) as DocIndexStateRow | null;
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

  db.transaction(() => {
    const chunkIds = db.prepare('SELECT chunk_id FROM doc_chunks WHERE file_path = ?')
      .all(filePath) as Array<{ chunk_id: number }>;

    for (const { chunk_id } of chunkIds) {
      db.prepare('DELETE FROM vec_doc_chunks WHERE chunk_id = ?').run(BigInt(chunk_id));
    }

    db.prepare('DELETE FROM doc_chunks WHERE file_path = ?').run(filePath);
    db.prepare('DELETE FROM doc_sections WHERE file_path = ?').run(filePath);
    db.prepare('DELETE FROM doc_index_state WHERE file_path = ?').run(filePath);
  })();
}

export function clearAllDocs(projectRoot: string): void {
  const db = getDocsDb(projectRoot);

  db.transaction(() => {
    db.prepare('DELETE FROM vec_doc_chunks').run();
    db.prepare('DELETE FROM doc_chunks').run();
    db.prepare('DELETE FROM doc_sections').run();
    db.prepare('DELETE FROM doc_index_state').run();
  })();
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

  const sources = db.prepare('SELECT * FROM doc_sources ORDER BY added_at')
    .all() as DocSourceRow[];

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
// Provider tracking
// ---------------------------------------------------------------------------

export function getDocsStoredProvider(projectRoot: string): { name: string; dimensions: number } | null {
  const db = getDocsDb(projectRoot);
  const name = db.prepare('SELECT value FROM metadata WHERE key = ?')
    .get('embedding_provider') as { value: string } | undefined;
  const dims = db.prepare('SELECT value FROM metadata WHERE key = ?')
    .get('embedding_dimensions') as { value: string } | undefined;

  if (!name || !dims) return null;
  return { name: name.value, dimensions: parseInt(dims.value, 10) };
}

export function setDocsStoredProvider(projectRoot: string, name: string, dimensions: number): void {
  const db = getDocsDb(projectRoot);
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
    .run('embedding_provider', name);
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
    .run('embedding_dimensions', String(dimensions));
}

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
