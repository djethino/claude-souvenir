/**
 * Debug DML: check which ops are offloaded to CPU and measure real perf.
 */
import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import { join } from 'path';
import { homedir } from 'os';

const MODEL_NAME = 'onnx-community/embeddinggemma-300m-ONNX';
const DOCUMENT_PREFIX = 'title: none | text: ';
env.cacheDir = join(homedir(), '.claude', 'recall', 'models');

// Enable verbose ONNX logging to see EP assignments
const ort = await import('onnxruntime-node');
ort.default.env.logLevel = 'verbose';
ort.default.env.logSeverityLevel = 0;

console.log('=== Loading model with DML (verbose) ===');
const t0 = performance.now();
const model = await AutoModel.from_pretrained(MODEL_NAME, {
  dtype: 'q4',
  device: 'dml',
  session_options: { graphOptimizationLevel: 'all' },
});
const t1 = performance.now();
console.log(`\nModel loaded: ${((t1 - t0) / 1000).toFixed(2)}s`);

// Disable verbose after loading
ort.default.env.logLevel = 'warning';

const tokenizer = await AutoTokenizer.from_pretrained(MODEL_NAME);

// Real-world long chunk
const longText = 'This is a realistic transcript chunk that contains a detailed discussion about implementing authentication systems with JWT tokens in a Node.js Express application. The conversation covers middleware setup, token validation, refresh token rotation, and security best practices. '.repeat(5);

console.log(`\nText length: ${longText.length} chars`);

// Warmup
const warmupIn = await tokenizer([DOCUMENT_PREFIX + longText], { padding: true, truncation: true });
await model(warmupIn);

// Single inference timing
const times = [];
for (let i = 0; i < 10; i++) {
  const inputs = await tokenizer([DOCUMENT_PREFIX + longText], { padding: true, truncation: true });
  const s = performance.now();
  await model(inputs);
  const e = performance.now();
  times.push(e - s);
}
console.log(`\nSingle long text (10 runs):`);
console.log(`  Min: ${Math.min(...times).toFixed(1)}ms`);
console.log(`  Avg: ${(times.reduce((a,b)=>a+b) / times.length).toFixed(1)}ms`);
console.log(`  Max: ${Math.max(...times).toFixed(1)}ms`);
