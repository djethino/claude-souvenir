/**
 * Claude Code's own files: the project folders under ~/.claude/projects, their transcripts and
 * the files kept beside them. Only the archiver reads the transcripts (see archive/archiver.ts);
 * everything else reads the archive, which keeps them after Claude Code deletes them.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename, relative, sep } from 'path';
import { logger } from '../utils/logger.js';
import { getProjectsDir, getProjectTranscriptDir } from '../utils/paths.js';
import type { SessionIndex } from './types.js';

// Cache session indexes in memory (small data, read frequently)
const indexCache = new Map<string, { data: SessionIndex; mtime: number }>();

/** Session folders are named after the session id (a UUID). */
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * List the project folders under ~/.claude/projects/ (projects whose folder Claude Code deleted
 * are still known to the archive: see archive/catalog.ts listProjectDirs).
 */
export function listProjectDirsOnDisk(): string[] {
  const projectsDir = getProjectsDir();
  if (!existsSync(projectsDir)) return [];

  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * The folder of a project under ~/.claude/projects, only when a folder of exactly that name exists.
 * On a case-insensitive file system (Windows, macOS), "D--projet-ASymptOmatik-x" also opens the
 * folder "D--projet-Asymptomatik-x": a project known under another spelling (the archive, old
 * chunks) must not read the same transcripts a second time.
 */
function projectFolder(projectDir: string): string | null {
  return listProjectDirsOnDisk().includes(projectDir) ? getProjectTranscriptDir(projectDir) : null;
}

/**
 * Load the sessions-index.json for a project (with caching). Claude Code no longer writes it;
 * older ones still give the summaries and the project path of their sessions.
 */
export function loadSessionIndex(projectDir: string): SessionIndex | null {
  const folder = projectFolder(projectDir);
  const indexPath = folder && join(folder, 'sessions-index.json');

  if (!indexPath || !existsSync(indexPath)) {
    logger.debug(`No sessions-index.json for ${projectDir}`);
    return null;
  }

  try {
    const stat = statSync(indexPath);
    const cached = indexCache.get(projectDir);

    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.data;
    }

    const raw = readFileSync(indexPath, 'utf-8');
    const data = JSON.parse(raw) as SessionIndex;

    indexCache.set(projectDir, { data, mtime: stat.mtimeMs });
    return data;
  } catch (err) {
    logger.error(`Failed to read session index for ${projectDir}:`, err);
    return null;
  }
}

export interface SourceTranscript {
  path: string;
  /** Path relative to the projects folder, '/' separators: the transcript's key in the archive */
  fileKey: string;
  /** Session id (main transcript) or agent id (subagent transcript): the file name */
  sessionId: string;
  /** Main session of a subagent transcript in <session>/subagents/, null otherwise */
  parentSessionId: string | null;
}

export interface SourceAttachment {
  path: string;
  fileKey: string;
  /** Session whose folder holds the file */
  sessionId: string;
}

/**
 * Every file of a project that belongs to its conversations: the transcripts (<session>.jsonl,
 * <session>/subagents/*.jsonl) and the files kept beside them in the session folders (large tool
 * results and images in tool-results/, subagent metadata …). Prompt-suggestion agents (Claude
 * Code predicting the user's next input) are not conversations and are left out.
 */
export function listSourceFiles(projectDir: string): { transcripts: SourceTranscript[]; attachments: SourceAttachment[] } {
  const dir = projectFolder(projectDir);
  const transcripts: SourceTranscript[] = [];
  const attachments: SourceAttachment[] = [];
  if (!dir) return { transcripts, attachments };

  const keyOf = (path: string) => relative(getProjectsDir(), path).split(sep).join('/');

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      transcripts.push({ path, fileKey: keyOf(path), sessionId: basename(entry.name, '.jsonl'), parentSessionId: null });
      continue;
    }
    if (!entry.isDirectory() || !SESSION_DIR.test(entry.name)) continue;

    const sessionId = entry.name;
    for (const file of walkFiles(path)) {
      const inSubagents = relative(path, file).split(sep)[0] === 'subagents';
      if (inSubagents && file.endsWith('.jsonl')) {
        if (basename(file).includes('aprompt_suggestion')) continue;
        transcripts.push({ path: file, fileKey: keyOf(file), sessionId: basename(file, '.jsonl'), parentSessionId: sessionId });
      } else if (!(inSubagents && basename(file).includes('aprompt_suggestion'))) {
        attachments.push({ path: file, fileKey: keyOf(file), sessionId });
      }
    }
  }

  return { transcripts, attachments };
}

/** Every file under a folder, at any depth. */
function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
