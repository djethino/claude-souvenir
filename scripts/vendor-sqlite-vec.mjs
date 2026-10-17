#!/usr/bin/env node

/**
 * Vendor the sqlite-vec extension binaries into vendor/sqlite-vec/bin/.
 *
 * Claude Code installs plugin npm dependencies with --ignore-scripts and the plugin
 * should run without any npm install, so the binaries are committed. Their versions
 * come from vendor/sqlite-vec/package-lock.json, which Dependabot watches.
 *
 * Each tarball is downloaded from the URL pinned in the lockfile and checked against
 * the lockfile's sha512 integrity before its binary is extracted.
 *
 *   node scripts/vendor-sqlite-vec.mjs          write bin/ and manifest.json
 *   node scripts/vendor-sqlite-vec.mjs --check  verify the committed files, exit 1 on mismatch
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';

const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'sqlite-vec');
const BIN_DIR = join(VENDOR_DIR, 'bin');
const MANIFEST = join(VENDOR_DIR, 'manifest.json');

// Must match VEC_BINARIES in src/db/sqlite.ts. sqlite-vec-linux-arm64 is not published for 0.1.6.
const PLATFORMS = [
  { dir: 'windows-x64', pkg: 'sqlite-vec-windows-x64', file: 'vec0.dll' },
  { dir: 'linux-x64', pkg: 'sqlite-vec-linux-x64', file: 'vec0.so' },
  { dir: 'darwin-x64', pkg: 'sqlite-vec-darwin-x64', file: 'vec0.dylib' },
  { dir: 'darwin-arm64', pkg: 'sqlite-vec-darwin-arm64', file: 'vec0.dylib' },
];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Return the content of `name` inside an uncompressed tar archive. */
function extractFromTar(tar, name) {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const path = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const start = offset + 512;
    if (path === name) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${name} not found in tarball`);
}

async function fetchBinary({ pkg, file }, lock) {
  const entry = lock.packages[`node_modules/${pkg}`];
  if (!entry?.resolved || !entry.integrity) {
    throw new Error(`${pkg} is missing from vendor/sqlite-vec/package-lock.json`);
  }
  const response = await fetch(entry.resolved);
  if (!response.ok) throw new Error(`${entry.resolved}: HTTP ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());

  const [algorithm, expected] = entry.integrity.split('-', 2);
  const actual = createHash(algorithm).update(tarball).digest('base64');
  if (actual !== expected) {
    throw new Error(`${pkg}@${entry.version}: integrity mismatch (lockfile ${entry.integrity})`);
  }
  return { entry, binary: extractFromTar(gunzipSync(tarball), `package/${file}`) };
}

async function main() {
  const check = process.argv.includes('--check');
  const lock = JSON.parse(readFileSync(join(VENDOR_DIR, 'package-lock.json'), 'utf8'));
  const manifest = { sqliteVec: lock.packages['node_modules/sqlite-vec']?.version, binaries: {} };
  const problems = [];

  if (!check) rmSync(BIN_DIR, { recursive: true, force: true });

  for (const platform of PLATFORMS) {
    const { entry, binary } = await fetchBinary(platform, lock);
    const target = join(BIN_DIR, platform.dir, platform.file);
    manifest.binaries[platform.dir] = {
      package: `${platform.pkg}@${entry.version}`,
      integrity: entry.integrity,
      file: `${platform.dir}/${platform.file}`,
      sha256: sha256(binary),
    };
    if (check) {
      if (!existsSync(target)) problems.push(`missing ${target}`);
      else if (sha256(readFileSync(target)) !== sha256(binary)) problems.push(`${target} differs from ${platform.pkg}@${entry.version}`);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, binary);
      console.log(`${platform.pkg}@${entry.version} -> ${platform.dir}/${platform.file} (${binary.length} bytes)`);
    }
  }

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (check) {
    if (!existsSync(MANIFEST) || readFileSync(MANIFEST, 'utf8').replace(/\r\n/g, '\n') !== manifestText) {
      problems.push('manifest.json is out of date');
    }
    if (problems.length) {
      console.error(`sqlite-vec vendor check failed:\n  ${problems.join('\n  ')}\nRun: npm run vendor`);
      process.exit(1);
    }
    console.log('sqlite-vec vendored binaries match the lockfile');
  } else {
    writeFileSync(MANIFEST, manifestText);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
