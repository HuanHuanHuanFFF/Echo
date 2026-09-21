import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { runtimeContext } from './lib/public-runtime.mjs';
const { root, scope } = workerData;
const ctx = await runtimeContext(root),
  dbFile = path.join(root, 'fixed', scope + '.sqlite');
const config = ctx.parseConfig({
  database: dbFile,
  embedding: ctx.plan.config,
  retrieval: { rrf_k: 30 },
});
const db = ctx.openDatabase(dbFile, { readOnly: true });
assert.equal(
  db.prepare('SELECT count(*) n FROM chunks').get().n,
  db.prepare('SELECT count(*) n FROM embeddings').get().n,
);
parentPort.on('message', async ({ job, q, k }) => {
  try {
    const start = performance.now();
    const result = await ctx.retrieveQuery(
      db,
      config,
      q.id,
      q.text,
      {},
      { ...config.retrieval, rrf_k: k },
      ctx.provider,
    );
    assert.ok(
      ['ok', 'empty'].includes(result.status),
      'Retrieval failure ' + result.status,
    );
    const rankings = result.candidates.map((c, i) => ({
      id: c.evidence.chunk_id,
      rank: i + 1,
      rank_score: result.candidates.length - i,
      rrf_score: c.score,
      bm25_rank: c.bm25_rank ?? null,
      dense_rank: c.dense_rank ?? null,
      similarity: c.similarity ?? null,
    }));
    parentPort.postMessage({
      job,
      row: {
        id: q.id,
        query_chars: q.text.length,
        rrf_k: k,
        candidates: result.counts,
        rankings,
        offline_ms: performance.now() - start,
      },
    });
  } catch (error) {
    parentPort.postMessage({ job, error: String(error.stack) });
  }
});
parentPort.postMessage({ ready: true });
