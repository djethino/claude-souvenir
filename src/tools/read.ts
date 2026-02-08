import { getSessionFilePath, getSessionMetadata } from '../transcript/discovery.js';
import { parseTranscript } from '../transcript/parser.js';
import { formatEntry, formatSessionHeader } from '../transcript/formatter.js';
import { getConfig } from '../config.js';
import { resolveProjectDir } from '../utils/paths.js';

export async function handleRecallRead(params: {
  session_id: string;
  project?: string;
  around_uuid?: string;
  from_line?: number;
  max_entries?: number;
  context_turns?: number;
  include_tool_details?: boolean;
  entry_types?: string;
}): Promise<string> {
  const config = getConfig();
  const projectDir = params.project
    ? resolveProjectDir(params.project)
    : undefined;

  // Find the session file
  const location = getSessionFilePath(params.session_id, projectDir || config.currentProject || undefined);
  if (!location) {
    return `Error: Session "${params.session_id}" not found.${!projectDir ? ' Try specifying the project parameter.' : ''}`;
  }

  // Get session metadata
  const meta = getSessionMetadata(params.session_id, location.projectDir);

  // Parse entry types
  const entryTypes = params.entry_types
    ? params.entry_types.split(',').map((t) => t.trim())
    : ['user', 'assistant', 'summary'];

  const maxEntries = Math.min(params.max_entries || 20, 100);
  const includeToolDetails = params.include_tool_details ?? false;

  // If around_uuid is specified, we need to find it first then get context
  if (params.around_uuid) {
    return await readAroundUuid(
      location.filePath,
      params.around_uuid,
      params.context_turns || 3,
      entryTypes,
      includeToolDetails,
      meta,
    );
  }

  // Standard sequential read
  const output: string[] = [];

  // Header
  if (meta) {
    output.push(formatSessionHeader(meta.entry));
    output.push('---');
  }

  let count = 0;
  const stream = parseTranscript(location.filePath, {
    includeTypes: entryTypes,
    fromLine: params.from_line || 1,
    maxEntries,
  });

  for await (const { entry, lineNumber } of stream) {
    const formatted = formatEntry(entry, { includeToolDetails });
    if (formatted) {
      output.push(`[L${lineNumber}] ${formatted}`);
      output.push('');
      count++;
    }
  }

  if (count === 0) {
    output.push('(No matching entries found)');
  } else if (count === maxEntries) {
    output.push(`--- Showing ${count} entries. Use from_line or max_entries to see more. ---`);
  }

  return output.join('\n');
}

async function readAroundUuid(
  filePath: string,
  targetUuid: string,
  contextTurns: number,
  entryTypes: string[],
  includeToolDetails: boolean,
  meta: ReturnType<typeof getSessionMetadata>,
): Promise<string> {
  // First pass: collect all matching entries and find the target
  const allEntries: Array<{ entry: import('../transcript/types.js').TranscriptEntry; lineNumber: number }> = [];
  let targetIndex = -1;

  const stream = parseTranscript(filePath, { includeTypes: entryTypes });

  for await (const parsed of stream) {
    allEntries.push(parsed);
    if (parsed.entry.uuid === targetUuid) {
      targetIndex = allEntries.length - 1;
    }
  }

  if (targetIndex === -1) {
    return `Error: Entry with UUID "${targetUuid}" not found in this session.`;
  }

  // Calculate context window
  const start = Math.max(0, targetIndex - contextTurns);
  const end = Math.min(allEntries.length, targetIndex + contextTurns + 1);
  const slice = allEntries.slice(start, end);

  const output: string[] = [];

  if (meta) {
    output.push(formatSessionHeader(meta.entry));
    output.push('---');
    output.push(`(Showing context around entry ${targetIndex + 1}/${allEntries.length})`);
    output.push('');
  }

  for (const { entry, lineNumber } of slice) {
    const isTarget = entry.uuid === targetUuid;
    const marker = isTarget ? '>>> ' : '    ';
    const formatted = formatEntry(entry, { includeToolDetails });
    if (formatted) {
      output.push(`${marker}[L${lineNumber}] ${formatted}`);
      output.push('');
    }
  }

  return output.join('\n');
}
