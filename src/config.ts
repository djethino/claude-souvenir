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
  /** Project root: CLAUDE_PROJECT_DIR (set by Claude Code), else the process working directory */
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
 *
 * The current project comes from CLAUDE_PROJECT_DIR, which Claude Code sets for MCP servers and
 * hooks: the session's stable project root, unchanged when Claude runs `cd` (a hook's input `cwd`
 * follows it). Outside Claude Code (manual runs), the process working directory is used.
 * currentProject is null when that directory has no Claude Code history.
 */
export function getConfig(): SouvenirConfig {
  if (_config) return _config;

  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  const cwd = fromEnv || process.cwd();
  const options = readPluginOptions();
  const defaults = PROVIDER_DEFAULTS[options.embeddingProvider];

  const detectedProject = resolvePathToProject(cwd);
  const source = fromEnv ? 'CLAUDE_PROJECT_DIR' : 'working directory (CLAUDE_PROJECT_DIR not set)';
  if (detectedProject) {
    logger.info(`Current project from ${source}: ${detectedProject}`);
  } else {
    logger.info(`${source} "${cwd}" has no Claude Code history: no current project.`);
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
