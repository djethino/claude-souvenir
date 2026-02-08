/**
 * Abstract embedding provider interface.
 */
export interface EmbeddingProvider {
  /** Human-readable name */
  readonly name: string;
  /** Vector dimensions */
  readonly dimensions: number;
  /** Initialize the provider (download model, validate API key, etc.) */
  initialize(): Promise<void>;
  /** Check if provider is ready to generate embeddings */
  isReady(): boolean;
  /** Generate embeddings for multiple texts (batched) */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Generate embedding for a single query text */
  embedQuery(text: string): Promise<Float32Array>;
  /** Clean up resources */
  dispose(): Promise<void>;
}
