/**
 * Simple unified diff implementation using LCS (Longest Common Subsequence).
 * Zero external dependencies.
 */

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  stats: { added: number; removed: number; unchanged: number };
}

/**
 * Compute the LCS table for two arrays of lines.
 * Returns a 2D array where lcs[i][j] = length of LCS of a[0..i-1] and b[0..j-1].
 *
 * For very large files (> 5000 lines each), this could be memory-intensive.
 * In practice, source files rarely exceed that, and the 10 MB file size limit
 * in the indexer prevents truly abusive cases.
 */
function buildLcsTable(a: string[], b: string[]): Uint16Array[] {
  const m = a.length;
  const n = b.length;

  // Use Uint16Array for memory efficiency (max LCS length = 65535, far beyond our use case)
  const table: Uint16Array[] = new Array(m + 1);
  for (let i = 0; i <= m; i++) {
    table[i] = new Uint16Array(n + 1);
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }

  return table;
}

/**
 * Backtrack through the LCS table to produce a sequence of diff operations.
 */
function backtrack(
  table: Uint16Array[],
  a: string[],
  b: string[],
): DiffLine[] {
  const result: DiffLine[] = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: 'context', content: a[i - 1], oldLine: i, newLine: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      result.push({ type: 'add', content: b[j - 1], newLine: j });
      j--;
    } else {
      result.push({ type: 'remove', content: a[i - 1], oldLine: i });
      i--;
    }
  }

  return result.reverse();
}

/**
 * Group diff lines into hunks with context lines, like `git diff`.
 */
function groupIntoHunks(lines: DiffLine[], contextLines: number): DiffHunk[] {
  // Find ranges of changes (non-context lines)
  const changeIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'context') {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Group changes that are close together (within 2 * contextLines)
  const groups: Array<{ start: number; end: number }> = [];
  let groupStart = changeIndices[0];
  let groupEnd = changeIndices[0];

  for (let i = 1; i < changeIndices.length; i++) {
    if (changeIndices[i] - groupEnd <= contextLines * 2) {
      groupEnd = changeIndices[i];
    } else {
      groups.push({ start: groupStart, end: groupEnd });
      groupStart = changeIndices[i];
      groupEnd = changeIndices[i];
    }
  }
  groups.push({ start: groupStart, end: groupEnd });

  // Build hunks from groups
  const hunks: DiffHunk[] = [];

  for (const group of groups) {
    const hunkStart = Math.max(0, group.start - contextLines);
    const hunkEnd = Math.min(lines.length - 1, group.end + contextLines);

    const hunkLines = lines.slice(hunkStart, hunkEnd + 1);

    // Calculate old/new line ranges
    let oldStart = 0;
    let oldCount = 0;
    let newStart = 0;
    let newCount = 0;

    for (const line of hunkLines) {
      if (line.type === 'context') {
        if (oldStart === 0 && line.oldLine) oldStart = line.oldLine;
        if (newStart === 0 && line.newLine) newStart = line.newLine;
        oldCount++;
        newCount++;
      } else if (line.type === 'remove') {
        if (oldStart === 0 && line.oldLine) oldStart = line.oldLine;
        oldCount++;
      } else if (line.type === 'add') {
        if (newStart === 0 && line.newLine) newStart = line.newLine;
        newCount++;
      }
    }

    // Fallback for start positions
    if (oldStart === 0) oldStart = 1;
    if (newStart === 0) newStart = 1;

    hunks.push({
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: hunkLines,
    });
  }

  return hunks;
}

/**
 * Compute a diff between two texts.
 * @param oldText - Original text
 * @param newText - Modified text
 * @param contextLines - Number of context lines around changes (default: 3)
 */
export function computeDiff(
  oldText: string,
  newText: string,
  contextLines = 3,
): DiffResult {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Remove trailing empty line from split (if text ends with \n)
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();

  const table = buildLcsTable(oldLines, newLines);
  const diffLines = backtrack(table, oldLines, newLines);
  const hunks = groupIntoHunks(diffLines, contextLines);

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const line of diffLines) {
    if (line.type === 'add') added++;
    else if (line.type === 'remove') removed++;
    else unchanged++;
  }

  return { hunks, stats: { added, removed, unchanged } };
}

/**
 * Format a diff result as unified diff text (similar to `git diff` output).
 */
export function formatUnifiedDiff(
  diff: DiffResult,
  oldLabel: string,
  newLabel: string,
): string {
  if (diff.hunks.length === 0) {
    return 'No differences found.';
  }

  const lines: string[] = [];
  lines.push(`--- ${oldLabel}`);
  lines.push(`+++ ${newLabel}`);

  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);

    for (const line of hunk.lines) {
      if (line.type === 'context') {
        lines.push(` ${line.content}`);
      } else if (line.type === 'remove') {
        lines.push(`-${line.content}`);
      } else if (line.type === 'add') {
        lines.push(`+${line.content}`);
      }
    }
  }

  lines.push('');
  lines.push(`${diff.stats.added} addition(s), ${diff.stats.removed} deletion(s)`);

  return lines.join('\n');
}
