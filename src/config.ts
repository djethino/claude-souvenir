import { cwdToProjectDir, getProjectsDir } from './utils/paths.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './utils/logger.js';

export type EmbeddingProviderType = 'ollama' | 'openai';

export interface RecallConfig {
  /** Current working directory (from Claude Code) */
  cwd: string;
  /** Current project directory name (e.g. D--projet-claude-plugins) */
  currentProject: string | null;
  /** Embedding provider: 'ollama' or 'openai' */
  embeddingProvider: EmbeddingProviderType;
  /** OpenAI API key (required if provider is 'openai') */
  openaiApiKey: string | null;
  /** Embedding dimensions */
  embeddingDimensions: number;
  /** Ollama server URL (default http://localhost:11434) */
  ollamaUrl: string;
  /** Ollama model name (default 'embeddinggemma') */
  ollamaModel: string;
}

let _config: RecallConfig | null = null;

/**
 * Try to resolve a path to a project directory name.
 * Returns null if the path doesn't match any known project.
 */
function resolvePathToProject(path: string): string | null {
  const projectDir = cwdToProjectDir(path);
  const projectPath = join(getProjectsDir(), projectDir);

  if (existsSync(projectPath)) {
    return projectDir;
  }
  return null;
}

/**
 * Initialize and return the configuration.
 * currentProject may be null initially and set later via setCurrentProjectFromRoots().
 */
export function getConfig(): RecallConfig {
  if (_config) return _config;

  const cwd = process.env.CWD || process.cwd();
  const provider = (process.env.RECALL_PROVIDER || 'ollama') as EmbeddingProviderType;

  // Try CWD-based detection (works if CWD env is properly set by Claude Code)
  const detectedProject = resolvePathToProject(cwd);
  if (detectedProject) {
    logger.info(`Detected project from CWD: ${detectedProject}`);
  } else {
    logger.info(`CWD "${cwd}" did not match any project. Waiting for MCP roots.`);
  }

  _config = {
    cwd,
    currentProject: detectedProject,
    embeddingProvider: provider,
    openaiApiKey: process.env.RECALL_OPENAI_API_KEY || null,
    embeddingDimensions: parseInt(process.env.RECALL_EMBEDDING_DIMENSIONS || '768', 10),
    ollamaUrl: process.env.RECALL_OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.RECALL_OLLAMA_MODEL || 'embeddinggemma',
  };

  return _config;
}

/**
 * Update the current project from MCP roots (called after server connects).
 * This is the reliable detection method: Claude Code provides workspace roots via MCP protocol.
 */
export function setCurrentProjectFromRoots(roots: Array<{ uri: string; name?: string }>): void {
  if (!_config) getConfig();

  // Already detected from CWD
  if (_config!.currentProject) {
    logger.info(`Project already detected: ${_config!.currentProject}`);
    return;
  }

  for (const root of roots) {
    let path: string = root.uri;

    // Strip file:// prefix (Claude Code may send non-standard file://D:\... format)
    if (path.startsWith('file:///')) {
      path = decodeURIComponent(path.slice(7)); // file:///D:/path → D:/path
    } else if (path.startsWith('file://')) {
      path = decodeURIComponent(path.slice(7)); // file://D:\path → D:\path
    }

    // On Windows, URL pathname may start with /D:/ - remove leading slash
    if (/^\/[A-Za-z]:/.test(path)) {
      path = path.slice(1);
    }

    const project = resolvePathToProject(path);
    if (project) {
      _config!.currentProject = project;
      _config!.cwd = path;
      logger.info(`Detected project from MCP roots: ${project} (${path})`);
      return;
    }
  }

  logger.warn('MCP roots did not match any known project:', roots.map((r) => r.uri));
}
