import { homedir } from 'os';
import { join, resolve, sep } from 'path';

/**
 * Get the Claude Code base directory (~/.claude).
 */
export function getClaudeDir(): string {
  return process.env.SOUVENIR_CLAUDE_DIR || join(homedir(), '.claude');
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
 * Get the souvenir database path.
 */
export function getDbPath(): string {
  return process.env.SOUVENIR_DB_PATH || join(getSouvenirDir(), 'souvenir.db');
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
