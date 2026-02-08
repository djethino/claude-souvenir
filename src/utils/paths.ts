import { homedir } from 'os';
import { join, resolve, sep } from 'path';

/**
 * Get the Claude Code base directory (~/.claude).
 */
export function getClaudeDir(): string {
  return process.env.RECALL_CLAUDE_DIR || join(homedir(), '.claude');
}

/**
 * Get the projects directory (~/.claude/projects).
 */
export function getProjectsDir(): string {
  return join(getClaudeDir(), 'projects');
}

/**
 * Get the recall database directory (~/.claude/claude-recall).
 */
export function getRecallDir(): string {
  return join(getClaudeDir(), 'claude-recall');
}

/**
 * Get the recall database path.
 */
export function getDbPath(): string {
  return process.env.RECALL_DB_PATH || join(getRecallDir(), 'recall.db');
}

/**
 * Convert a working directory path to a Claude project directory name.
 * e.g. "D:\projet\claude-plugins" -> "D--projet-claude-plugins"
 */
export function cwdToProjectDir(cwd: string): string {
  // Normalize to forward slashes, remove trailing slash
  let normalized = cwd.replace(/\\/g, '/').replace(/\/$/, '');

  // Remove the colon after drive letter on Windows (D: -> D)
  normalized = normalized.replace(/^([A-Za-z]):/, '$1');

  // Replace slashes with double dashes
  return normalized.replace(/\//g, '--');
}

/**
 * Resolve a project identifier to the project directory name.
 * Accepts either a dir name (D--projet-xxx) or a path (D:\projet\xxx).
 */
export function resolveProjectDir(project: string): string {
  // If it looks like a path (contains \ or / with more than just --), convert it
  if (project.includes(sep) || (project.includes('/') && !project.startsWith('D--'))) {
    return cwdToProjectDir(project);
  }
  return project;
}

/**
 * Get the path to a project's transcript directory.
 */
export function getProjectTranscriptDir(projectDir: string): string {
  return join(getProjectsDir(), projectDir);
}
