import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type InputRequiredResult,
} from '@modelcontextprotocol/server';
import type { ToolContext } from './helpers.js';

/**
 * Asks the user to confirm a destructive action (MCP elicitation, multi-round-trip pattern).
 * Returns true to go ahead (accepted, or the client cannot ask), false when the user declined
 * or cancelled. When the user has not answered yet, it throws ConfirmationNeeded: the tool
 * returns the question, the client shows it and calls the tool again with the answer, and the
 * handler runs again from the start (its checks run before the question, so it is asked only
 * for an action that can actually be done).
 */
export type Confirm = (message: string) => boolean;

/**
 * Text a tool returns when its confirmation was not accepted. A client that declares elicitation but
 * cannot show a dialog (claude -p, the Agent SDK) cancels it: the action needs an interactive session.
 */
export const DECLINED =
  'Cancelled: not confirmed (the user declined or dismissed the dialog, or this session cannot show one, ' +
  'as in claude -p: run it from an interactive session). Nothing was changed.';

const CONFIRM_KEY = 'confirm';

/** Thrown by Confirm until the user has answered; the tool wrapper turns it into the question. */
export class ConfirmationNeeded extends Error {
  constructor(readonly question: string) {
    super(`Confirmation needed: ${question}`);
  }

  toInputRequired(): InputRequiredResult {
    return inputRequired({
      inputRequests: {
        // No field: the dialog shows the message with accept / decline
        [CONFIRM_KEY]: inputRequired.elicit({ message: this.question, requestedSchema: { type: 'object', properties: {} } }),
      },
    });
  }
}

/**
 * Confirm for one tool call.
 * @param legacyCapabilities the client capabilities declared at `initialize`, used on a
 *   connection older than 2026-07-28 (which has no per-request capabilities)
 */
export function confirmFor(ctx: ToolContext, legacyCapabilities: () => ClientCapabilities | undefined): Confirm {
  return (message) => {
    const answer = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY);
    if (answer.kind === 'elicit') return answer.action === 'accept';

    // Protocol 2026-07-28: capabilities come with each request; earlier: declared at initialize
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const capabilities = envelope
      ? (envelope[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined)
      : legacyCapabilities();
    // A client that cannot show a dialog keeps the behaviour from before confirmations existed
    if (!capabilities?.elicitation) return true;

    throw new ConfirmationNeeded(message);
  };
}
