/**
 * Quick test: EmbeddingGemma on GPU via DirectML (Windows) vs CPU.
 */
import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import { join } from 'path';
import { homedir } from 'os';

const MODEL_NAME = 'onnx-community/embeddinggemma-300m-ONNX';
const DOCUMENT_PREFIX = 'title: none | text: ';
env.cacheDir = join(homedir(), '.claude', 'recall', 'models');

// Generate realistic long chunks (like real transcripts)
const longTexts = Array.from({ length: 32 }, (_, i) =>
  `This is a realistic transcript chunk number ${i} that contains a detailed discussion about implementing authentication systems with JWT tokens in a Node.js Express application. The conversation covers middleware setup, token validation, refresh token rotation, and security best practices including CSRF protection and rate limiting. They also discuss database schema design for user sessions and how to handle token revocation efficiently using Redis as a session store. `.repeat(3)
);

async function benchDevice(device) {
  console.log(`\n=== Testing device: ${device} ===`);

  let t0 = performance.now();
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_NAME);
  const model = await AutoModel.from_pretrained(MODEL_NAME, {
    dtype: 'q4',
    device,
    session_options: { graphOptimizationLevel: 'all' },
  });
  let t1 = performance.now();
  console.log(`Model loaded: ${((t1 - t0) / 1000).toFixed(2)}s`);

  // Warmup
  const warmupInputs = await tokenizer([DOCUMENT_PREFIX + longTexts[0]], { padding: true, truncation: true });
  await model(warmupInputs);
  console.log('Warmup done');

  // Batch of 8 long texts
  for (const batchSize of [8, 32]) {
    const batch = longTexts.slice(0, batchSize).map(t => DOCUMENT_PREFIX + t);
    const inputs = await tokenizer(batch, { padding: true, truncation: true });

    t0 = performance.now();
    await model(inputs);
    t1 = performance.now();
    console.log(`Batch ${batchSize}: ${(t1 - t0).toFixed(1)}ms total, ${((t1 - t0) / batchSize).toFixed(1)}ms/chunk`);
  }

  // Simulate 100 chunks at batch_size=8
  t0 = performance.now();
  for (let i = 0; i < 96; i += 8) {
    const batch = longTexts.slice(0, 8).map(t => DOCUMENT_PREFIX + t);
    const inputs = await tokenizer(batch, { padding: true, truncation: true });
    await model(inputs);
  }
  t1 = performance.now();
  const per96 = t1 - t0;
  console.log(`96 long chunks: ${(per96 / 1000).toFixed(2)}s (${(per96 / 96).toFixed(1)}ms/chunk)`);
  console.log(`Estimated 136K chunks: ${(per96 / 96 * 136443 / 1000 / 60).toFixed(1)} minutes`);

  await model.dispose?.();
}

// Test DML (GPU) first, then CPU for comparison
try {
  await benchDevice('dml');
} catch (err) {
  console.error(`DML failed: ${err.message}`);
}
