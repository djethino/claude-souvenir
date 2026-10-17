/**
 * Plugin options declared in .claude-plugin/plugin.json (userConfig).
 *
 * Claude Code exports them to hooks as CLAUDE_PLUGIN_OPTION_<KEY>, and .mcp.json passes them
 * to the MCP server under the same names, so both read them here. An option that is not set
 * arrives as an empty string.
 */

import { isAbsolute } from 'path';

export type EmbeddingProviderType = 'ollama' | 'openai';

const PROVIDERS: readonly EmbeddingProviderType[] = ['ollama', 'openai'];

export interface PluginOptions {
  embeddingProvider: EmbeddingProviderType;
  /** Undefined = provider default */
  embeddingUrl?: string;
  /** Undefined = provider default */
  embeddingModel?: string;
  /** Undefined = the model's native size */
  embeddingDimensions?: number;
  embeddingApiKey?: string;
  /** Undefined = default location in the Claude config directory */
  dbPath?: string;
}

function option(key: string): string | undefined {
  const value = process.env[`CLAUDE_PLUGIN_OPTION_${key}`]?.trim();
  return value ? value : undefined;
}

/** Read and validate the plugin options. Throws with the option name when a value is invalid. */
export function readPluginOptions(): PluginOptions {
  const provider = option('EMBEDDING_PROVIDER') ?? 'ollama';
  if (!PROVIDERS.includes(provider as EmbeddingProviderType)) {
    throw new Error(`Invalid embedding_provider "${provider}": use ${PROVIDERS.join(' or ')}`);
  }

  const dimensionsText = option('EMBEDDING_DIMENSIONS');
  let embeddingDimensions: number | undefined;
  if (dimensionsText !== undefined) {
    embeddingDimensions = Number(dimensionsText);
    if (!Number.isInteger(embeddingDimensions) || embeddingDimensions <= 0) {
      throw new Error(`Invalid embedding_dimensions "${dimensionsText}": expected a positive integer`);
    }
  }

  const dbPath = option('DB_PATH');
  if (dbPath !== undefined && !isAbsolute(dbPath)) {
    throw new Error(`Invalid db_path "${dbPath}": it must be an absolute path`);
  }

  return {
    embeddingProvider: provider as EmbeddingProviderType,
    embeddingUrl: option('EMBEDDING_URL'),
    embeddingModel: option('EMBEDDING_MODEL'),
    embeddingDimensions,
    embeddingApiKey: option('EMBEDDING_API_KEY'),
    dbPath,
  };
}
