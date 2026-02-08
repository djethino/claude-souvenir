#!/usr/bin/env node

/**
 * Deploy claude-recall plugin to Claude Code plugins cache.
 * Usage: node deploy.js [--uninstall]
 */

import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const pluginDir = resolve(import.meta.dirname);
const pluginJson = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf-8'));
const { name, version } = pluginJson;

const claudeDir = join(homedir(), '.claude');
const cacheDir = join(claudeDir, 'plugins', 'cache', 'local-dev', name, version);

function deploy() {
  console.log(`Deploying ${name} v${version}...`);
  console.log(`  Source: ${pluginDir}`);
  console.log(`  Cache:  ${cacheDir}`);

  // Build first
  console.log('\nBuilding TypeScript...');
  try {
    execSync('npx tsc', { cwd: pluginDir, stdio: 'inherit' });
  } catch {
    console.error('Build failed!');
    process.exit(1);
  }

  // Install production dependencies
  console.log('\nInstalling dependencies...');
  try {
    execSync('npm install --omit=dev', { cwd: pluginDir, stdio: 'inherit' });
  } catch {
    console.error('npm install failed!');
    process.exit(1);
  }

  // Reinstall all deps (including dev) for next build
  execSync('npm install', { cwd: pluginDir, stdio: 'pipe' });

  // Remove old cache
  if (existsSync(cacheDir)) {
    console.log('Removing old cache...');
    rmSync(cacheDir, { recursive: true });
  }

  // Create cache directory
  mkdirSync(cacheDir, { recursive: true });

  // Copy plugin files (excluding dev files)
  const exclude = new Set([
    '.git', 'node_modules', '.claude', 'src', '.gitignore',
    'tsconfig.json', 'deploy.js', 'analyse', 'TODO.md',
  ]);

  console.log('Copying to cache...');
  cpSync(pluginDir, cacheDir, {
    recursive: true,
    filter: (src) => {
      const name = src.split(/[\\/]/).pop() || '';
      return !exclude.has(name);
    },
  });

  // Copy node_modules (production only)
  console.log('Copying node_modules...');
  cpSync(join(pluginDir, 'node_modules'), join(cacheDir, 'node_modules'), { recursive: true });

  console.log(`\n[OK] Plugin deployed to cache`);
  console.log('\n** RESTART CLAUDE CODE ** to load the updated plugin.');
}

function uninstall() {
  const base = join(claudeDir, 'plugins', 'cache', 'local-dev', name);
  if (existsSync(base)) {
    rmSync(base, { recursive: true });
    console.log(`[OK] Plugin cache removed: ${base}`);
    console.log('\n** RESTART CLAUDE CODE ** to apply changes.');
  } else {
    console.log('Plugin cache not found.');
  }
}

if (process.argv.includes('--uninstall')) {
  uninstall();
} else {
  deploy();
}
