/**
 * Placeholder for semantic search (Phase 3).
 */
export async function semanticSearch(_options: {
  query: string;
  projectDirs: string[];
  topK?: number;
}): Promise<{ results: never[]; totalMatches: number }> {
  return { results: [], totalMatches: 0 };
}
