import type { SouvenirConfig } from '../config.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { OllamaEmbeddingProvider } from '../embedding/ollama.js';
import { OpenAIEmbeddingProvider } from '../embedding/openai.js';
import type { IndexProgress } from '../db/indexer.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// MCP progress notifications for long-running operations
// ---------------------------------------------------------------------------

/** MCP tool handler extra parameter (re-exported from SDK for convenience). */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Create an onProgress callback that sends MCP progress notifications.
 * Returns undefined if no progressToken is available (client doesn't support it).
 * Includes a user-facing hint about Esc on the first notification.
 */
export function createProgressNotifier(
  extra: ToolExtra | undefined,
): ((progress: IndexProgress) => void) | undefined {
  if (!extra?._meta?.progressToken) return undefined;

  const token = extra._meta.progressToken;
  let firstSent = false;

  return (p: IndexProgress) => {
    const hint = !firstSent
      ? ' — Press Esc to stop waiting (indexation continues in background). Use mode="text" for immediate results.'
      : '';
    firstSent = true;

    extra.sendNotification({
      method: 'notifications/progress' as const,
      params: {
        progressToken: token,
        progress: p.current,
        total: p.total,
        message: `${p.phase}: ${p.current}/${p.total}${p.detail ? ` (${p.detail})` : ''}${hint}`,
      },
    }).catch(() => {});  // Fire-and-forget, don't block indexing
  };
}

/**
 * Create an embedding provider based on config.
 */
export function createEmbeddingProvider(config: SouvenirConfig): EmbeddingProvider {
  switch (config.embeddingProvider) {
    case 'ollama':
      return new OllamaEmbeddingProvider(config.ollamaUrl, config.ollamaModel);

    case 'openai':
      if (!config.openaiApiKey) {
        throw new Error(
          'OpenAI provider requires SOUVENIR_OPENAI_API_KEY environment variable. ' +
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
export function getOrCreateProvider(config: SouvenirConfig): EmbeddingProvider {
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

/**
 * Dispose the singleton provider and release resources.
 * Called during graceful shutdown.
 */
export async function disposeSingletonProvider(): Promise<void> {
  if (_singletonProvider) {
    await _singletonProvider.dispose();
    _singletonProvider = null;
    _singletonProviderType = null;
  }
}
