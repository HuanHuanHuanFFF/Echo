import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPool } from './lib/public-eval-pool.mjs';
import { archiveSources } from './lib/public-provenance.mjs';
import { runtimeContext } from './lib/public-runtime.mjs';
import { jsonLines, digest } from './prepare-public-benchmarks.mjs';
const root = path.resolve(process.argv[2] ?? ''),
  scope = process.argv[3],
  mode = process.argv[4],
  workers = Number(process.argv[5] ?? 4);
assert.ok(
  process.argv[2] &&
    ['langchain', 'godot', 'du'].includes(scope) &&
    ['run', 'probe'].includes(mode),
);
assert.ok(Number.isInteger(workers) && workers >= 1 && workers <= 4);
const ctx = await runtimeContext(root),
  dir = path.join(root, 'fixed'),
  dbFile = path.join(dir, scope + '.sqlite');
try {
  const queryFile = path.join(
    root,
    'data',
    scope === 'du'
      ? 'du-queries.jsonl'
      : 'freshstack-' + scope + '-queries.jsonl',
  );
  const queries = [];
  for await (const q of jsonLines(queryFile))
    queries.push({
      id: q.query_id ?? q.id,
      text:
        scope === 'du'
          ? q.text.trim()
          : (q.query_title + ' ' + q.query_text).trim(),
    });
  assert.equal(queries.length, { langchain: 203, godot: 99, du: 2000 }[scope]);
  assert.equal(new Set(queries.map((q) => q.id)).size, queries.length);
  const selected = mode === 'probe' ? queries.slice(0, 8) : queries;
  const outputs = {};
  const before = digest(await fs.readFile(dbFile));
  let results;
  try {
    if (mode === 'run') {
      for (const k of [30, 10])
        outputs[k] = await fs.open(
          path.join(dir, scope + '-rrf' + k + '.jsonl'),
          'wx',
        );
    }
    const jobs = selected.flatMap((q) => [30, 10].map((k) => ({ q, k })));
    results = await runPool(
      new URL('./public-fixed-worker.mjs', import.meta.url),
      { root, scope },
      jobs,
      workers,
      (n, total) => {
        if (n % 100 === 0 || n === total)
          console.log(
            JSON.stringify({ scope, mode, workers, completed: n, total }),
          );
      },
    );
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].id, jobs[i].q.id);
      assert.equal(results[i].rrf_k, jobs[i].k);
    }
    if (mode === 'run')
      for (const row of results)
        await outputs[row.rrf_k].write(JSON.stringify(row) + '\n');
  } finally {
    await Promise.all(Object.values(outputs).map((file) => file.close()));
  }
  assert.equal(
    digest(await fs.readFile(dbFile)),
    before,
    'Parallel queries changed index',
  );
  const archived = await archiveSources(
    root,
    mode + '-parallel-' + scope,
    [
      './run-public-fixed-parallel.mjs',
      './public-fixed-worker.mjs',
      './lib/public-eval-pool.mjs',
      './lib/public-runtime.mjs',
      './lib/public-provenance.mjs',
    ].map((p) => fileURLToPath(new URL(p, import.meta.url))),
  );
  const config = ctx.parseConfig({
    database: dbFile,
    embedding: ctx.plan.config,
    retrieval: { rrf_k: 30 },
  });
  if (mode === 'probe') {
    const referenceBytes = await fs.readFile(
      path.join(dir, scope + '-run-receipt.json'),
    );
    const referenceReceipt = JSON.parse(referenceBytes.toString('utf8'));
    assert.equal(referenceReceipt.scope, scope);
    assert.equal(referenceReceipt.queries, queries.length);
    assert.equal(referenceReceipt.index_sha256, before);
    assert.equal(
      referenceReceipt.query_sha256,
      digest(await fs.readFile(queryFile)),
    );
    assert.deepEqual(referenceReceipt.conditions, [30, 10]);
    assert.deepEqual(referenceReceipt.config, config);
    const referenceHashes = {};
    for (const k of [30, 10])
      referenceHashes[k] = digest(
        await fs.readFile(path.join(dir, scope + '-rrf' + k + '.jsonl')),
      );
    const reference = new Map();
    for (const k of [30, 10])
      for await (const r of jsonLines(
        path.join(dir, scope + '-rrf' + k + '.jsonl'),
      ))
        reference.set(k + ':' + r.id, r);
    for (const actual of results) {
      const expected = reference.get(actual.rrf_k + ':' + actual.id);
      assert.ok(expected);
      const { offline_ms: _a, ...a } = actual,
        { offline_ms: _e, ...e } = expected;
      assert.deepEqual(a, e);
    }
    const receipt = {
      scope,
      workers,
      compared: results.length,
      reference_receipt_sha256: digest(referenceBytes),
      reference_run_sha256: referenceHashes,
      equal_all_fields_except_timing: true,
      index_sha256: before,
      archived_sources: archived,
    };
    await fs.writeFile(
      path.join(root, 'analysis', scope + '-parallel-conformance.json'),
      JSON.stringify(receipt, null, 2) + '\n',
    );
    console.log(JSON.stringify(receipt));
  } else {
    await fs.writeFile(
      path.join(dir, scope + '-run-receipt.json'),
      JSON.stringify(
        {
          scope,
          queries: queries.length,
          conditions: [30, 10],
          config,
          index_sha256: before,
          query_sha256: digest(await fs.readFile(queryFile)),
          archived_sources: archived,
          unchanged_index: true,
          execution: {
            workers,
            mode: 'readonly independent production retrieveQuery calls; no lane reuse',
            latency:
              'Concurrent offline timing includes contention; not standalone latency',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }
} finally {
  ctx.cache.close();
}
