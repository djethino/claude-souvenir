import type { EmbeddingProvider } from './provider.js';
import { logger } from '../utils/logger.js';

const MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 768;
const API_URL = 'https://api.openai.com/v1/embeddings';
const MAX_BATCH_SIZE = 100;

/**
 * OpenAI API embedding provider.
 * Requires RECALL_OPENAI_API_KEY environment variable.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = `openai (${MODEL})`;
  readonly dimensions: number;

  private apiKey: string;
  private ready = false;

  constructor(apiKey: string, dimensions?: number) {
    this.apiKey = apiKey;
    this.dimensions = dimensions || DEFAULT_DIMENSIONS;
  }

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    if (this.ready) return;

    if (!this.apiKey) {
      throw new Error(
        'OpenAI embedding provider requires RECALL_OPENAI_API_KEY environment variable.',
      );
    }

    // Validate API key with a minimal request
    logger.info('Validating OpenAI API key...');
    try {
      await this.callApi(['test']);
      this.ready = true;
      logger.info('OpenAI embedding provider ready');
    } catch (err) {
      throw new Error(`OpenAI API validation failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.ready) await this.initialize();

    const allResults: Float32Array[] = [];

    // Process in batches
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      const embeddings = await this.callApi(batch);
      allResults.push(...embeddings);
    }

    return allResults;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [result] = await this.embed([text]);
    return result;
  }

  async dispose(): Promise<void> {
    this.ready = false;
  }

  private async callApi(texts: string[], retries = 3): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: MODEL,
            input: texts,
            dimensions: this.dimensions,
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
          throw new Error(`OpenAI API error (${response.status}): ${error}`);
        }

        const data = await response.json() as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        // Sort by index and convert to Float32Array
        const sorted = data.data.sort((a, b) => a.index - b.index);
        return sorted.map((d) => new Float32Array(d.embedding));
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
