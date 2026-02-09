/**
 * Benchmark the full rebuild pipeline outside MCP.
 * Reproduces exactly what recall_index rebuild does, with timing per phase.
 */

// We import from the built JS files directly
import { LocalEmbeddingProvider } from './build/embedding/local.js';
import { listProjectDirs, listTranscriptFiles, loadSessionIndex } from './build/transcript/discovery.js';
import { chunkTranscript } from './build/embedding/chunker.js';
import { getDb, insertChunks, clearAll, getStoredProvider, setStoredProvider, setIndexState } from './build/db/store.js';
import { statSync } from 'fs';
import { basename } from 'path';

const EMBED_BATCH_SIZE = 32;

async function main() {
  console.log('=== Full Rebuild Benchmark (outside MCP) ===\n');

  // Phase 1: Init provider
  let t0 = performance.now();
  const provider = new LocalEmbeddingProvider();
  await provider.initialize();
  let t1 = performance.now();
  console.log(`[1] Model loaded: ${((t1 - t0) / 1000).toFixed(2)}s\n`);

  // Phase 2: Init DB
  t0 = performance.now();
  getDb(provider.dimensions);
  t1 = performance.now();
  console.log(`[2] DB initialized: ${(t1 - t0).toFixed(1)}ms\n`);

  // Phase 3: List projects and files
  t0 = performance.now();
  const projectDirs = listProjectDirs();
  let allFiles = [];
  for (const dir of projectDirs) {
    const files = listTranscriptFiles(dir, { includeSubagents: true });
    allFiles.push(...files.map(f => ({ filePath: f, projectDir: dir })));
  }
  t1 = performance.now();
  console.log(`[3] Discovery: ${projectDirs.length} projects, ${allFiles.length} files (${(t1 - t0).toFixed(1)}ms)\n`);

  // Phase 4: Clear for rebuild
  t0 = performance.now();
  clearAll();
  setStoredProvider(provider.name, provider.dimensions);
  t1 = performance.now();
  console.log(`[4] DB cleared: ${(t1 - t0).toFixed(1)}ms\n`);

  // Phase 5: Chunk all files
  console.log('[5] Chunking all files...');
  t0 = performance.now();
  let totalChunks = 0;
  const fileChunks = [];
  for (const { filePath, projectDir } of allFiles) {
    const sessionId = basename(filePath, '.jsonl');
    const { chunks, lastLine } = await chunkTranscript(filePath, sessionId, projectDir, { fromLine: 1 });
    fileChunks.push({ filePath, chunks, lastLine });
    totalChunks += chunks.length;
  }
  t1 = performance.now();
  console.log(`   ${totalChunks} chunks from ${allFiles.length} files in ${((t1 - t0) / 1000).toFixed(2)}s\n`);

  // Phase 6: Embed + insert
  console.log('[6] Embedding + inserting...');
  t0 = performance.now();
  let totalEmbedded = 0;
  let batchCount = 0;
  let embedTimeMs = 0;
  let insertTimeMs = 0;

  for (const { filePath, chunks, lastLine } of fileChunks) {
    if (chunks.length === 0) continue;

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map(c => c.embed_text);

      const te0 = performance.now();
      const embeddings = await provider.embed(texts);
      const te1 = performance.now();
      embedTimeMs += te1 - te0;

      const ti0 = performance.now();
      const inserted = insertChunks(batch, embeddings);
      const ti1 = performance.now();
      insertTimeMs += ti1 - ti0;

      totalEmbedded += inserted;
      batchCount++;

      if (batchCount % 10 === 0) {
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        console.log(`   Batch ${batchCount}: ${totalEmbedded}/${totalChunks} embedded (${elapsed}s elapsed)`);
      }
    }

    const stat = statSync(filePath);
    setIndexState(filePath, stat.size, lastLine);
  }
  t1 = performance.now();
  const totalSec = (t1 - t0) / 1000;

  console.log(`\n=== RESULTS ===`);
  console.log(`Total chunks: ${totalChunks}`);
  console.log(`Total embedded: ${totalEmbedded}`);
  console.log(`Batches: ${batchCount}`);
  console.log(`Embed time: ${(embedTimeMs / 1000).toFixed(2)}s (${(embedTimeMs / totalEmbedded).toFixed(1)}ms/chunk)`);
  console.log(`Insert time: ${(insertTimeMs / 1000).toFixed(2)}s (${(insertTimeMs / totalEmbedded).toFixed(1)}ms/chunk)`);
  console.log(`Total phase 6: ${totalSec.toFixed(2)}s`);
  console.log(`Overall: ${(embedTimeMs / 1000 + insertTimeMs / 1000).toFixed(2)}s pure work, ${totalSec.toFixed(2)}s wall time`);

  await provider.dispose();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
