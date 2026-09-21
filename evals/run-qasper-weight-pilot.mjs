import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { jsonLines, digest } from './prepare-public-benchmarks.mjs';
import { sampleIds } from './run-public-weight-pilot.mjs';
import {
  runtimeContext,
  boundedRequest,
  qasperScore,
} from './lib/public-runtime.mjs';
import { archiveSources } from './lib/public-provenance.mjs';
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
await fs.mkdir(out);
globalThis.fetch = async () => {
  throw new Error('Network forbidden in QASPER pilot');
};
const manifest = JSON.parse(
  await fs.readFile(
    'docs/evals/2026-09-20-public-full-results.manifest.json',
    'utf8',
  ),
);
const oldArtifacts = new Map(manifest.artifacts.map((x) => [x.file, x.sha256]));
const bindings = {};
async function bind(file, requireFrozen = true) {
  const bytes = await fs.readFile(path.join(root, file)),
    sha = digest(bytes);
  if (requireFrozen)
    assert.equal(
      sha,
      oldArtifacts.get(file),
      'Original frozen binding: ' + file,
    );
  bindings[file] = sha;
  return bytes;
}
const allQueries = (await bind('prepared/qasper-queries.jsonl'))
  .toString('utf8')
  .trim()
  .split(/\r?\n/)
  .map(JSON.parse);
assert.equal(allQueries.length, 1005);
const ids = sampleIds(
  allQueries.map((q) => q.id),
  'qasper',
  101,
  20260920,
);
const queryMap = new Map(allQueries.map((q) => [q.id, q]));
const selected = ids.map((id) => queryMap.get(id));
const oldSummary = JSON.parse(
  (await bind('qasper/p1-summary.json')).toString('utf8'),
);
const before = digest(await bind('qasper/structure.sqlite'));
assert.equal(before, oldSummary.index_sha256);
const originalBytes = await bind('qasper/p1-results.jsonl');
assert.equal(digest(originalBytes), oldSummary.results_sha256);
const original = new Map(
  originalBytes
    .toString('utf8')
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse)
    .filter((r) => ids.includes(r.id))
    .map((r) => [r.id, r]),
);
assert.equal(original.size, 101);
const docs = new Map();
for (const d of (await bind('prepared/qasper-docs.jsonl'))
  .toString('utf8')
  .trim()
  .split(/\r?\n/)
  .map(JSON.parse)) {
  if (!selected.some((q) => q.paper_id === d.id)) continue;
  const markdown = await fs.readFile(d.file, 'utf8');
  assert.equal(digest(markdown), d.sha256);
  const relative = path
    .relative(root, d.file)
    .replaceAll(String.fromCharCode(92), '/');
  bindings[relative] = digest(markdown);
  docs.set(d.id, { ...d, markdown });
}
for (const file of [
  'data/qasper-dev.jsonl',
  'embedding-plan.json',
  'reference/qasper_evaluator.py',
  'qasper/p1.json',
  'qasper/config/retrieval/rrf30.json',
  'qasper/chunkers/markdown-structure-v1.mjs',
  'qasper/tokenizers/icu-zh.mjs',
])
  await bind(file);
const ctx = await runtimeContext(root);
try {
  const cfg = await ctx.loadConfig(path.join(root, 'qasper/p1.json'));
  assert.equal(cfg.database, path.join(root, 'qasper/structure.sqlite'));
  for (const [k, v] of Object.entries({
    mode: 'hybrid',
    topk: 10,
    max_chunks_per_source: 3,
    bm25_candidates: 60,
    dense_candidates: 60,
    rrf_k: 30,
    title_weight: 2,
    bm25_weight: 0.5,
    dense_weight: 1,
    max_context_chars: 16000,
    min_dense_similarity: 0.3,
  }))
    assert.equal(cfg.retrieval[k], v, k);
  const plan = {
    created: new Date().toISOString(),
    scope: 'QASPER v0.3 dev weight pilot',
    sampling: {
      seed: 20260920,
      method:
        'SHA256 ID order within qasper; first 101 of 1005, no label balancing/resampling',
    },
    ids,
    questions: 101,
    eligible: selected.filter((q) => q.eligible).length,
    categories: Object.fromEntries(
      [...new Set(selected.map((q) => q.category))].map((c) => [
        c,
        selected.filter((q) => q.category === c).length,
      ]),
    ),
    papers: docs.size,
    weights: [0, 0.1, 0.25, 0.3, 0.4, 0.5],
    zero_weight_mode: 'dense',
    chunker: 'markdown-structure-v1 (frozen 1.0.1)',
    embedding: ctx.plan.config,
    model_fingerprint: ctx.plan.fingerprint,
    retrieval: cfg.retrieval,
    cumulative_budget_utf16: 16000,
    known_target_paper: true,
    source_filters: 'Original single target paper UUID per question',
    query_input: 'Original complete question, no subquestion rewriting',
    new_embedding_calls: 0,
    network_forbidden: true,
    bindings,
    environment: { node: process.version, icu: process.versions.icu },
    implementation_sha256: digest(await fs.readFile(new URL(import.meta.url))),
    limitations: [
      'Already-opened data, exploratory sample not blind evaluation',
      'Official F1 on all sampled questions differs from strict eligible completeness',
      'No source-cap or budget change, no answer generation',
    ],
  };
  await fs.writeFile(
    path.join(out, 'freeze.json'),
    JSON.stringify(plan, null, 2) + '\n',
    { flag: 'wx' },
  );
  let calls = 0;
  const summaries = {};
  const evidence = (r) =>
    r.results.map((x) => ({
      id: x.chunk_id,
      source_id: x.source_id,
      start_line: x.start_line,
      end_line: x.end_line,
      text: x.text,
    }));
  for (const w of plan.weights) {
    const file = await fs.open(
      path.join(out, 'w' + w + '-results.jsonl'),
      'wx',
    );
    const values = [];
    try {
      for (const q of selected) {
        const request = boundedRequest(q.text, q.source_id, 16000, {
          mode: w === 0 ? 'dense' : 'hybrid',
          bm25_weight: w,
        });
        const start = performance.now();
        const result = await ctx.searchIndex(
          cfg,
          request,
          undefined,
          ctx.provider,
        );
        calls++;
        assert.ok(['ok', 'empty'].includes(result.status), result.status);
        const requestChars = JSON.stringify(request).length,
          responseChars = JSON.stringify(result).length;
        assert.ok(requestChars + responseChars <= 16000);
        assert.ok(result.results.length <= 3 && result.results.length <= 10);
        const doc = docs.get(q.paper_id),
          score = qasperScore(q, doc, result, doc.markdown);
        if (w === 0.5) {
          assert.deepEqual(score, original.get(q.id).score);
          assert.deepEqual(
            evidence(result),
            evidence(original.get(q.id).result),
          );
        }
        const row = {
          id: q.id,
          paper_id: q.paper_id,
          bm25_weight: w,
          request,
          result,
          request_chars: requestChars,
          response_chars: responseChars,
          offline_ms: performance.now() - start,
          score,
        };
        await file.write(JSON.stringify(row) + '\n');
        values.push(row);
      }
    } finally {
      await file.close();
    }
    const eligible = values.filter((r) => r.score.eligible);
    summaries[w] = {
      questions: values.length,
      eligible: eligible.length,
      complete: eligible.filter((r) => r.score.strict_complete).length,
      strict_coverage:
        eligible.reduce((n, r) => n + r.score.strict_coverage, 0) /
        eligible.length,
      evidence_f1_all:
        values.reduce((n, r) => n + r.score.official_formula_evidence_f1, 0) /
        values.length,
      mean_context_chars:
        values.reduce((n, r) => n + r.request_chars + r.response_chars, 0) /
        values.length,
      budget_exclusion_questions: values.filter(
        (r) => r.result.excluded.budget > 0,
      ).length,
      source_cap_questions: values.filter(
        (r) => r.result.excluded.source_limit > 0,
      ).length,
      empty_results: values.filter((r) => r.result.results.length === 0).length,
    };
    console.log(JSON.stringify({ weight: w, ...summaries[w] }));
  }
  const after = digest(await fs.readFile(cfg.database));
  assert.equal(after, before);
  const sources = await archiveSources(out, 'qasper-weight-pilot', [
    'evals/run-qasper-weight-pilot.mjs',
    'evals/lib/public-runtime.mjs',
    'evals/run-public-weight-pilot.mjs',
  ]);
  await fs.writeFile(
    path.join(out, 'run-receipt.json'),
    JSON.stringify(
      {
        created: new Date().toISOString(),
        calls,
        summaries,
        baseline_0_5_all_scores_and_evidence_equal: true,
        index_sha256_before: before,
        index_sha256_after: after,
        network_forbidden: true,
        new_embedding_calls: 0,
        source_archive_root: out,
        sources,
        bindings,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
} finally {
  ctx.cache.close();
}
