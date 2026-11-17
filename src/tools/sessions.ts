import { archiveErrorNote, ensureArchived, getProjectInfo, getSessions } from '../archive/catalog.js';
import { formatSessionListEntry } from '../transcript/formatter.js';
import { getConfig } from '../config.js';
import { resolveProjectDir } from '../utils/paths.js';
import { createProgressNotifier, type ToolContext } from './helpers.js';

export async function handleSouvenirSessions(params: {
  project?: string;
  search?: string;
  date_from?: string;
  date_to?: string;
  sort?: 'newest' | 'oldest' | 'messages';
  max_results?: number;
  offset?: number;
  include_sidechains?: boolean;
}, ctx?: ToolContext): Promise<string> {
  const config = getConfig();
  const projectDir = params.project
    ? resolveProjectDir(params.project)
    : config.currentProject;

  if (!projectDir) {
    return 'Error: No project specified and could not detect current project. Use the "project" parameter.';
  }

  const note = archiveErrorNote(await ensureArchived([projectDir], createProgressNotifier(ctx)));
  const noteBlock = note ? `${note}\n\n` : '';

  const sessions = getSessions(projectDir, {
    search: params.search,
    dateFrom: params.date_from,
    dateTo: params.date_to,
    sort: params.sort || 'newest',
    includeSidechains: params.include_sidechains ?? false,
  });

  const maxResults = Math.min(params.max_results || 20, 50);
  const offset = params.offset ?? 0;
  const displayed = sessions.slice(offset, offset + maxResults);

  if (displayed.length === 0) {
    if (sessions.length > 0) return `${noteBlock}No sessions after offset ${offset} (${sessions.length} in all).`;
    return noteBlock + (params.search
      ? `No sessions found matching "${params.search}" in project "${projectDir}".`
      : `No sessions found for project "${projectDir}".`);
  }

  const total = sessions.length;
  const endIndex = offset + displayed.length;
  const partial = sessions.filter((s) => s.availability === 'partial').length;
  const lost = sessions.filter((s) => s.availability === 'lost').length;

  const header = [
    `Project: ${getProjectInfo(projectDir)?.originalPath ?? projectDir} (${total} session${total > 1 ? 's' : ''})`,
    partial > 0 ? `${partial} PARTIAL: Claude Code deleted their transcripts before souvenir archived whole transcripts; only search excerpts remain.` : null,
    lost > 0 ? `${lost} LOST: deleted before souvenir kept anything; only listed in Claude Code's old sessions-index.json.` : null,
  ].filter(Boolean).join('\n') + '\n';

  const entries = displayed.map((s, i) => formatSessionListEntry(s, offset + i));

  const footer = endIndex < total
    ? `\n--- Showing ${offset + 1}-${endIndex} of ${total} sessions | ${total - endIndex} more | Next page: offset=${endIndex} ---`
    : offset > 0 ? `\n--- Showing ${offset + 1}-${endIndex} of ${total} sessions (end) ---` : '';

  return noteBlock + header + '\n' + entries.join('\n\n') + footer;
}
