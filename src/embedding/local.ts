import type { EmbeddingProvider } from './provider.js';
import { logger } from '../utils/logger.js';

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const DIMENSIONS = 384;
const BATCH_SIZE = 32;

/**
 * Local embedding provider using HuggingFace Transformers.js.
 * Model is downloaded on first use (~22MB).
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = `local (${MODEL_NAME})`;
  readonly dimensions = DIMENSIONS;

  private pipeline: any = null;
  private ready = false;

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    if (this.ready) return;

    logger.info(`Loading local embedding model: ${MODEL_NAME}...`);

    try {
      // Dynamic import since @huggingface/transformers is optional
      const { pipeline, env } = await import('@huggingface/transformers');

      // Set cache directory if specified
      if (process.env.RECALL_MODEL_CACHE) {
        env.cacheDir = process.env.RECALL_MODEL_CACHE;
      }

      this.pipeline = await pipeline('feature-extraction', MODEL_NAME, {
        dtype: 'q8' as any, // Quantized for faster inference
      });

      this.ready = true;
      logger.info('Local embedding model loaded successfully');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
        throw new Error(
          'Local embedding provider requires @huggingface/transformers. ' +
          'Install it with: npm install @huggingface/transformers\n' +
          'Or switch to OpenAI provider: set RECALL_PROVIDER=openai',
        );
      }
      throw new Error(`Failed to load embedding model: ${msg}`);
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.ready) await this.initialize();

    const results: Float32Array[] = [];

    // Process in batches
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);

      for (const text of batch) {
        const output = await this.pipeline(text, {
          pooling: 'mean',
          normalize: true,
        });
        results.push(new Float32Array(output.data));
      }
    }

    return results;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [result] = await this.embed([text]);
    return result;
  }

  async dispose(): Promise<void> {
    this.pipeline = null;
    this.ready = false;
  }
}
