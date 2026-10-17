import type { EmbeddingSettings } from '../config.js';
import { BaseEmbeddingProvider } from './provider.js';
import { logger } from '../utils/logger.js';

const MAX_BATCH_SIZE = 64;
const REQUEST_TIMEOUT_MS = 120_000; // 2 min (covers auto-pull)

/**
 * Ollama-based embedding provider.
 * Connects to a running Ollama server via HTTP API.
 * Model is loaded once by Ollama and shared across all consumers
 * (MCP server, hooks, multiple Claude instances).
 *
 * Auto-pulls the model on first use if not already present.
 */
export class OllamaEmbeddingProvider extends BaseEmbeddingProvider {
  constructor(settings: EmbeddingSettings) {
    super(settings, MAX_BATCH_SIZE);
  }

  protected async prepare(): Promise<void> {
    logger.info(`Connecting to Ollama at ${this.settings.url}...`);

    const models = await this.listModels();
    if (models === null) {
      throw new Error(
        `Ollama is not running at ${this.settings.url}. ` +
        'Start it with "ollama serve" or install from https://ollama.com',
      );
    }

    // Ollama model names may include the :latest tag
    const { model } = this.settings;
    if (!models.some((m) => m === model || m === `${model}:latest`)) {
      logger.info(`Model "${model}" not found. Pulling...`);
      await this.pullModel();
      logger.info(`Model "${model}" pulled successfully.`);
    }
  }

  /** Installed model names, or null when the server does not answer. */
  private async listModels(): Promise<string[] | null> {
    try {
      const response = await fetch(`${this.settings.url}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return null;
    }
  }

  private async pullModel(): Promise<void> {
    const { model } = this.settings;
    try {
      const response = await fetch(`${this.settings.url}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: false }),
        signal: AbortSignal.timeout(600_000), // 10 min for pull
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Pull failed (${response.status}): ${errText}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Pull failed')) throw err;
      throw new Error(
        `Failed to pull model "${model}" from Ollama. ` +
        `Ensure Ollama is running and try manually: ollama pull ${model}\n` +
        `Error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  protected async request(texts: string[], retries = 3): Promise<number[][]> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(`${this.settings.url}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.settings.model,
            input: texts,
            ...(this.settings.dimensions !== undefined && { dimensions: this.settings.dimensions }),
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          const errText = await response.text();

          // If model not found, try pulling it once
          if (response.status === 404 && attempt === 0) {
            logger.warn(`Model "${this.settings.model}" not loaded. Attempting pull...`);
            await this.pullModel();
            continue;
          }

          throw new Error(`Ollama embed API error (${response.status}): ${errText}`);
        }

        const data = (await response.json()) as { embeddings: number[][] };

        if (!data.embeddings || data.embeddings.length !== texts.length) {
          throw new Error(
            `Unexpected Ollama response: expected ${texts.length} embeddings, ` +
            `got ${data.embeddings?.length ?? 0}`,
          );
        }

        return data.embeddings;
      } catch (err) {
        if (attempt === retries - 1) throw err;

        const isRetryable =
          err instanceof Error &&
          (err.message.includes('ECONNREFUSED') ||
            err.message.includes('ECONNRESET') ||
            err.message.includes('timeout'));

        if (!isRetryable) throw err;

        const delay = Math.pow(2, attempt) * 1_000;
        logger.warn(`Ollama request failed, retrying in ${delay}ms:`, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new Error('All retries exhausted');
  }
}
