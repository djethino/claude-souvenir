import type { EmbeddingSettings } from '../config.js';
import type { EmbeddingProviderType } from '../options.js';
import { findModelPrompts } from './models.js';
import { logger } from '../utils/logger.js';

/**
 * What makes vectors comparable: an index built with one identity can only be searched with
 * the same one. The server URL and API key are not part of it (same model = same vectors).
 */
export interface EmbeddingIdentity {
  provider: EmbeddingProviderType;
  model: string;
  dimensions: number;
  documentPrefix: string;
  queryPrefix: string;
}

export function sameIdentity(a: EmbeddingIdentity, b: EmbeddingIdentity): boolean {
  return a.provider === b.provider
    && a.model === b.model
    && a.dimensions === b.dimensions
    && a.documentPrefix === b.documentPrefix
    && a.queryPrefix === b.queryPrefix;
}

export function describeIdentity(identity: EmbeddingIdentity): string {
  return `${identity.provider} (${identity.model}, ${identity.dimensions} dimensions)`;
}

/**
 * Abstract embedding provider interface.
 */
export interface EmbeddingProvider {
  /** Human-readable name, e.g. "ollama (embeddinggemma)" */
  readonly name: string;
  readonly settings: EmbeddingSettings;
  /** Identity of the vectors produced; only available once initialized */
  readonly identity: EmbeddingIdentity;
  /** Connect, make sure the model is usable and detect its vector size */
  initialize(): Promise<void>;
  /** Check if provider is ready to generate embeddings */
  isReady(): boolean;
  /** Generate embeddings for documents (batched, document prefix applied) */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Generate the embedding of a search query (query prefix applied) */
  embedQuery(text: string): Promise<Float32Array>;
  /** Clean up resources */
  dispose(): Promise<void>;
}

/**
 * Shared behaviour: model prompts, vector size detection, batching.
 * Subclasses only talk to their server.
 */
export abstract class BaseEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  private ready = false;
  private _identity: EmbeddingIdentity | null = null;
  private readonly documentPrefix: string;
  private readonly queryPrefix: string;

  protected constructor(readonly settings: EmbeddingSettings, private readonly maxBatchSize: number) {
    this.name = `${settings.provider} (${settings.model})`;
    const prompts = findModelPrompts(settings.model);
    if (!prompts) {
      logger.warn(`No known input prefixes for model "${settings.model}": texts are embedded as is`);
    }
    this.documentPrefix = prompts?.documentPrefix ?? '';
    this.queryPrefix = prompts?.queryPrefix ?? '';
  }

  /** Check that the server is reachable and the model available (pull it if supported). */
  protected abstract prepare(): Promise<void>;

  /** Embed already-prefixed texts; the result has one vector per text, in order. */
  protected abstract request(texts: string[]): Promise<number[][]>;

  get identity(): EmbeddingIdentity {
    if (!this._identity) {
      throw new Error(`Embedding provider ${this.name} is not initialized`);
    }
    return this._identity;
  }

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    if (this.ready) return;
    await this.prepare();

    // The vector size is the model's own (or the requested one): measure it instead of assuming it
    const [probe] = await this.request([this.queryPrefix + 'dimension probe']);
    if (this.settings.dimensions !== undefined && probe.length !== this.settings.dimensions) {
      throw new Error(
        `${this.name} returned ${probe.length}-dimension vectors although embedding_dimensions is ` +
        `${this.settings.dimensions}: this model or server does not support shortened vectors. ` +
        'Clear the embedding_dimensions option to use the native size.',
      );
    }
    this._identity = {
      provider: this.settings.provider,
      model: this.settings.model,
      dimensions: probe.length,
      documentPrefix: this.documentPrefix,
      queryPrefix: this.queryPrefix,
    };
    this.ready = true;
    logger.info(`Embedding provider ready: ${describeIdentity(this._identity)}`);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.ready) await this.initialize();
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize).map((t) => this.documentPrefix + t);
      results.push(...(await this.request(batch)).map((v) => new Float32Array(v)));
    }
    return results;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    if (!this.ready) await this.initialize();
    const [vector] = await this.request([this.queryPrefix + text]);
    return new Float32Array(vector);
  }

  async dispose(): Promise<void> {
    this.ready = false;
  }
}
