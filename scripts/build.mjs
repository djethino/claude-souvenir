#!/usr/bin/env node

/**
 * Build the files Claude Code runs: dist/index.js (MCP server) and dist/background-index.js (hooks).
 *
 * Claude Code installs plugins from git and runs npm with --ignore-scripts, so dist/ is committed
 * and bundles every npm dependency: the plugin needs no node_modules at runtime. The only native
 * code, sqlite-vec, is vendored in vendor/sqlite-vec/bin (see scripts/vendor-sqlite-vec.mjs).
 *
 * Type errors fail the build (esbuild strips types without checking them).
 */

import { execSync } from 'child_process';
import { readFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// package.json is the single source of the version; Claude Code reads plugin.json, which must match
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pluginVersion = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
if (pluginVersion !== version) {
  console.error(`Version mismatch: package.json ${version}, .claude-plugin/plugin.json ${pluginVersion}`);
  process.exit(1);
}

execSync('npx tsc --noEmit', { cwd: root, stdio: 'inherit' });

rmSync(join(root, 'dist'), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    index: 'src/index.ts',
    'background-index': 'src/background-index.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Readable output: these files are committed and debugged from users' stack traces
  minify: false,
  legalComments: 'inline',
  define: { __SOUVENIR_VERSION__: JSON.stringify(version) },
  // Bundled CommonJS dependencies call require(); ESM has none unless it is created
  banner: { js: "import { createRequire as __souvenirCreateRequire } from 'module';\nconst require = __souvenirCreateRequire(import.meta.url);" },
  logLevel: 'info',
});
