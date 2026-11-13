import { ProtocolError, ProtocolErrorCode, type GetPromptResult, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getConfig } from './config.js';
import { getSessions } from './transcript/discovery.js';
import { readSessionDigest } from './tools/read.js';
import { handleSouvenirSearch } from './tools/search.js';
import { sessionLabel, sessionUri } from './resources.js';

/** Recent sessions offered to the recap prompt when no session is named (the newest may be the current one). */
const RECAP_CANDIDATES = 3;

/** Conversation matches the why prompt hands over. */
const WHY_MATCHES = 15;

const RECAP_INSTRUCTIONS = `Recap this past Claude Code session for the user, in their language:
- the goal and how it evolved;
- what was done and decided, with the reasons;
- the files changed;
- the state at the end: what works, what was left unfinished or open.
Read more of the session with souvenir_read when the digest is not enough to answer.`;

/** A prompt request that cannot be served with these arguments (JSON-RPC invalid params, not an internal error). */
function invalidArgument(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function userText(text: string): GetPromptResult['messages'][number] {
  return { role: 'user', content: { type: 'text', text } };
}

/**
 * MCP prompts, offered by Claude Code as commands:
 * - recap [session]: recap a past session (default: the latest one that is not this conversation);
 * - why <file>: why a file changed, from the conversations that changed it.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'recap',
    {
      title: 'Recap a past session',
      description: 'Recap a past Claude Code session of this project: goal, decisions, files changed, what was left open. Without a session id, the latest session that is not the current conversation.',
      argsSchema: z.object({
        session: z.string().optional().describe('Session id (from souvenir_sessions or the @ list). Default: the latest previous session.'),
      }),
    },
    async ({ session }) => {
      if (session) {
        const digest = await readSessionDigest(session);
        if (digest === null) throw invalidArgument(`No session "${session}" in any project. List them with souvenir_sessions.`);
        return {
          messages: [
            { role: 'user', content: { type: 'resource', resource: { uri: sessionUri(session), mimeType: 'text/plain', text: digest } } },
            userText(RECAP_INSTRUCTIONS),
          ],
        };
      }

      const project = getConfig().currentProject;
      if (!project) throw invalidArgument('This directory has no Claude Code history: give a session id (souvenir_sessions project="all" lists them).');
      const recent = getSessions(project, { sort: 'newest' }).slice(0, RECAP_CANDIDATES);
      if (recent.length === 0) throw invalidArgument('No past session in this project.');
      const list = recent.map((s, i) => `${i + 1}. ${sessionLabel(s)} — session_id: ${s.sessionId}`).join('\n');
      return {
        messages: [
          userText(
            `The most recent sessions of this project, newest first:\n${list}\n\n` +
            'The newest one can be this very conversation: if its first prompt is what started the current conversation, take the next one. ' +
            'Read the chosen session with souvenir_read (start from the end, then earlier pages as needed).\n\n' +
            RECAP_INSTRUCTIONS,
          ),
        ],
      };
    },
  );

  server.registerPrompt(
    'why',
    {
      title: 'Why did this file change?',
      description: 'Explain why a file changed, from the past conversations that changed it (and its git history).',
      argsSchema: z.object({
        file: z.string().describe('File path or name, as it appears in the project (no spaces: Claude Code splits arguments on whitespace).'),
      }),
    },
    async ({ file }) => {
      const matches = await handleSouvenirSearch({ query: file, mode: 'text', max_results: WHY_MATCHES });
      return {
        messages: [
          userText(
            `Explain to the user, in their language, why "${file}" changed: what each change was for and what decided it.\n\n` +
            '1. If the project is a git repository, read the file\'s history (`git log --follow -- <path>`) and search the commit hashes in the conversations with souvenir_search.\n' +
            '2. Read the moments that matter with souvenir_read around_uuid (the matches below are a start; search again with other terms if they are not enough).\n' +
            '3. Answer chronologically: each change, its reason, the decision behind it, with the session date. Say what you could not find.\n\n' +
            `Conversation matches for "${file}":\n\n${matches}`,
          ),
        ],
      };
    },
  );
}
