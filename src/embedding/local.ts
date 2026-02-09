import { join } from 'path';
import { homedir } from 'os';
import type { EmbeddingProvider } from './provider.js';
import { logger } from '../utils/logger.js';

const MODEL_NAME = 'onnx-community/embeddinggemma-300m-ONNX';
const DIMENSIONS = 768;

const BATCH_SIZE_GPU = 32;
const BATCH_SIZE_CPU = 8;

/** Prefixes required by EmbeddingGemma for asymmetric search */
const DOCUMENT_PREFIX = 'title: none | text: ';
const QUERY_PREFIX = 'task: search result | query: ';

/** Default model cache: ~/.claude/recall/models (outside plugin cache to avoid EPERM) */
const DEFAULT_MODEL_CACHE = join(homedir(), '.claude', 'recall', 'models');

/**
 * Detect the best available device for ONNX inference.
 * Priority: env override > GPU (dml on Windows, cuda on Linux x64) > cpu.
 */
function detectDevice(): string {
  const envDevice = process.env.RECALL_DEVICE;
  if (envDevice) return envDevice;

  switch (process.platform) {
    case 'win32':
      return 'dml';
    case 'linux':
      return process.arch === 'x64' ? 'cuda' : 'cpu';
    default:
      return 'cpu';
  }
}

/**
 * Local embedding provider using EmbeddingGemma-300M via HuggingFace Transformers.js.
 * Google Gemma 3 derived, 100+ languages, 768 dimensions.
 * Uses q4 quantization for optimal speed/quality trade-off.
 * Auto-detects GPU (DirectML on Windows, CUDA on Linux) with CPU fallback.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = `local (${MODEL_NAME})`;
  readonly dimensions = DIMENSIONS;

  private model: any = null;
  private tokenizer: any = null;
  private ready = false;
  private batchSize = BATCH_SIZE_CPU;

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    if (this.ready) return;

    const requestedDevice = detectDevice();
    logger.info(`Loading local embedding model: ${MODEL_NAME} (q4, device: ${requestedDevice})...`);

    try {
      const { AutoModel, AutoTokenizer, env } = await import('@huggingface/transformers');

      // Set cache dir outside plugin cache to avoid permission issues
      env.cacheDir = process.env.RECALL_MODEL_CACHE || DEFAULT_MODEL_CACHE;

      // Try GPU first, fall back to CPU if unavailable
      let device = requestedDevice;
      let model: any;

      try {
        model = await AutoModel.from_pretrained(MODEL_NAME, {
          dtype: 'q4' as any,
          device: device as any,
          session_options: { graphOptimizationLevel: 'all' },
        });
      } catch (gpuErr) {
        if (device !== 'cpu') {
          const gpuMsg = gpuErr instanceof Error ? gpuErr.message : String(gpuErr);
          logger.warn(`GPU device "${device}" failed, falling back to CPU: ${gpuMsg}`);
          device = 'cpu';
          model = await AutoModel.from_pretrained(MODEL_NAME, {
            dtype: 'q4' as any,
            session_options: { graphOptimizationLevel: 'all' },
          });
        } else {
          throw gpuErr;
        }
      }

      this.model = model;
      this.tokenizer = await AutoTokenizer.from_pretrained(MODEL_NAME);
      this.batchSize = device === 'cpu' ? BATCH_SIZE_CPU : BATCH_SIZE_GPU;
      this.ready = true;

      logger.info(`Local embedding model loaded (device: ${device}, batch: ${this.batchSize})`);
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

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
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
