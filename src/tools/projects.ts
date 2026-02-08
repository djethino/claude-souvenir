import { listProjectDirs, getProjectInfo } from '../transcript/discovery.js';

export async function handleRecallProjects(params: {
  search?: string;
}): Promise<string> {
  const allDirs = listProjectDirs();

  const projects = allDirs
    .map((dir) => getProjectInfo(dir))
    .filter((p): p is NonNullable<typeof p> => p !== null && p.sessionCount > 0);

  // Filter by search term
  let filtered = projects;
  if (params.search) {
    const term = params.search.toLowerCase();
    filtered = projects.filter(
      (p) =>
        p.originalPath.toLowerCase().includes(term) ||
        p.dirName.toLowerCase().includes(term),
    );
  }

  // Sort by latest date
  filtered.sort((a, b) => {
    const dateA = a.latestDate ? new Date(a.latestDate).getTime() : 0;
    const dateB = b.latestDate ? new Date(b.latestDate).getTime() : 0;
    return dateB - dateA;
  });

  if (filtered.length === 0) {
    return params.search
      ? `No projects found matching "${params.search}".`
      : 'No projects with transcripts found.';
  }

  const lines = [`Found ${filtered.length} project(s):\n`];

  for (let i = 0; i < filtered.length; i++) {
    const p = filtered[i];
    const latest = p.latestDate ? p.latestDate.slice(0, 10) : '???';
    const oldest = p.oldestDate ? p.oldestDate.slice(0, 10) : '???';

    lines.push(`${i + 1}. ${p.originalPath}`);
    lines.push(`   Dir: ${p.dirName}`);
    lines.push(`   Sessions: ${p.sessionCount} | Latest: ${latest} | Oldest: ${oldest}`);
    lines.push('');
  }

  return lines.join('\n');
}
