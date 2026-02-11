import type { RecallConfig } from '../config.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { OllamaEmbeddingProvider } from '../embedding/ollama.js';
import { OpenAIEmbeddingProvider } from '../embedding/openai.js';

/**
 * Create an embedding provider based on config.
 */
export function createEmbeddingProvider(config: RecallConfig): EmbeddingProvider {
  switch (config.embeddingProvider) {
    case 'ollama':
      return new OllamaEmbeddingProvider(config.ollamaUrl, config.ollamaModel);

    case 'openai':
      if (!config.openaiApiKey) {
        throw new Error(
          'OpenAI provider requires RECALL_OPENAI_API_KEY environment variable. ' +
          'Set it in your .mcp.json env section or system environment.',
        );
      }
      return new OpenAIEmbeddingProvider(config.openaiApiKey, config.embeddingDimensions);

    default:
      throw new Error(`Unknown embedding provider: "${config.embeddingProvider}". Use "ollama" or "openai".`);
  }
}

// ---------------------------------------------------------------------------
// Singleton provider - keeps model in memory across calls
// ---------------------------------------------------------------------------

let _singletonProvider: EmbeddingProvider | null = null;
let _singletonProviderType: string | null = null;

/**
 * Get the singleton embedding provider, creating it if needed.
 * The provider stays in memory to avoid reloading the model (~300MB) on every call.
 * If the provider type changes (e.g. local → openai), the old one is disposed and a new one is created.
 */
export function getOrCreateProvider(config: RecallConfig): EmbeddingProvider {
  if (_singletonProvider && _singletonProviderType === config.embeddingProvider) {
    return _singletonProvider;
  }

  // Type changed or first call — create a new provider
  // Note: we don't await dispose() here since it's sync-safe for our providers
  // and we want getOrCreateProvider to remain synchronous
  if (_singletonProvider) {
    _singletonProvider.dispose().catch(() => {});
  }

  _singletonProvider = createEmbeddingProvider(config);
  _singletonProviderType = config.embeddingProvider;
  return _singletonProvider;
}

/**
 * Check if the singleton provider is loaded and ready (model in memory).
 */
export function isProviderLoaded(): boolean {
  return _singletonProvider !== null && _singletonProvider.isReady();
}
