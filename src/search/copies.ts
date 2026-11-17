import { createHash } from 'crypto';
import type { SearchResult } from '../transcript/types.js';

/**
 * Merges the copies of one entry found in several sessions.
 *
 * When a session is resumed or forked, Claude Code writes earlier entries again into the new
 * session's transcript: same entry uuid, same message, only the session fields differ (checked on
 * the real archive: 2,532 such lines, 6 of them with a different message). A result counts as a
 * copy only when its entry uuid AND its full text equal those of a result already kept from another
 * session: an entry whose text differs between transcripts stays a result of its own.
 * The first result kept stands for the passage, and lists the sessions of its copies.
 */
export class CopyMerger {
  private readonly kept = new Map<string, SearchResult>();

  /**
   * Whether `result` is a copy of a result already kept, whose `alsoInSessions` then records its
   * session: the caller drops it. Otherwise `result` is kept and stands for its later copies.
   * `fullText`: the whole text the result was matched on (results only carry an excerpt).
   */
  isCopy(result: SearchResult, fullText: string): boolean {
    if (!result.entryUuid) return false;
    const key = `${result.entryUuid}\0${createHash('sha1').update(fullText).digest('hex')}`;
    const original = this.kept.get(key);
    if (!original) {
      this.kept.set(key, result);
      return false;
    }
    if (original.sessionId === result.sessionId) return false;
    const sessions = (original.alsoInSessions ??= []);
    if (!sessions.includes(result.sessionId)) sessions.push(result.sessionId);
    return true;
  }
}

/** The sessions a result was found in: its own and those holding a copy of it. */
export function sessionsOf(result: SearchResult): string[] {
  return [result.sessionId, ...(result.alsoInSessions ?? [])];
}
