import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { jsonLines } from './prepare-public-benchmarks.mjs';
import { runtimeContext } from './lib/public-runtime.mjs';
import { archiveSources } from './lib/public-provenance.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function parseWeights(input) {
  const weights = input === undefined ? [0, 0.1, 0.25, 0.5] : JSON.parse(input);
  assert.ok(Array.isArray(weights) && weights.length > 0);
  assert.ok(weights.every((w) => Number.isFinite(w) && w >= 0 && w <= 10));
  assert.equal(new Set(weights).size, weights.length);
  return weights;
}
export function sampleIds(ids, scope, count, seed = 20260920) {
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(Number.isInteger(count) && count > 0 && count <= ids.length);
  return ids
    .map((id) => ({ id, key: hash(JSON.stringify([seed, scope, id])) }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id))
    .slice(0, count)
    .map((x) => x.id);
}
export function weightedRanks(row, weight, k = 30) {
  assert.ok(Number.isFinite(weight) && weight >= 0 && weight <= 10);
  assert.ok(Number.isInteger(k) && k > 0);
  assert.equal(
    new Set(row.rankings.map((r) => r.id)).size,
    row.rankings.length,
  );
  for (const lane of ['bm25', 'dense']) {
    const ranks = row.rankings
      .map((r) => r[lane + '_rank'])
      .filter((r) => r !== null);
    assert.ok(ranks.every((r) => Number.isInteger(r) && r > 0));
    assert.equal(ranks.length, row.candidates[lane]);
    assert.deepEqual(
      ranks.sort((a, b) => a - b),
      Array.from({ length: ranks.length }, (_, i) => i + 1),
    );
  }
  return row.rankings
    .map((r) => {
      let score = 0;
      if (r.bm25_rank !== null) score += weight / (k + r.bm25_rank);
      if (r.dense_rank !== null) score += 1 / (k + r.dense_rank);
      return { ...r, rrf_score: score };
    })
    .filter((r) => r.rrf_score > 0)
    .sort((a, b) => b.rrf_score - a.rrf_score || a.id.localeCompare(b.id))
    .map((r, i, all) => ({ ...r, rank: i + 1, rank_score: all.length - i }));
}
async function main() {
  const root = path.resolve(process.argv[2] ?? ''),
    out = path.resolve(process.argv[3] ?? '');
  assert.ok(process.argv[2] && process.argv[3]);
  const rel = path.relative(root, out);
  assert.ok(
    rel &&
      !path.isAbsolute(rel) &&
      rel !== '..' &&
      !rel.startsWith('..' + path.sep),
  );
  const weights = parseWeights(process.argv[4]);
  const previousFile = process.argv[5] ? path.resolve(process.argv[5]) : null;
  if (previousFile) {
    const previousRel = path.relative(root, previousFile);
    assert.ok(
      previousRel &&
        !path.isAbsolute(previousRel) &&
        previousRel !== '..' &&
        !previousRel.startsWith('..' + path.sep),
    );
    assert.equal(path.basename(previousFile), 'freeze.json');
  }
  await fs.mkdir(out);
  globalThis.fetch = async () => {
    throw new Error('Network forbidden');
  };
  const cohorts = {},
    queries = {};
  const bindings = {};
  async function bind(file) {
    const bytes = await fs.readFile(path.join(root, file));
    bindings[file] = hash(bytes);
    return bytes;
  }
  const previous = previousFile
    ? JSON.parse(
        (
          await bind(
            path
              .relative(root, previousFile)
              .replaceAll(String.fromCharCode(92), '/'),
          )
        ).toString('utf8'),
      )
    : null;
  if (previous) {
    for (const [key, value] of Object.entries({
      rrf_k: 30,
      dense_weight: 1,
      candidates_per_lane_upper_bound: 60,
      min_dense_similarity: 0.3,
      title_weight: 2,
      model: 'qwen3.7-text-embedding',
      dimensions: 1024,
      lexical: 'ICU zh-CN',
      source_cap: null,
      context_budget: null,
    }))
      assert.deepEqual(previous[key], value, key);
  }
  for (const [scope, total, count] of [
    ['langchain', 203, 20],
    ['godot', 99, 10],
    ['du', 2000, 200],
  ]) {
    const file =
      'data/' +
      (scope === 'du'
        ? 'du-queries.jsonl'
        : 'freshstack-' + scope + '-queries.jsonl');
    const data = (await bind(file))
      .toString('utf8')
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse);
    assert.equal(data.length, total);
    queries[scope] = new Map(
      data.map((q) => [
        q.query_id ?? q.id,
        scope === 'du'
          ? q.text.trim()
          : (q.query_title + ' ' + q.query_text).trim(),
      ]),
    );
    cohorts[scope] = previous
      ? structuredClone(previous.cohorts[scope])
      : {
          population: total,
          sample: count,
          ids: sampleIds([...queries[scope].keys()], scope, count),
        };
    assert.equal(cohorts[scope].population, total);
    assert.equal(cohorts[scope].sample, count);
    assert.equal(cohorts[scope].ids.length, count);
    assert.equal(new Set(cohorts[scope].ids).size, count);
    assert.ok(cohorts[scope].ids.every((id) => queries[scope].has(id)));
  }
  const plan = {
    created: new Date().toISOString(),
    purpose:
      'Exploratory 10 percent weight pilot on already-opened data; no default adoption',
    sampling: {
      seed: 20260920,
      method:
        'Sort SHA256(JSON.stringify([seed,scope,query_id])); take first rounded 10 percent within each corpus; independent of labels/scores',
    },
    cohorts,
    bm25_weights: weights,
    ...(previousFile
      ? {
          previous_freeze: path
            .relative(root, previousFile)
            .replaceAll(String.fromCharCode(92), '/'),
          sample_reused_without_resampling: true,
        }
      : {}),
    dense_weight: 1,
    rrf_k: 30,
    candidates_per_lane_upper_bound: 60,
    min_dense_similarity: 0.3,
    title_weight: 2,
    lexical: 'ICU zh-CN',
    model: 'qwen3.7-text-embedding',
    dimensions: 1024,
    source_cap: null,
    context_budget: null,
    corpus: 'Full original corpus; only queries sampled',
    retrieval_unit: 'Official fixed units, not Echo chunking',
    zero_weight:
      'BM25 weight zero filters BM25-only candidates and equals dense order',
    new_embedding_calls: 0,
    bindings,
    environment: {
      node: process.version,
      icu: process.versions.icu,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
    },
    implementation_sha256: hash(await fs.readFile(new URL(import.meta.url))),
  };
  await fs.writeFile(
    path.join(out, 'freeze.json'),
    JSON.stringify(plan, null, 2) + '\n',
    { flag: 'wx' },
  );
  const projected = {},
    inputs = {};
  for (const scope of Object.keys(cohorts)) {
    const scorePath = 'analysis/' + scope + '-official-score.json';
    const score = JSON.parse((await bind(scorePath)).toString('utf8'));
    const runPath = 'fixed/' + scope + '-rrf30.jsonl';
    const runBytes = await bind(runPath);
    assert.equal(hash(runBytes), score.bindings[runPath]);
    for (const [p, h] of Object.entries(score.bindings)) {
      assert.equal(hash(await bind(p)), h, p);
    }
    const selected = new Set(cohorts[scope].ids),
      originals = new Map();
    for await (const row of jsonLines(path.join(root, runPath)))
      if (selected.has(row.id)) originals.set(row.id, row);
    assert.equal(originals.size, selected.size);
    projected[scope] = {};
    for (const w of plan.bm25_weights) {
      const results = cohorts[scope].ids.map((id) => {
        const original = originals.get(id),
          rankings = weightedRanks(original, w, plan.rrf_k);
        if (w === 0.5) assert.deepEqual(rankings, original.rankings);
        if (w === 0)
          assert.deepEqual(
            rankings.map((r) => r.id),
            original.rankings
              .filter((r) => r.dense_rank !== null)
              .sort((a, b) => a.dense_rank - b.dense_rank)
              .map((r) => r.id),
          );
        return { id, rrf_k: 30, bm25_weight: w, rankings };
      });
      const name = scope + '-w' + w + '.jsonl';
      await fs.writeFile(
        path.join(out, name),
        results.map((r) => JSON.stringify(r)).join('\n') + '\n',
        { flag: 'wx' },
      );
      projected[scope][w] = new Map(results.map((r) => [r.id, r]));
    }
    inputs[scope] = {
      original_score_file: scorePath,
      original_run_file: runPath,
    };
  }
  const ctx = await runtimeContext(root),
    probes = [],
    indexes = {};
  try {
    for (const scope of Object.keys(cohorts)) {
      const file = 'fixed/' + scope + '.sqlite',
        before = hash(await fs.readFile(path.join(root, file)));
      assert.equal(before, bindings[file]);
      const db = ctx.openDatabase(path.join(root, file), { readOnly: true });
      try {
        const config = ctx.parseConfig({
          database: path.join(root, file),
          embedding: ctx.plan.config,
          retrieval: { rrf_k: 30 },
        });
        for (const id of cohorts[scope].ids.slice(0, 2)) {
          for (const w of plan.bm25_weights) {
            const result = await ctx.retrieveQuery(
              db,
              config,
              id,
              queries[scope].get(id),
              {},
              {
                ...config.retrieval,
                mode: 'hybrid',
                rrf_k: 30,
                bm25_weight: w,
                dense_weight: 1,
              },
              ctx.provider,
            );
            assert.ok(['ok', 'empty'].includes(result.status));
            const got = result.candidates.map((c) => ({
              id: c.evidence.chunk_id,
              score: c.score,
            }));
            const expected = projected[scope][w]
              .get(id)
              .rankings.map((c) => ({ id: c.id, score: c.rrf_score }));
            assert.deepEqual(got, expected);
            probes.push({
              scope,
              id,
              bm25_weight: w,
              all_ids_scores_equal: true,
              candidates: got.length,
            });
          }
        }
      } finally {
        db.close();
      }
      const after = hash(await fs.readFile(path.join(root, file)));
      assert.equal(after, before);
      indexes[scope] = {
        file,
        before_sha256: before,
        after_sha256: after,
        equal_frozen: true,
      };
    }
  } finally {
    ctx.cache.close();
  }
  const sources = await archiveSources(out, 'public-weight-pilot', [
    'evals/run-public-weight-pilot.mjs',
    'evals/lib/public-runtime.mjs',
  ]);
  const receipt = {
    created: new Date().toISOString(),
    bindings,
    inputs,
    probes,
    indexes,
    network_forbidden: true,
    new_embedding_calls: 0,
    source_archive_root: out,
    sources,
  };
  await fs.writeFile(
    path.join(out, 'run-receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      samples: Object.fromEntries(
        Object.entries(cohorts).map(([s, c]) => [s, c.sample]),
      ),
      conditions: plan.bm25_weights,
      scored_query_conditions:
        Object.values(cohorts).reduce((n, c) => n + c.sample, 0) *
        weights.length,
      production_probes: probes.length,
      all_equal: true,
    }),
  );
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  await main();
