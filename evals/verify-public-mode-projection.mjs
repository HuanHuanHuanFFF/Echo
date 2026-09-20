import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeContext } from './lib/public-runtime.mjs';
import { jsonLines, digest } from './prepare-public-benchmarks.mjs';
import { archiveSources } from './lib/public-provenance.mjs';
const root = path.resolve(process.argv[2] ?? '');
const out = path.resolve(process.argv[3] ?? '');
assert.ok(process.argv[2] && process.argv[3]);
assert.ok(!path.relative(root, out).startsWith('..') && out !== root);
globalThis.fetch = async () => {
  throw new Error('Network forbidden in frozen-vector probe');
};
const target = path.join(out, 'production-probe.json');
const output = await fs.open(target, 'wx');
const ctx = await runtimeContext(root);
const results = [];
try {
  for (const scope of ['langchain', 'godot', 'du']) {
    const dbFile = path.join(root, 'fixed', scope + '.sqlite');
    const before = digest(await fs.readFile(dbFile));
    const db = ctx.openDatabase(dbFile, { readOnly: true });
    try {
      const queries = [];
      for await (const q of jsonLines(
        path.join(
          root,
          'data',
          scope === 'du'
            ? 'du-queries.jsonl'
            : 'freshstack-' + scope + '-queries.jsonl',
        ),
      )) {
        queries.push({
          id: q.query_id ?? q.id,
          text:
            scope === 'du'
              ? q.text.trim()
              : (q.query_title + ' ' + q.query_text).trim(),
        });
      }
      const selected = queries.slice(0, 8);
      const ids = new Set(selected.map((q) => q.id));
      const original = new Map();
      for await (const r of jsonLines(
        path.join(root, 'fixed', scope + '-rrf30.jsonl'),
      ))
        if (ids.has(r.id)) original.set(r.id, r);
      const config = ctx.parseConfig({
        database: dbFile,
        embedding: ctx.plan.config,
        retrieval: { rrf_k: 30 },
      });
      for (const q of selected) {
        for (const mode of ['dense', 'bm25']) {
          const expected = original
            .get(q.id)
            .rankings.filter((r) => r[mode + '_rank'] !== null)
            .sort((a, b) => a[mode + '_rank'] - b[mode + '_rank'])
            .map((r) => r.id);
          const actual = await ctx.retrieveQuery(
            db,
            config,
            q.id,
            q.text,
            {},
            { ...config.retrieval, mode },
            mode === 'dense' ? ctx.provider : null,
          );
          assert.ok(['ok', 'empty'].includes(actual.status));
          assert.deepEqual(
            actual.candidates.map((c) => c.evidence.chunk_id),
            expected,
          );
          results.push({
            scope,
            id: q.id,
            mode,
            candidates: expected.length,
            ordered_ids_sha256: digest(JSON.stringify(expected)),
            equal: true,
          });
        }
      }
    } finally {
      db.close();
    }
    assert.equal(digest(await fs.readFile(dbFile)), before);
    console.log(
      JSON.stringify({
        scope,
        probes: 16,
        all_equal: true,
        index_unchanged: true,
      }),
    );
  }
  const sources = await archiveSources(
    root,
    'public-single-lane-production-probe',
    ['evals/verify-public-mode-projection.mjs', 'evals/lib/public-runtime.mjs'],
  );
  await output.write(
    JSON.stringify(
      {
        network_forbidden: true,
        real_cached_vectors: true,
        compared: results.length,
        all_equal: true,
        rows: results,
        sources,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await output.close();
  ctx.cache.close();
}
