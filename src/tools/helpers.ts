import type { RecallConfig } from '../config.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { LocalEmbeddingProvider } from '../embedding/local.js';
import { OpenAIEmbeddingProvider } from '../embedding/openai.js';

/**
 * Create an embedding provider based on config.
 */
export function createEmbeddingProvider(config: RecallConfig): EmbeddingProvider {
  switch (config.embeddingProvider) {
    case 'local':
      return new LocalEmbeddingProvider();

    case 'openai':
      if (!config.openaiApiKey) {
        throw new Error(
          'OpenAI provider requires RECALL_OPENAI_API_KEY environment variable. ' +
          'Set it in your .mcp.json env section or system environment.',
        );
      }
      return new OpenAIEmbeddingProvider(config.openaiApiKey, config.embeddingDimensions);

    default:
      throw new Error(`Unknown embedding provider: "${config.embeddingProvider}". Use "local" or "openai".`);
  }
}
