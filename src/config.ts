import { cwdToProjectDir, getProjectsDir } from './utils/paths.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './utils/logger.js';
import { type EmbeddingProviderType, readPluginOptions } from './options.js';

/** Defaults used when the embedding_url / embedding_model options are empty. */
const PROVIDER_DEFAULTS: Record<EmbeddingProviderType, { url: string; model: string }> = {
  ollama: { url: 'http://localhost:11434', model: 'embeddinggemma' },
  openai: { url: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
};

export interface EmbeddingSettings {
  provider: EmbeddingProviderType;
  /** Server base URL (Ollama root, or OpenAI-compatible base ending in /v1) */
  url: string;
  model: string;
  /** Requested vector size; undefined = the model's native size */
  dimensions?: number;
  apiKey?: string;
}

export interface SouvenirConfig {
  /** Current working directory (from Claude Code) */
  cwd: string;
  /** Current project directory name (e.g. D--projet-claude-plugins) */
  currentProject: string | null;
  embedding: EmbeddingSettings;
}

let _config: SouvenirConfig | null = null;

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
export function getConfig(): SouvenirConfig {
  if (_config) return _config;

  const cwd = process.env.CWD || process.cwd();
  const options = readPluginOptions();
  const defaults = PROVIDER_DEFAULTS[options.embeddingProvider];

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
    embedding: {
      provider: options.embeddingProvider,
      url: (options.embeddingUrl ?? defaults.url).replace(/\/+$/, ''),
      model: options.embeddingModel ?? defaults.model,
      dimensions: options.embeddingDimensions,
      apiKey: options.embeddingApiKey,
    },
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
