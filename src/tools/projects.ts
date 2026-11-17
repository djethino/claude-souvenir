import { existsSync } from 'fs';
import { parse } from 'path';
import { listProjectDirsOnDisk } from '../transcript/discovery.js';
import { ensureArchived, archiveErrorNote, getProjectInfo, listProjectDirs } from '../archive/catalog.js';
import { getConfig } from '../config.js';
import { deleteProject } from '../db/store.js';
import { DECLINED, type Confirm } from './confirm.js';
import { createProgressNotifier, type ToolContext } from './helpers.js';

export async function handleSouvenirProjects(params: {
  search?: string;
  action?: 'list' | 'clean';
}, confirm: Confirm, ctx?: ToolContext): Promise<string> {
  // Projects are read from the archive: copy what Claude Code wrote since the last copy first
  const note = archiveErrorNote(await ensureArchived(listProjectDirsOnDisk(), createProgressNotifier(ctx)));
  const noteBlock = note ? `${note}\n\n` : '';

  if (params.action === 'clean') {
    return noteBlock + handleClean(confirm);
  }

  const config = getConfig();
  const onDisk = new Set(listProjectDirsOnDisk());

  const projects = listProjectDirs()
    .map((dir) => getProjectInfo(dir))
    .filter((p): p is NonNullable<typeof p> => p !== null);

  let filtered = projects;
  if (params.search) {
    const term = params.search.toLowerCase();
    filtered = projects.filter(
      (p) =>
        (p.originalPath ?? '').toLowerCase().includes(term) ||
        p.dirName.toLowerCase().includes(term),
    );
  }

  filtered.sort((a, b) => {
    const dateA = a.latestDate ? new Date(a.latestDate).getTime() : 0;
    const dateB = b.latestDate ? new Date(b.latestDate).getTime() : 0;
    return dateB - dateA;
  });

  if (filtered.length === 0) {
    return noteBlock + (params.search
      ? `No projects found matching "${params.search}".`
      : 'No projects with conversations found.');
  }

  const lines = [`${noteBlock}Found ${filtered.length} project(s):\n`];

  for (let i = 0; i < filtered.length; i++) {
    const p = filtered[i];
    const latest = p.latestDate ? p.latestDate.slice(0, 10) : '???';
    const oldest = p.oldestDate ? p.oldestDate.slice(0, 10) : '???';

    const tags: string[] = [];
    if (p.dirName === config.currentProject) tags.push('[current]');
    else if (p.originalPath === null) tags.push('[path unknown]');
    else if (!driveAvailable(p.originalPath)) tags.push('[drive not available]');
    else if (!existsSync(p.originalPath)) tags.push('[folder deleted]');
    if (!onDisk.has(p.dirName)) tags.push('[transcripts deleted by Claude Code: read from the archive]');

    lines.push(`${i + 1}. ${p.originalPath ?? p.dirName}${tags.length ? ` ${tags.join(' ')}` : ''}`);
    lines.push(`   Dir: ${p.dirName}`);
    lines.push(`   Sessions: ${p.sessionCount}${p.partialSessions ? ` (${p.partialSessions} partial)` : ''} | Latest: ${latest} | Oldest: ${oldest}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Delete what souvenir kept of projects whose folder was deleted
// ---------------------------------------------------------------------------

/**
 * Mount points of removable or network drives on macOS and Linux: /Volumes/<name>,
 * /media/<user>/<name> (or /media/<name>), /run/media/<user>/<name>, /mnt/<name>. Two levels are
 * checked where a user folder may come first: when unsure, the drive counts as unavailable, and
 * the project is never offered for cleaning.
 */
const POSIX_MOUNT = /^(\/Volumes\/[^/]+|\/media\/[^/]+\/[^/]+|\/media\/[^/]+|\/run\/media\/[^/]+\/[^/]+|\/mnt\/[^/]+)/;

/** Whether the drive of a path is there: an unplugged or unmounted drive is not a deleted folder. */
function driveAvailable(path: string): boolean {
  if (!existsSync(parse(path).root)) return false; // Windows drive letter, network share
  const mount = POSIX_MOUNT.exec(path.replace(/\\/g, '/'));
  return !mount || existsSync(mount[1]);
}

function handleClean(confirm: Confirm): string {
  // Only projects whose folder is known to be gone: never one whose path is unknown, nor one on a
  // drive that is not available right now
  const deleted = listProjectDirs()
    .map((dir) => getProjectInfo(dir))
    .filter((p): p is NonNullable<typeof p> & { originalPath: string } =>
      p !== null && p.originalPath !== null && driveAvailable(p.originalPath) && !existsSync(p.originalPath));

  if (deleted.length === 0) {
    return 'No project with a deleted folder: nothing to clean.';
  }

  const question = [
    `souvenir: delete everything souvenir kept of ${deleted.length} project(s) whose folder no longer exists?`,
    'This deletes their archived conversations, not only the search index. When Claude Code already deleted their transcripts, souvenir\'s archive is the only copy left: it cannot be undone.',
    ...deleted.map((p) => `- ${p.originalPath} (${p.sessionCount} sessions, ${p.oldestDate?.slice(0, 10) ?? '???'} to ${p.latestDate?.slice(0, 10) ?? '???'})`),
  ];
  // Deletes the only copy of conversations: never without the user's answer
  if (!confirm(question.join('\n'), { required: true })) {
    return DECLINED;
  }

  const lines: string[] = [];
  for (const p of deleted) {
    try {
      deleteProject(p.dirName);
      lines.push(`Deleted ${p.originalPath}: ${p.sessionCount} sessions`);
    } catch (err) {
      lines.push(`Error deleting ${p.originalPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  lines.push('', 'Transcript files still in ~/.claude/projects/ are left to Claude Code: souvenir archives them again while they exist.');
  return lines.join('\n');
}
