import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { createRequire } from 'module';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

export type Db = DatabaseSync;

/** node:sqlite is unflagged and supports loadExtension() from this version. */
const MIN_NODE = [22, 13] as const;

/** Vendored sqlite-vec binaries, relative to the bundled dist/ file (see scripts/vendor-sqlite-vec.mjs). */
const VEC_BINARIES: Record<string, string> = {
  'win32-x64': 'windows-x64/vec0.dll',
  'linux-x64': 'linux-x64/vec0.so',
  'darwin-x64': 'darwin-x64/vec0.dylib',
  'darwin-arm64': 'darwin-arm64/vec0.dylib',
};

function assertNodeVersion(): void {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw new Error(
      `souvenir requires Node.js >= ${MIN_NODE.join('.')} (built-in node:sqlite), found ${process.versions.node}`,
    );
  }
}

function sqliteVecPath(): string {
  const platform = `${process.platform}-${process.arch}`;
  const relative = VEC_BINARIES[platform];
  if (!relative) {
    throw new Error(
      `souvenir: no sqlite-vec binary for ${platform} (supported: ${Object.keys(VEC_BINARIES).join(', ')})`,
    );
  }
  const path = fileURLToPath(new URL(`../vendor/sqlite-vec/bin/${relative}`, import.meta.url));
  if (!existsSync(path)) {
    throw new Error(`souvenir: sqlite-vec binary missing at ${path}`);
  }
  return path;
}

/**
 * Open a SQLite database with sqlite-vec loaded, WAL, a busy timeout and incremental auto-vacuum.
 *
 * node:sqlite is required lazily so that an unsupported Node.js version gets a clear error
 * instead of a module resolution failure at startup.
 */
export function openDatabase(dbPath: string, label: string): Db {
  assertNodeVersion();
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  logger.info(`Opening ${label} database at ${dbPath}`);
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.loadExtension(sqliteVecPath());

  // WAL for concurrent readers; wait up to 5s if another process holds the write lock (avoids SQLITE_BUSY)
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  // A checkpoint blocked by another process's reader lets the WAL grow (GBs after a migration) and SQLite
  // never shrinks it on its own: cap it at 64 MB, applied at the first commit after a complete checkpoint
  db.exec('PRAGMA journal_size_limit = 67108864');

  // Enable incremental auto-vacuum to reclaim space after deletions
  const { auto_vacuum: autoVacuum } = db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number };
  if (autoVacuum !== 2) {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    logger.info(`${label} database: enabled incremental auto_vacuum (one-time migration)`);
  }

  return db;
}

/** Run fn inside a transaction: committed if it returns, rolled back if it throws. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** First row of a query typed as T, or null when there is none. */
export function getRow<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | null {
  return (db.prepare(sql).get(...params) as unknown as T | undefined) ?? null;
}

/** All rows of a query typed as T. */
export function allRows<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

/** Raw bytes of a vector as sqlite-vec expects them (respects views into a larger buffer). */
export function vectorBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}
