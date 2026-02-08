import { getSessions, loadSessionIndex } from '../transcript/discovery.js';
import { formatSessionListEntry } from '../transcript/formatter.js';
import { getConfig } from '../config.js';
import { resolveProjectDir } from '../utils/paths.js';

export async function handleRecallSessions(params: {
  project?: string;
  search?: string;
  date_from?: string;
  date_to?: string;
  sort?: 'newest' | 'oldest' | 'messages';
  max_results?: number;
  include_sidechains?: boolean;
}): Promise<string> {
  const config = getConfig();
  const projectDir = params.project
    ? resolveProjectDir(params.project)
    : config.currentProject;

  if (!projectDir) {
    return 'Error: No project specified and could not detect current project. Use the "project" parameter.';
  }

  const index = loadSessionIndex(projectDir);
  if (!index) {
    return `Error: No transcript data found for project "${projectDir}".`;
  }

  const sessions = getSessions(projectDir, {
    search: params.search,
    dateFrom: params.date_from,
    dateTo: params.date_to,
    sort: params.sort || 'newest',
    includeSidechains: params.include_sidechains ?? false,
  });

  const maxResults = Math.min(params.max_results || 20, 50);
  const displayed = sessions.slice(0, maxResults);

  if (displayed.length === 0) {
    return params.search
      ? `No sessions found matching "${params.search}" in project "${projectDir}".`
      : `No sessions found for project "${projectDir}".`;
  }

  const header = `Project: ${index.originalPath} (${sessions.length} session${sessions.length > 1 ? 's' : ''}${sessions.length > maxResults ? `, showing first ${maxResults}` : ''})\n`;

  const entries = displayed.map((s, i) => formatSessionListEntry(s, i));

  return header + '\n' + entries.join('\n\n');
}
