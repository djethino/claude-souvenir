import { cwdToProjectDir, getProjectsDir } from './utils/paths.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './utils/logger.js';

export type EmbeddingProvider = 'local' | 'openai';

export interface RecallConfig {
  /** Current working directory (from Claude Code) */
  cwd: string;
  /** Current project directory name (e.g. D--projet-claude-plugins) */
  currentProject: string | null;
  /** Embedding provider: 'local' or 'openai' */
  embeddingProvider: EmbeddingProvider;
  /** OpenAI API key (required if provider is 'openai') */
  openaiApiKey: string | null;
  /** Embedding dimensions */
  embeddingDimensions: number;
}

let _config: RecallConfig | null = null;

/**
 * Detect the current project from CWD.
 */
function detectCurrentProject(cwd: string): string | null {
  const projectDir = cwdToProjectDir(cwd);
  const projectPath = join(getProjectsDir(), projectDir);

  if (existsSync(projectPath)) {
    logger.info(`Detected project: ${projectDir}`);
    return projectDir;
  }

  logger.warn(`Project directory not found for CWD: ${cwd} (expected: ${projectPath})`);
  return null;
}

/**
 * Initialize and return the configuration.
 */
export function getConfig(): RecallConfig {
  if (_config) return _config;

  const cwd = process.env.CWD || process.cwd();
  const provider = (process.env.RECALL_PROVIDER || 'local') as EmbeddingProvider;

  _config = {
    cwd,
    currentProject: detectCurrentProject(cwd),
    embeddingProvider: provider,
    openaiApiKey: process.env.RECALL_OPENAI_API_KEY || null,
    embeddingDimensions: parseInt(process.env.RECALL_EMBEDDING_DIMENSIONS || '384', 10),
  };

  logger.info('Config loaded:', {
    cwd: _config.cwd,
    currentProject: _config.currentProject,
    embeddingProvider: _config.embeddingProvider,
    embeddingDimensions: _config.embeddingDimensions,
  });

  return _config;
}
