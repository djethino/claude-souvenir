import type { Db } from './sqlite.js';
import { getRow } from './sqlite.js';
import { type EmbeddingIdentity, describeIdentity, sameIdentity } from '../embedding/provider.js';

/**
 * The embedding identity an index was built with, stored in its metadata table. Vectors are only
 * comparable with the identity that produced them, so every search and incremental index checks it.
 * Shared by the transcript database and the per-project docs databases.
 */

const IDENTITY_KEY = 'embedding_identity';

/** Prefixes that versions <= 0.3 applied: EmbeddingGemma's for every Ollama model, none for OpenAI. */
const LEGACY_PREFIXES = {
  ollama: { documentPrefix: 'title: none | text: ', queryPrefix: 'task: search result | query: ' },
  openai: { documentPrefix: '', queryPrefix: '' },
} as const;

export class IndexMismatchError extends Error {}

export function getStoredIdentity(db: Db): EmbeddingIdentity | null {
  const row = getRow<{ value: string }>(db, 'SELECT value FROM metadata WHERE key = ?', IDENTITY_KEY);
  return row ? JSON.parse(row.value) as EmbeddingIdentity : null;
}

export function setStoredIdentity(db: Db, identity: EmbeddingIdentity): void {
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(IDENTITY_KEY, JSON.stringify(identity));
}

/**
 * Versions <= 0.3 stored only "embedding_provider" ("ollama (embeddinggemma)") and
 * "embedding_dimensions". Convert them once into a full identity, and drop them (an older
 * version still running may write them again; the identity already stored wins).
 */
export function migrateLegacyIdentity(db: Db): void {
  if (!getStoredIdentity(db)) {
    const name = getRow<{ value: string }>(db, 'SELECT value FROM metadata WHERE key = ?', 'embedding_provider')?.value;
    const dims = getRow<{ value: string }>(db, 'SELECT value FROM metadata WHERE key = ?', 'embedding_dimensions')?.value;
    const match = name?.match(/^(ollama|openai) \((.+)\)$/);
    if (match && dims) {
      const provider = match[1] as 'ollama' | 'openai';
      setStoredIdentity(db, { provider, model: match[2], dimensions: Number(dims), ...LEGACY_PREFIXES[provider] });
    }
  }
  db.prepare("DELETE FROM metadata WHERE key IN ('embedding_provider', 'embedding_dimensions')").run();
}

/** Throw an IndexMismatchError explaining how to fix it when stored and current identities differ. */
export function assertSameIdentity(
  stored: EmbeddingIdentity | null,
  current: EmbeddingIdentity,
  label: string,
  rebuildHint: string,
): void {
  if (!stored || sameIdentity(stored, current)) return;
  throw new IndexMismatchError(
    `The ${label} index was built with ${describeIdentity(stored)}, but the current embedding settings give ` +
    `${describeIdentity(current)}. Vectors from different models cannot be compared. Either restore the ` +
    `previous embedding settings (/plugin configure asymptomatik-souvenir), or ${rebuildHint}.`,
  );
}

/** Whether a table (or virtual table) exists. */
export function tableExists(db: Db, table: string): boolean {
  return getRow(db, "SELECT 1 AS found FROM sqlite_master WHERE name = ? AND type = 'table'", table) !== null;
}

/**
 * Delete vectors whose chunk no longer exists. They appear when an older version kept indexing
 * (and deleting chunks) in its own table after the migration; left in place they would take KNN
 * slots and then vanish in the join, so searches would return fewer results than asked.
 */
export function deleteOrphanVectors(db: Db, vectorTable: string, chunkTable: string): number {
  const ids = db.prepare(`SELECT chunk_id FROM ${vectorTable}`).all() as Array<{ chunk_id: number }>;
  const chunkExists = db.prepare(`SELECT 1 FROM ${chunkTable} WHERE chunk_id = ?`);
  const remove = db.prepare(`DELETE FROM ${vectorTable} WHERE chunk_id = ?`);
  let removed = 0;
  for (const { chunk_id } of ids) {
    if (!chunkExists.get(chunk_id)) {
      remove.run(BigInt(chunk_id));
      removed++;
    }
  }
  return removed;
}

/** Vector size declared by a vec0 table ("embedding float[768]"). */
export function vectorTableDimensions(db: Db, table: string): number {
  const sql = getRow<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE name = ? AND type = 'table'", table)?.sql;
  const match = sql?.match(/float\[(\d+)\]/i);
  if (!match) {
    throw new Error(`Cannot read the vector size of table ${table}`);
  }
  return Number(match[1]);
}
