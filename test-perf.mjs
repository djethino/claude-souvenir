/**
 * Benchmark EmbeddingGemma-300M inference performance.
 * Measures: model loading, tokenization, inference per batch.
 */
import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import { join } from 'path';
import { homedir } from 'os';
import { cpus } from 'os';

const MODEL_NAME = 'onnx-community/embeddinggemma-300m-ONNX';
const DOCUMENT_PREFIX = 'title: none | text: ';

env.cacheDir = join(homedir(), '.claude', 'recall', 'models');

console.log(`CPU: ${cpus()[0]?.model} (${cpus().length} logical cores)`);
console.log(`Model cache: ${env.cacheDir}`);
console.log('');

// --- 1. Model loading ---
console.log('=== Loading model (q4, graphOptimizationLevel: all) ===');
let t0 = performance.now();

const [tokenizer, model] = await Promise.all([
  AutoTokenizer.from_pretrained(MODEL_NAME),
  AutoModel.from_pretrained(MODEL_NAME, {
    dtype: 'q4',
    session_options: { graphOptimizationLevel: 'all' },
  }),
]);

let t1 = performance.now();
console.log(`Model loaded in ${((t1 - t0) / 1000).toFixed(2)}s`);
console.log('');

// --- 2. Sample texts ---
const sampleTexts = [
  'How to configure authentication in Express.js with JWT tokens',
  'The quick brown fox jumps over the lazy dog near the river bank',
  'React useEffect cleanup function best practices and common pitfalls',
  'Understanding database indexing strategies for PostgreSQL performance',
  'Machine learning model deployment using Docker containers and Kubernetes',
  'CSS Grid layout tutorial with responsive design patterns',
  'Python asyncio event loop and coroutine programming patterns',
  'TypeScript generics and conditional types advanced usage guide',
];

// --- 3. Single inference warmup ---
console.log('=== Warmup (1 text) ===');
t0 = performance.now();
const warmupInputs = await tokenizer([DOCUMENT_PREFIX + sampleTexts[0]], { padding: true, truncation: true });
t1 = performance.now();
console.log(`  Tokenize 1 text: ${(t1 - t0).toFixed(1)}ms`);

t0 = performance.now();
const warmupOut = await model(warmupInputs);
t1 = performance.now();
console.log(`  Inference 1 text: ${(t1 - t0).toFixed(1)}ms`);
console.log(`  Output dims: ${warmupOut.sentence_embedding.dims}`);
console.log('');

// --- 4. Batch inference ---
for (const batchSize of [1, 4, 8]) {
  const batch = sampleTexts.slice(0, batchSize);
  const prefixed = batch.map(t => DOCUMENT_PREFIX + t);

  console.log(`=== Batch size ${batchSize} ===`);

  // Tokenize
  t0 = performance.now();
  const inputs = await tokenizer(prefixed, { padding: true, truncation: true });
  t1 = performance.now();
  const tokenizeMs = t1 - t0;

  // Inference
  t0 = performance.now();
  const output = await model(inputs);
  t1 = performance.now();
  const inferMs = t1 - t0;

  console.log(`  Tokenize: ${tokenizeMs.toFixed(1)}ms`);
  console.log(`  Inference: ${inferMs.toFixed(1)}ms (${(inferMs / batchSize).toFixed(1)}ms/text)`);
  console.log(`  Total: ${(tokenizeMs + inferMs).toFixed(1)}ms`);
  console.log('');
}

// --- 5. Simulate 100 chunks at batch_size=8 ---
console.log('=== Simulating 100 chunks (batch_size=8) ===');
const chunks100 = Array.from({ length: 100 }, (_, i) => sampleTexts[i % sampleTexts.length]);
t0 = performance.now();
for (let i = 0; i < chunks100.length; i += 8) {
  const batch = chunks100.slice(i, i + 8);
  const prefixed = batch.map(t => DOCUMENT_PREFIX + t);
  const inputs = await tokenizer(prefixed, { padding: true, truncation: true });
  await model(inputs);
}
t1 = performance.now();
const total100 = t1 - t0;
console.log(`  100 chunks in ${(total100 / 1000).toFixed(2)}s (${(total100 / 100).toFixed(1)}ms/chunk)`);
console.log(`  Estimated for 9000 chunks: ${((total100 / 100 * 9000) / 1000 / 60).toFixed(1)} minutes`);
