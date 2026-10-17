/**
 * Input prefixes that embedding models expect for asymmetric retrieval (documents vs queries).
 *
 * Neither Ollama nor OpenAI-compatible servers add them: they must be part of the text. Using the
 * wrong prefix (or none on a model trained with them) silently degrades search quality.
 * Sources: the model cards on Hugging Face (checked 2026-10-17).
 */

export interface ModelPrompts {
  /** Matched against the normalized model name (see normalizeModelName) */
  match: string;
  documentPrefix: string;
  queryPrefix: string;
}

const REPRESENT_QUERY = 'Represent this sentence for searching relevant passages: ';
const RETRIEVAL_TASK = 'Given a web search query, retrieve relevant passages that answer the query';

/** Most specific names first: the first entry contained in the model name wins. */
const KNOWN_MODELS: readonly ModelPrompts[] = [
  // google/embeddinggemma-2 and google/embeddinggemma-300m
  { match: 'embeddinggemma', documentPrefix: 'title: none | text: ', queryPrefix: 'task: search result | query: ' },
  // nomic-ai/nomic-embed-text-v1.5 and -v2-moe
  { match: 'nomic-embed-text', documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' },
  // Snowflake/snowflake-arctic-embed-l-v2.0 (Ollama: snowflake-arctic-embed2)
  { match: 'snowflake-arctic-embed2', documentPrefix: '', queryPrefix: 'query: ' },
  { match: 'snowflake-arctic-embed-l-v2', documentPrefix: '', queryPrefix: 'query: ' },
  { match: 'snowflake-arctic-embed-m-v2', documentPrefix: '', queryPrefix: 'query: ' },
  // Snowflake/snowflake-arctic-embed (v1), mixedbread-ai/mxbai-embed-large-v1, BAAI/bge-large-en-v1.5
  { match: 'snowflake-arctic-embed', documentPrefix: '', queryPrefix: REPRESENT_QUERY },
  { match: 'mxbai-embed-large', documentPrefix: '', queryPrefix: REPRESENT_QUERY },
  { match: 'bge-large', documentPrefix: '', queryPrefix: REPRESENT_QUERY },
  // intfloat/multilingual-e5-large-instruct (space after "Query:")
  { match: 'e5-large-instruct', documentPrefix: '', queryPrefix: `Instruct: ${RETRIEVAL_TASK}\nQuery: ` },
  // intfloat/multilingual-e5-* and e5-*-v2
  { match: 'multilingual-e5', documentPrefix: 'passage: ', queryPrefix: 'query: ' },
  { match: 'e5-small', documentPrefix: 'passage: ', queryPrefix: 'query: ' },
  { match: 'e5-base', documentPrefix: 'passage: ', queryPrefix: 'query: ' },
  { match: 'e5-large', documentPrefix: 'passage: ', queryPrefix: 'query: ' },
  // Qwen/Qwen3-Embedding-* (official template: no space after "Query:")
  { match: 'qwen3-embedding', documentPrefix: '', queryPrefix: `Instruct: ${RETRIEVAL_TASK}\nQuery:` },
  // No prefixes
  { match: 'bge-m3', documentPrefix: '', queryPrefix: '' },
  { match: 'all-minilm', documentPrefix: '', queryPrefix: '' },
  { match: 'granite-embedding', documentPrefix: '', queryPrefix: '' },
  { match: 'paraphrase-multilingual', documentPrefix: '', queryPrefix: '' },
  { match: 'text-embedding-3', documentPrefix: '', queryPrefix: '' },
];

/** "hf.co/Org/Model-GGUF:Q8_0" -> "model-gguf"; "nomic-embed-text:latest" -> "nomic-embed-text". */
export function normalizeModelName(model: string): string {
  const withoutTag = model.trim().toLowerCase().replace(/:[^/]*$/, '');
  return withoutTag.slice(withoutTag.lastIndexOf('/') + 1);
}

/** Prompts for a model, or null when the model is unknown (texts are then embedded as is). */
export function findModelPrompts(model: string): ModelPrompts | null {
  const name = normalizeModelName(model);
  return KNOWN_MODELS.find((m) => name.includes(m.match)) ?? null;
}
