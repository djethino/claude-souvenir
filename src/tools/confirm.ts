import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type InputRequiredResult,
} from '@modelcontextprotocol/server';
import { createHash } from 'crypto';
import type { ToolContext } from './helpers.js';

/**
 * Asks the user to confirm a destructive action (MCP elicitation, multi-round-trip pattern).
 * Returns true to go ahead (accepted, or the client cannot ask), false when the user declined
 * or cancelled. When the user has not answered yet, it throws ConfirmationNeeded: the tool
 * returns the question, the client shows it and calls the tool again with the answer, and the
 * handler runs again from the start (its checks run before the question, so it is asked only
 * for an action that can actually be done).
 */
export type Confirm = (message: string, options?: { required?: boolean }) => boolean;

/**
 * Text a tool returns when its confirmation was not accepted. A client that declares elicitation but
 * cannot show a dialog (claude -p, the Agent SDK) cancels it: the action needs an interactive session.
 */
export const DECLINED =
  'Cancelled: not confirmed (the user declined or dismissed the dialog, or this session cannot show one, ' +
  'as in claude -p: run it from an interactive session). Nothing was changed.';

/**
 * Key of the question, derived from its text: an answer applies only to the exact question shown.
 * The handler runs again from the start with the answer; if what it would do changed meanwhile
 * (the question differs), the user is asked again instead of the old answer being used.
 */
function confirmKey(question: string): string {
  return `confirm-${createHash('sha256').update(question).digest('hex').slice(0, 16)}`;
}

/** Thrown by Confirm until the user has answered; the tool wrapper turns it into the question. */
export class ConfirmationNeeded extends Error {
  constructor(readonly question: string) {
    super(`Confirmation needed: ${question}`);
  }

  toInputRequired(): InputRequiredResult {
    return inputRequired({
      inputRequests: {
        // No field: the dialog shows the message with accept / decline
        [confirmKey(this.question)]: inputRequired.elicit({ message: this.question, requestedSchema: { type: 'object', properties: {} } }),
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
  return (message, options) => {
    const answer = inputResponse(ctx.mcpReq.inputResponses, confirmKey(message));
    if (answer.kind === 'elicit') return answer.action === 'accept';

    // Protocol 2026-07-28: capabilities come with each request; earlier: declared at initialize
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const capabilities = envelope
      ? (envelope[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined)
      : legacyCapabilities();
    // A client that cannot show a dialog keeps the behaviour from before confirmations existed,
    // except for what cannot be undone (required): it is refused without the user's answer
    if (!capabilities?.elicitation) return !options?.required;

    throw new ConfirmationNeeded(message);
  };
}
