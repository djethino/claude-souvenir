import { getSessions, loadSessionIndex } from '../transcript/discovery.js';
import { formatSessionListEntry } from '../transcript/formatter.js';
import { getConfig } from '../config.js';
import { resolveProjectDir } from '../utils/paths.js';

export async function handleSouvenirSessions(params: {
  project?: string;
  search?: string;
  date_from?: string;
  date_to?: string;
  sort?: 'newest' | 'oldest' | 'messages';
  max_results?: number;
  offset?: number;
  include_sidechains?: boolean;
}): Promise<string> {
  const config = getConfig();
  const projectDir = params.project
    ? resolveProjectDir(params.project)
    : config.currentProject;

  if (!projectDir) {
    return 'Error: No project specified and could not detect current project. Use the "project" parameter.';
  }

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
    if (sessions.length > 0) return `No sessions after offset ${offset} (${sessions.length} in all).`;
    return params.search
      ? `No sessions found matching "${params.search}" in project "${projectDir}".`
      : `No sessions found for project "${projectDir}".`;
  }

  // Try to get original path from index, fallback to projectDir
  const index = loadSessionIndex(projectDir);
  const originalPath = index?.originalPath || projectDir;
  const total = sessions.length;
  const endIndex = offset + displayed.length;

  const header = `Project: ${originalPath} (${total} session${total > 1 ? 's' : ''})\n`;

  const entries = displayed.map((s, i) => formatSessionListEntry(s, offset + i));

  const footer = endIndex < total
    ? `\n--- Showing ${offset + 1}-${endIndex} of ${total} sessions | ${total - endIndex} more | Next page: offset=${endIndex} ---`
    : offset > 0 ? `\n--- Showing ${offset + 1}-${endIndex} of ${total} sessions (end) ---` : '';

  return header + '\n' + entries.join('\n\n') + footer;
}
