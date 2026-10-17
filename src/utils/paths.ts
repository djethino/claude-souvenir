import { homedir } from 'os';
import { join, sep } from 'path';
import { readPluginOptions } from '../options.js';

/**
 * Get the Claude Code configuration directory: CLAUDE_CONFIG_DIR when Claude Code runs with a
 * relocated config, ~/.claude otherwise.
 */
export function getClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Get the projects directory (~/.claude/projects).
 */
export function getProjectsDir(): string {
  return join(getClaudeDir(), 'projects');
}

/**
 * Get the souvenir database directory (~/.claude/ASymptOmatik/souvenir).
 */
export function getSouvenirDir(): string {
  return join(getClaudeDir(), 'ASymptOmatik', 'souvenir');
}

/**
 * Get the transcript index database path (db_path option, or the default location).
 */
export function getDbPath(): string {
  return readPluginOptions().dbPath ?? join(getSouvenirDir(), 'souvenir.db');
}

/**
 * Convert a working directory path to a Claude project directory name.
 * Claude Code replaces each special char (: \ /) with a single hyphen.
 * e.g. "D:\projet\claude-plugins" -> "D--projet-claude-plugins"
 *       (D + ":" → "-" + "\" → "-" = "D--", then "\" → "-" for each separator)
 */
export function cwdToProjectDir(cwd: string): string {
  // Remove trailing slashes
  const cleaned = cwd.replace(/[\\/]+$/, '');
  // Replace : and path separators with single -
  return cleaned.replace(/:/g, '-').replace(/[\\/]/g, '-');
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
