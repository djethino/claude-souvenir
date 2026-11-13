import { ResourceNotFoundError, ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { getConfig } from './config.js';
import { getSessions } from './transcript/discovery.js';
import type { SessionIndexEntry } from './transcript/types.js';
import { formatEntryCount, readablePrompt, sessionTitle } from './transcript/formatter.js';
import { readSessionDigest } from './tools/read.js';

/** Sessions listed for @ mentions; older ones stay readable by URI and through souvenir_sessions. */
const LISTED_SESSIONS = 50;

export function sessionUri(sessionId: string): string {
  return `souvenir://session/${sessionId}`;
}

/** Short label of a session: its date and summary (or first prompt). */
export function sessionLabel(session: SessionIndexEntry): string {
  const date = session.created ? session.created.slice(0, 10) : '????-??-??';
  const title = sessionTitle(session).replace(/\s+/g, ' ').trim();
  return `${date} ${title.length > 70 ? title.slice(0, 70) + '…' : title}`;
}

/** One line about a session beyond its label: first prompt (when the label shows a summary), size, branch, id. */
function sessionDescription(session: SessionIndexEntry): string {
  const parts: string[] = [];
  if (session.summary && session.firstPrompt && session.firstPrompt !== session.summary) {
    const first = readablePrompt(session.firstPrompt).replace(/\s+/g, ' ').trim();
    parts.push(`First prompt: "${first.length > 100 ? first.slice(0, 100) + '…' : first}"`);
  }
  parts.push(`${formatEntryCount(session.messageCount)} entries`);
  if (session.gitBranch) parts.push(`branch ${session.gitBranch}`);
  parts.push(`session_id ${session.sessionId}`);
  return parts.join(' · ');
}

/**
 * Past sessions as MCP resources: in Claude Code, `@` lists the current project's recent sessions,
 * and citing one attaches its digest (header, files touched, last entries) to the prompt.
 */
export function registerSessionResources(server: McpServer): void {
  server.registerResource(
    'session',
    new ResourceTemplate('souvenir://session/{sessionId}', {
      list: () => {
        const project = getConfig().currentProject;
        if (!project) return { resources: [] };
        const sessions = getSessions(project, { sort: 'newest' }).slice(0, LISTED_SESSIONS);
        return {
          // title and description per session, or the SDK repeats the template's on every entry
          resources: sessions.map((s) => ({
            uri: sessionUri(s.sessionId),
            name: sessionLabel(s),
            title: sessionLabel(s),
            description: sessionDescription(s),
            mimeType: 'text/plain',
          })),
        };
      },
    }),
    {
      title: 'Past Claude Code session',
      description: `A past Claude Code session: header, files it touched and its last entries. The ${LISTED_SESSIONS} most recent sessions of the current project are listed; any session can be read by its URI (session ids from souvenir_sessions).`,
      mimeType: 'text/plain',
    },
    async (uri, { sessionId }) => {
      const id = Array.isArray(sessionId) ? sessionId[0] : sessionId;
      const text = id ? await readSessionDigest(id) : null;
      if (text === null) throw new ResourceNotFoundError(uri.href, `No session "${id}" in any project`);
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
    },
  );
}
