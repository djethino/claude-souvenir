import { homedir } from 'os';
import { join } from 'path';
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
 * Claude Code replaces every character that is not a letter or a digit with a hyphen:
 * "D:\projet\claude-plugins" -> "D--projet-claude-plugins", "D:\projet\a - b" -> "D--projet-a---b".
 * The case is kept as given (on Windows the same project can appear as "D--…" and "d--…").
 */
export function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

/** Whether a path is the root of the project stored in this directory (case-insensitive, like Windows paths). */
export function isProjectPath(path: string, projectDir: string): boolean {
  return cwdToProjectDir(path).toLowerCase() === projectDir.toLowerCase();
}

/**
 * Resolve a project identifier to the project directory name.
 * Accepts either a dir name (D--projet-xxx) or a path (D:\projet\xxx); dir names have no separator.
 */
export function resolveProjectDir(project: string): string {
  return /[\\/]/.test(project) ? cwdToProjectDir(project) : project;
}

/**
 * Get the path to a project's transcript directory.
 */
export function getProjectTranscriptDir(projectDir: string): string {
  return join(getProjectsDir(), projectDir);
}
