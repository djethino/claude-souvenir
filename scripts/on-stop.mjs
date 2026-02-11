#!/usr/bin/env node

/**
 * Stop hook for claude-recall.
 * Writes a trigger flag file to signal the MCP server that new content
 * may be available for indexing. The MCP server checks this flag on each
 * tool call and schedules background indexing if set.
 *
 * This is intentionally lightweight — no model loading, no indexing here.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const triggerDir = join(homedir(), '.claude', 'claude-recall');
const triggerFile = join(triggerDir, 'index-trigger');

try {
  mkdirSync(triggerDir, { recursive: true });
  writeFileSync(triggerFile, String(Date.now()), 'utf-8');
} catch {
  // Silently ignore — non-critical
}
