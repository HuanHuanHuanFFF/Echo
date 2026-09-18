import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { score, summarize } from './lib/evidence-metrics.mjs';
import { pairedBootstrap } from '../dist/retrieval-comparison.js';
const hash = (x) => createHash('sha256').update(x).digest('hex');
const digest = async (p) => hash(await fs.readFile(p));
const get = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const json = (x) => JSON.stringify(x, null, 2) + '\n';
const quantile = (xs, p) => {
  const a = [...xs].sort((x, y) => x - y),
    n = (a.length - 1) * p;
  return (
    a[Math.floor(n)] +
    (a[Math.ceil(n)] - a[Math.floor(n)]) * (n - Math.floor(n))
  );
};
const { values } = parseArgs({
  options: { lab: { type: 'string' }, 'run-id': { type: 'string' } },
});
assert.ok(values.lab && /^[a-z0-9-]+$/.test(values['run-id'] ?? ''));
const lab = path.resolve(values.lab),
  root = path.join(lab, 'evidence', values['run-id']);
const plan = await get(path.join(root, 'plan.json')),
  selection = await get(path.join(root, 'selection.json'));
const indexed = await get(path.join(root, 'index/report.json')),
  capture = await get(path.join(root, 'capture/report.json')),
  done = await get(path.join(root, 'queries/report.json'));
assert.equal(done.status, 'complete');
assert.equal(indexed.status, 'complete');
assert.equal(capture.status, 'complete');
assert.equal(
  plan.selection_sha256,
  await digest(path.join(root, 'selection.json')),
);
for (const obj of [indexed, capture, done])
  assert.equal(obj.plan_sha256, await digest(path.join(root, 'plan.json')));
assert.equal(plan.code.driver, await digest('evals/run-final-four-arms.mjs'));
assert.equal(
  plan.code.replay,
  await digest('evals/lib/frozen-query-fetch.mjs'),
);
assert.equal(
  plan.code.guard,
  await digest(path.join(lab, 'query-fetch-guard-final.mjs')),
);
const runtime = path.join(lab, 'echo-runtime-b454686/dist');
for (const [f, sha] of Object.entries(plan.runtime.files))
  assert.equal(await digest(path.join(runtime, f)), sha);
for (const [f, sha] of Object.entries(indexed.databases))
  assert.equal(await digest(f), sha);
assert.equal(done.replay.network_requests, 0);
assert.equal(done.replay.logical_requests, plan.logical_query_replays);
assert.equal(capture.network.requests, plan.query_caps.requests);
assert.equal(capture.network.input_chars, plan.query_caps.input_chars);
assert.equal(
  (await fs.readFile(path.join(root, 'queries/network-attempts.jsonl'), 'utf8'))
    .length,
  0,
);
const uses = (
  await fs.readFile(path.join(root, 'queries/vector-uses.jsonl'), 'utf8')
)
  .trim()
  .split(/\r?\n/)
  .map(JSON.parse);
const seeds = new Map(),
  vectorHashes = [];
for (const f of capture.response_hashes) {
  const file = path.join(root, 'capture/responses', f.file);
  assert.equal(await digest(file), f.sha256);
  const s = await get(file);
  assert.equal(s.key, hash(plan.endpoint + '\n' + JSON.stringify(s.request)));
  assert.equal(s.vector_sha256, hash(JSON.stringify(s.response.data)));
  seeds.set(s.key, s);
  vectorHashes.push({ file: 'capture/responses/' + f.file, sha256: f.sha256 });
}
for (const u of uses) {
  assert.equal(u.reused, true);
  assert.equal(u.vector_sha256, seeds.get(u.request_sha256)?.vector_sha256);
}
assert.equal(seeds.size, plan.query_caps.requests);
const sourceCache = new Map(),
  all = {},
  artifacts = [],
  conditionResults = [];
let piecesChecked = 0;
async function source(file) {
  if (!sourceCache.has(file)) {
    const bytes = await fs.readFile(file);
    sourceCache.set(file, {
      sha: hash(bytes),
      lines: bytes.toString('utf8').replaceAll('\r\n', '\n').split('\n'),
    });
  }
  return sourceCache.get(file);
}
for (const arm of selection.arms) {
  const primary = [],
    paired = [],
    byScope = {},
    byType = {},
    noAnswer = [];
  for (const item of plan.runs.filter((r) => r.id === arm.id)) {
    const dir = path.join(root, 'queries', item.outputName),
      manifest = await get(path.join(dir, 'manifest.json')),
      data = await get(path.join(dir, 'dataset.json')),
      report = await get(path.join(dir, 'report.json'));
    assert.equal(report.status, 'complete');
    assert.equal(data.split, 'test');
    assert.equal(
      await digest(path.join(dir, 'dataset.json')),
      item.dataset_sha256,
    );
    assert.equal(manifest.dataset.sha256, item.dataset_sha256);
    assert.deepEqual(manifest.runtime, plan.runtime);
    const { id, ...retrieval } = selection.retrieval;
    assert.deepEqual(manifest.retrieval, { ...retrieval, mode: arm.mode });
    assert.equal(manifest.budget_chars, 16000);
    assert.equal(manifest.selection.chunker, arm.strategy);
    assert.equal(manifest.index.ready, true);
    const rows = (await fs.readFile(path.join(dir, 'rows.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse);
    assert.deepEqual(rows, report.rows);
    assert.equal(rows.length, item.parents);
    const expectedRequests = new Set(
      data.questions.flatMap((q) =>
        q.subquestions?.length
          ? q.subquestions.map((s) => s.text.trim())
          : [q.query.trim()],
      ),
    );
    const armUses = uses.filter((u) => u.run === item.outputName);
    assert.equal(armUses.length, item.logical_requests);
    if (arm.mode === 'bm25') assert.equal(report.api_usage, null);
    else {
      assert.deepEqual(
        [
          ...new Set(
            armUses.map((u) => seeds.get(u.request_sha256).request.input[0]),
          ),
        ].sort(),
        [...expectedRequests].sort(),
      );
      assert.equal(report.api_usage.requests, item.logical_requests);
      assert.equal(report.api_usage.reported_tokens, 0);
    }
    const scored = [];
    for (const [i, row] of rows.entries()) {
      const q = data.questions[i];
      assert.equal(q.id, row.query_id);
      assert.ok(['ok', 'empty'].includes(row.status));
      assert.equal(row.request_chars, JSON.stringify(row.request).length);
      assert.equal(row.response_chars, JSON.stringify(row.result).length);
      assert.equal(row.context_chars, row.request_chars + row.response_chars);
      assert.ok(row.context_chars <= 16000);
      assert.ok(row.result.results.length <= 10);
      const counts = new Map();
      for (const p of row.result.results) {
        const src = await source(p.path);
        assert.equal(src.sha, p.source_version);
        const c = data.corpus.find(
          (c) =>
            c.collection_id === p.collection_id && c.path === p.relative_path,
        );
        assert.ok(c);
        assert.equal(c.sha256, src.sha);
        assert.equal(
          src.lines.slice(p.start_line - 1, p.end_line).join('\n'),
          p.text,
        );
        counts.set(p.source_id, (counts.get(p.source_id) ?? 0) + 1);
        piecesChecked++;
      }
      assert.ok([...counts.values()].every((n) => n <= 3));
      const metric = score(q, data.facts, row.result.results);
      if (!metric.noAnswer)
        assert.deepEqual(metric.fullCovered, row.covered_facts);
      const scoredRow = {
        id: q.id,
        group: q.intent_group,
        type: q.type,
        scope: item.scope,
        request: row.request,
        metric,
        context_chars: row.context_chars,
        latency_ms: row.latency_ms,
        excluded: row.result.excluded,
        results: row.result.results,
        subquery_coverage: row.subquery_coverage,
      };
      scored.push(metric);
      if (item.paired) paired.push(scoredRow);
      else {
        primary.push(scoredRow);
        (byType[q.type] ??= []).push(metric);
        if (q.no_answer)
          noAnswer.push({
            id: q.id,
            scope: item.scope,
            nonempty: row.result.results.length > 0,
            chunks: row.result.results.length,
            context_chars: row.context_chars,
          });
      }
    }
    byScope[item.scope] = summarize(scored);
    for (const f of [
      'dataset.json',
      'manifest.json',
      'rows.jsonl',
      'report.json',
    ])
      artifacts.push({
        file: 'queries/' + item.outputName + '/' + f,
        sha256: await digest(path.join(dir, f)),
      });
  }
  assert.equal(primary.length, 200);
  assert.equal(paired.length, 40);
  all[arm.id] = { primary, paired };
  const cost = (rows) => ({
    parents: rows.length,
    context_chars: rows.reduce((n, r) => n + r.context_chars, 0),
    chunks: rows.reduce((n, r) => n + r.results.length, 0),
    budget_exclusion_questions: rows.filter((r) => r.excluded.budget > 0)
      .length,
    under_topk_questions: rows.filter((r) => r.results.length < 10).length,
    latency_ms: {
      p50: quantile(
        rows.map((r) => r.latency_ms),
        0.5,
      ),
      p95: quantile(
        rows.map((r) => r.latency_ms),
        0.95,
      ),
      meaning:
        'local frozen-vector replay; excludes real API capture and MCP/Agent',
    },
  });
  conditionResults.push({
    ...arm,
    primary: summarize(primary.map((r) => r.metric)),
    paired: summarize(paired.map((r) => r.metric)),
    byScope,
    byType: Object.fromEntries(
      Object.entries(byType).map(([t, ms]) => [t, summarize(ms)]),
    ),
    cost: cost(primary),
    paired_cost: cost(paired),
    no_answer: noAnswer,
  });
}
const contrasts = [],
  hybrid = all['structure-hybrid'].primary;
function pairedCounts(base, other) {
  return other.map((r) => {
    const b = base.find((x) => x.id === r.id);
    assert.ok(b);
    assert.deepEqual(r.request, b.request);
    return {
      id: r.id,
      group: r.group,
      baseline: {
        covered: b.metric.fullCovered?.length ?? 0,
        expected: b.metric.expectedFacts ?? 0,
      },
      candidate: {
        covered: r.metric.fullCovered?.length ?? 0,
        expected: r.metric.expectedFacts ?? 0,
      },
    };
  });
}
function differences(base, candidate) {
  const result = [];
  let gains = 0,
    losses = 0,
    ties = 0;
  for (const r of candidate) {
    const b = base.find((x) => x.id === r.id);
    assert.ok(b);
    if (r.metric.noAnswer) continue;
    const gained = r.metric.fullCovered.filter(
        (f) => !b.metric.fullCovered.includes(f),
      ),
      lost = b.metric.fullCovered.filter(
        (f) => !r.metric.fullCovered.includes(f),
      );
    const bc = b.metric.k[10].complete,
      rc = r.metric.k[10].complete;
    if (rc && !bc) gains++;
    else if (bc && !rc) losses++;
    else ties++;
    if (gained.length || lost.length)
      result.push({
        id: r.id,
        scope: r.scope,
        type: r.type,
        baseline: b.metric.fullCovered,
        candidate: r.metric.fullCovered,
        gained,
        lost,
      });
  }
  return {
    complete_pairs: { candidate_only: gains, baseline_only: losses, ties },
    fact_changes: result,
  };
}
for (const arm of selection.arms.filter((a) => a.id !== 'structure-hybrid')) {
  const base = all[arm.id].primary,
    pairs = pairedCounts(base, hybrid);
  const options = {
    iterations: selection.statistics.bootstrap_iterations,
    seed: selection.statistics.seed,
  };
  const byScope = {};
  for (const scope of ['A-test', 'B-test', 'C-test', 'D-test', 'mixed-test'])
    byScope[scope] = pairedBootstrap(
      pairs.filter((r) => hybrid.find((x) => x.id === r.id).scope === scope),
      options,
    );
  contrasts.push({
    baseline: arm.id,
    candidate: 'structure-hybrid',
    pooled: pairedBootstrap(pairs, options),
    byScope,
    ...differences(base, hybrid),
  });
}
const interference = [];
for (const arm of selection.arms) {
  const { primary, paired } = all[arm.id],
    single = paired.map((r) => primary.find((p) => p.id === r.id));
  assert.ok(single.every(Boolean));
  assert.ok(single.every((r) => r.scope !== 'mixed-test'));
  const pairs = pairedCounts(single, paired);
  interference.push({
    arm: arm.id,
    single: summarize(single.map((r) => r.metric)),
    mixed: summarize(paired.map((r) => r.metric)),
    statistics: pairedBootstrap(pairs, {
      iterations: selection.statistics.bootstrap_iterations,
      seed: selection.statistics.seed,
    }),
    ...differences(single, paired),
  });
}
const out = path.join(root, 'analysis');
await fs.mkdir(out);
await fs.copyFile(
  fileURLToPath(import.meta.url),
  path.join(out, 'execution-analyzer.mjs'),
  fs.constants.COPYFILE_EXCL,
);
const problemIds = new Set(
  contrasts.flatMap((c) => c.fact_changes.map((r) => r.id)),
);
await fs.writeFile(
  path.join(out, 'cases.private.json'),
  json(
    Object.fromEntries(
      Object.entries(all).map(([id, data]) => [
        id,
        {
          primary: data.primary.filter((r) => problemIds.has(r.id)),
          paired: data.paired,
        },
      ]),
    ),
  ),
  { flag: 'wx' },
);
for (const f of [
  'selection.json',
  'plan.json',
  'execution-driver.mjs',
  'index/report.json',
  'index/rows.jsonl',
  'index/network-attempts.jsonl',
  'capture/report.json',
  'capture/network-attempts.jsonl',
  'capture/vector-uses.jsonl',
  'queries/report.json',
  'queries/vector-uses.jsonl',
  'queries/network-attempts.jsonl',
  'queries/completed-runs.jsonl',
])
  artifacts.push({ file: f, sha256: await digest(path.join(root, f)) });
const result = {
  status: 'complete',
  date: '2026-09-18',
  primary_questions: 200,
  paired_existing_questions: 40,
  primary_parent_executions: 800,
  paired_parent_executions: 160,
  original_final_labels_unchanged: true,
  selection_sha256: plan.selection_sha256,
  frozen_bundle_sha256: plan.bundle_sha256,
  model: plan.model,
  dimensions: plan.dimensions,
  tokenizer: 'icu-zh',
  retrieval: plan.retrieval,
  split_parents: plan.split_parents,
  fixed_subquestions: plan.fixed_subquestions,
  conditions: conditionResults,
  contrasts,
  interference,
  actual_api: {
    documents: indexed.usage,
    queries: capture.usage,
    document_guard: indexed.network,
    query_guard: capture.network,
    total_requests: indexed.network.requests + capture.network.requests,
    input_chars: indexed.network.input_chars + capture.network.input_chars,
    reported_tokens:
      indexed.usage.reported_tokens !== null &&
      capture.usage.reported_tokens !== null
        ? indexed.usage.reported_tokens + capture.usage.reported_tokens
        : null,
  },
  comparison_replay: done.replay,
  document_cache_hits: indexed.cacheHits,
  validation: {
    checked_rows: 960,
    checked_pieces: piecesChecked,
    source_files_checked: sourceCache.size,
    databases: indexed.databases,
    databases_unchanged: true,
  },
  runtime: plan.runtime,
  code: {
    driver: plan.code,
    analyzer: await digest(fileURLToPath(import.meta.url)),
    metrics: await digest(
      new URL('./lib/evidence-metrics.mjs', import.meta.url),
    ),
    bootstrap_source: await digest('src/retrieval-comparison.ts'),
  },
  artifact_hashes: artifacts,
  real_query_response_hashes: vectorHashes,
  private_cases_sha256: await digest(path.join(out, 'cases.private.json')),
  limits: [
    'AI labels/reviews, not human gold',
    'No post-final tuning or relabeling',
    'One embedding model and fixed corpus',
    'Pure retrieval, no Agent answers',
    'Latency is offline replay only',
    'Declared intent groups are not proof of statistical independence',
  ],
};
await fs.writeFile(path.join(out, 'summary.public.json'), json(result), {
  flag: 'wx',
});
console.log(
  json({
    conditions: conditionResults.map((c) => ({
      id: c.id,
      complete: c.primary.k[10].completeEvidence,
      facts: c.primary.k[10].factCovered,
      mrr: c.primary.k[10].singleChunkMRR,
      context: c.cost.context_chars,
      byScope: Object.fromEntries(
        Object.entries(c.byScope).map(([s, m]) => [
          s,
          {
            complete: m.k[10].completeEvidence.count,
            answerable: m.answerable,
            facts: m.k[10].factCovered,
            expected: m.expectedFacts,
          },
        ]),
      ),
    })),
    contrasts: contrasts.map((c) => ({
      baseline: c.baseline,
      complete: c.pooled.complete_evidence,
      facts: c.pooled.fact_coverage,
      pairs: c.complete_pairs,
    })),
    api: result.actual_api,
    checked_pieces: piecesChecked,
  }),
);
