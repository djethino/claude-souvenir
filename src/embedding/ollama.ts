import type { EmbeddingProvider } from './provider.js';
import { logger } from '../utils/logger.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'embeddinggemma';
const DIMENSIONS = 768;
const MAX_BATCH_SIZE = 64;
const REQUEST_TIMEOUT_MS = 120_000; // 2 min (covers auto-pull)

/** Prefixes required by EmbeddingGemma for asymmetric search */
const DOCUMENT_PREFIX = 'title: none | text: ';
const QUERY_PREFIX = 'task: search result | query: ';

/**
 * Ollama-based embedding provider.
 * Connects to a running Ollama server via HTTP API.
 * Model is loaded once by Ollama and shared across all consumers
 * (MCP server, hooks, multiple Claude instances).
 *
 * Auto-pulls the model on first use if not already present.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions = DIMENSIONS;

  private baseUrl: string;
  private model: string;
  private ready = false;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = model || DEFAULT_MODEL;
    this.name = `ollama (${this.model})`;
  }

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    if (this.ready) return;

    logger.info(`Connecting to Ollama at ${this.baseUrl}...`);

    // 1. Check if Ollama is running
    const isRunning = await this.checkOllamaRunning();
    if (!isRunning) {
      throw new Error(
        `Ollama is not running at ${this.baseUrl}. ` +
        'Start it with "ollama serve" or install from https://ollama.com',
      );
    }

    // 2. Check if model is available, auto-pull if not
    const hasModel = await this.checkModelAvailable();
    if (!hasModel) {
      logger.info(`Model "${this.model}" not found. Pulling...`);
      await this.pullModel();
      logger.info(`Model "${this.model}" pulled successfully.`);
    }

    this.ready = true;
    logger.info(`Ollama embedding provider ready (model: ${this.model}, ${DIMENSIONS}d)`);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.ready) await this.initialize();

    const allResults: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      const prefixed = batch.map((t) => DOCUMENT_PREFIX + t);

      const embeddings = await this.callEmbed(prefixed);
      allResults.push(...embeddings);
    }

    return allResults;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    if (!this.ready) await this.initialize();

    const prefixed = QUERY_PREFIX + text;
    const [result] = await this.callEmbed([prefixed]);
    return result;
  }

  async dispose(): Promise<void> {
    this.ready = false;
    // Nothing to clean up — Ollama manages the model lifecycle
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async checkOllamaRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async checkModelAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return false;

      const data = (await response.json()) as {
        models?: Array<{ name: string }>;
      };

      if (!data.models) return false;

      // Ollama model names may include :latest tag
      return data.models.some(
        (m) => m.name === this.model || m.name === `${this.model}:latest`,
      );
    } catch {
      return false;
    }
  }

  private async pullModel(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.model, stream: false }),
        signal: AbortSignal.timeout(600_000), // 10 min for pull
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Pull failed (${response.status}): ${errText}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Pull failed')) throw err;
      throw new Error(
        `Failed to pull model "${this.model}" from Ollama. ` +
        `Ensure Ollama is running and try manually: ollama pull ${this.model}\n` +
        `Error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async callEmbed(texts: string[], retries = 3): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            input: texts,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          const errText = await response.text();

          // If model not found, try pulling it once
          if (response.status === 404 && attempt === 0) {
            logger.warn(`Model "${this.model}" not loaded. Attempting pull...`);
            await this.pullModel();
            continue;
          }

          throw new Error(`Ollama embed API error (${response.status}): ${errText}`);
        }

        const data = (await response.json()) as {
          embeddings: number[][];
        };

        if (!data.embeddings || data.embeddings.length !== texts.length) {
          throw new Error(
            `Unexpected Ollama response: expected ${texts.length} embeddings, ` +
            `got ${data.embeddings?.length ?? 0}`,
          );
        }

        return data.embeddings.map((emb) => new Float32Array(emb));
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
