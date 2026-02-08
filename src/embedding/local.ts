import { join } from 'path';
import { homedir } from 'os';
import type { EmbeddingProvider } from './provider.js';
import { logger } from '../utils/logger.js';

const MODEL_NAME = 'onnx-community/embeddinggemma-300m-ONNX';
const DIMENSIONS = 768;
const BATCH_SIZE = 16; // Smaller batches: larger model uses more memory per inference

/** Prefixes required by EmbeddingGemma for asymmetric search */
const DOCUMENT_PREFIX = 'title: none | text: ';
const QUERY_PREFIX = 'task: search result | query: ';

/** Default model cache: ~/.claude/recall/models (outside plugin cache to avoid EPERM) */
const DEFAULT_MODEL_CACHE = join(homedir(), '.claude', 'recall', 'models');

/**
 * Local embedding provider using EmbeddingGemma-300M via HuggingFace Transformers.js.
 * Google Gemma 3 derived, 100+ languages, 768 dimensions.
 * Model is downloaded on first use (~150-200MB quantized).
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = `local (${MODEL_NAME})`;
  readonly dimensions = DIMENSIONS;

  private model: any = null;
  private tokenizer: any = null;
  private ready = false;

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    if (this.ready) return;

    logger.info(`Loading local embedding model: ${MODEL_NAME} (~200MB on first download)...`);

    try {
      const { AutoModel, AutoTokenizer, env } = await import('@huggingface/transformers');

      // Always set cache dir outside plugin cache to avoid permission issues
      env.cacheDir = process.env.RECALL_MODEL_CACHE || DEFAULT_MODEL_CACHE;
      logger.info(`Model cache dir: ${env.cacheDir}`);

      // Load tokenizer and model in parallel for faster startup
      [this.tokenizer, this.model] = await Promise.all([
        AutoTokenizer.from_pretrained(MODEL_NAME),
        AutoModel.from_pretrained(MODEL_NAME, {
          dtype: 'q8' as any, // EmbeddingGemma does NOT support fp16, use q8 or q4
        }),
      ]);

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
      if (msg.includes('403') || msg.includes('401') || msg.includes('access')) {
        throw new Error(
          `Failed to download model ${MODEL_NAME}. ` +
          'The model may require authentication or license acceptance. ' +
          `Please visit: https://huggingface.co/${MODEL_NAME} to verify access.\n` +
          `Original error: ${msg}`,
        );
      }
      throw new Error(`Failed to load embedding model: ${msg}`);
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.ready) await this.initialize();

    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const prefixed = batch.map((t) => DOCUMENT_PREFIX + t);

      const inputs = await this.tokenizer(prefixed, {
        padding: true,
        truncation: true,
      });

      const { sentence_embedding } = await this.model(inputs);

      // sentence_embedding is a Tensor [batch_size, 768]
      // Copy each vector to its own Float32Array (avoid shared buffer GC issues)
      const data = sentence_embedding.data as Float32Array;
      const dims = sentence_embedding.dims as number[];
      const embDim = dims[1];

      for (let j = 0; j < dims[0]; j++) {
        const start = j * embDim;
        results.push(new Float32Array(data.slice(start, start + embDim)));
      }
    }

    return results;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    if (!this.ready) await this.initialize();

    const prefixed = QUERY_PREFIX + text;

    const inputs = await this.tokenizer([prefixed], {
      padding: true,
      truncation: true,
    });

    const { sentence_embedding } = await this.model(inputs);

    // Single query: copy the data to avoid shared buffer issues
    return new Float32Array(sentence_embedding.data as Float32Array);
  }

  async dispose(): Promise<void> {
    this.model = null;
    this.tokenizer = null;
    this.ready = false;
  }
}
