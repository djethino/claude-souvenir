import type { EmbeddingSettings } from '../config.js';
import { BaseEmbeddingProvider } from './provider.js';
import { logger } from '../utils/logger.js';

const MAX_BATCH_SIZE = 100;

/**
 * OpenAI-compatible embedding provider: POST <url>/embeddings.
 * Works with OpenAI and any server exposing the same API (LM Studio, vLLM, llama.cpp server,
 * Ollama's /v1...). The API key is optional: local servers usually need none.
 */
export class OpenAIEmbeddingProvider extends BaseEmbeddingProvider {
  constructor(settings: EmbeddingSettings) {
    super(settings, MAX_BATCH_SIZE);
  }

  protected async prepare(): Promise<void> {
    // The dimension probe in initialize() is the real check: it exercises URL, key and model
    logger.info(`Using OpenAI-compatible embeddings at ${this.settings.url} (model ${this.settings.model})`);
  }

  protected async request(texts: string[], retries = 3): Promise<number[][]> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(`${this.settings.url}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.settings.apiKey && { Authorization: `Bearer ${this.settings.apiKey}` }),
          },
          body: JSON.stringify({
            model: this.settings.model,
            input: texts,
            ...(this.settings.dimensions !== undefined && { dimensions: this.settings.dimensions }),
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          if (response.status === 429 && attempt < retries - 1) {
            // Rate limited - exponential backoff
            const delay = Math.pow(2, attempt) * 1000;
            logger.warn(`Rate limited, retrying in ${delay}ms...`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          const hint = response.status === 401 || response.status === 403
            ? ' Check the embedding_api_key option.'
            : '';
          throw new Error(`Embedding API error at ${this.settings.url} (${response.status}): ${error}${hint}`);
        }

        const data = await response.json() as {
          data: Array<{ embedding: number[]; index: number }>;
        };
        if (!Array.isArray(data.data) || data.data.length !== texts.length) {
          throw new Error(
            `Unexpected embedding API response: expected ${texts.length} embeddings, got ${data.data?.length ?? 0}`,
          );
        }

        // Sort by index (the API may reorder)
        return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      } catch (err) {
        if (attempt === retries - 1) throw err;
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn(`API error, retrying in ${delay}ms:`, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new Error('All retries exhausted');
  }
}
