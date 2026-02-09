import type { SearchResult } from '../transcript/types.js';

/**
 * Compute the longest run of consecutive line numbers where the gap between
 * adjacent lines is at most `maxGap`.
 */
function computeMaxRunLength(lineNumbers: number[], maxGap = 5): number {
  if (lineNumbers.length <= 1) return lineNumbers.length;

  const sorted = [...lineNumbers].sort((a, b) => a - b);
  let maxRun = 1;
  let currentRun = 1;

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] <= maxGap) {
      currentRun++;
    } else {
      currentRun = 1;
    }
    if (currentRun > maxRun) {
      maxRun = currentRun;
    }
  }

  return maxRun;
}

export interface DensityBoostResult {
  results: SearchResult[];
  sessionHitCounts: Map<string, number>;
}

/**
 * Apply session-level density boost to search results.
 *
 * Sessions with many hits, consecutive chunks, and recent activity
 * get a score multiplier that pushes their results higher in the ranking.
 *
 * Formula:
 *   densityBonus    = min(0.35, 0.15 * ln(hitCount))
 *   proximityBonus  = 0.15 * proximityRatio * min(1, (hitCount-1)/2)
 *   recencyBonus    = 0.15 * max(0, 1 - ageDays/365)
 *   multiplier      = 1 + densityBonus + proximityBonus + recencyBonus
 *
 * Range: [1.0 .. ~1.65]
 */
export function applySessionDensityBoost(results: SearchResult[]): DensityBoostResult {
  if (results.length === 0) {
    return { results: [], sessionHitCounts: new Map() };
  }

  // Group by sessionId
  const groups = new Map<string, SearchResult[]>();
  for (const r of results) {
    const group = groups.get(r.sessionId);
    if (group) {
      group.push(r);
    } else {
      groups.set(r.sessionId, [r]);
    }
  }

  const sessionHitCounts = new Map<string, number>();
  const now = Date.now();

  // Compute per-session multiplier and apply
  for (const [sessionId, group] of groups) {
    const hitCount = group.length;
    sessionHitCounts.set(sessionId, hitCount);

    // Density bonus: logarithmic, capped at 0.35
    // 1 hit → 0, 2 → 0.10, 5 → 0.24, 10 → 0.34, 11+ → 0.35
    const densityBonus = Math.min(0.35, 0.15 * Math.log(hitCount));

    // Proximity bonus: rewards consecutive chunks
    const lineNumbers = group.map((r) => r.lineNumber).filter((n) => n > 0);
    const maxRunLength = computeMaxRunLength(lineNumbers);
    const proximityRatio = hitCount > 0 ? maxRunLength / hitCount : 0;
    const proximityBonus = 0.15 * proximityRatio * Math.min(1, (hitCount - 1) / 2);

    // Recency bonus: based on the newest timestamp in the session group
    let recencyBonus = 0;
    const timestamps = group
      .map((r) => r.timestamp)
      .filter((t): t is string => !!t)
      .map((t) => new Date(t).getTime())
      .filter((t) => !isNaN(t));

    if (timestamps.length > 0) {
      const newestTs = Math.max(...timestamps);
      const ageDays = Math.max(0, (now - newestTs) / (1000 * 60 * 60 * 24));
      recencyBonus = 0.15 * Math.max(0, 1 - ageDays / 365);
    }

    const multiplier = 1 + densityBonus + proximityBonus + recencyBonus;

    // Apply multiplier to each chunk in this session
    for (const r of group) {
      r.score *= multiplier;
    }
  }

  // Re-sort by score descending
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.timestamp || '').localeCompare(a.timestamp || '');
  });

  return { results, sessionHitCounts };
}
