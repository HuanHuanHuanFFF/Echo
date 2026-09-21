import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { digest } from './prepare-public-benchmarks.mjs';
import {
  runtimeContext,
  boundedRequest,
  qasperScore,
} from './lib/public-runtime.mjs';
import { archiveSources } from './lib/public-provenance.mjs';

assert.ok(process.argv[2] && process.argv[3], 'Usage: ROOT NEW_OUT');
const root = path.resolve(process.argv[2]),
  out = path.resolve(process.argv[3]);
const rel = path.relative(root, out);
assert.ok(
  rel &&
    !path.isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith('..' + path.sep),
);
globalThis.fetch = async () => {
  throw new Error('Network forbidden in QASPER source-cap pilot');
};
const read = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const jsonRows = (bytes) =>
  bytes.toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
const write = async (name, value) =>
  fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
const previousManifestFile =
  'docs/evals/2026-09-20-qasper-weight-pilot.manifest.json';
const previousManifestBytes = await fs.readFile(previousManifestFile),
  previous = JSON.parse(previousManifestBytes);
const priorDir = 'analysis/qasper-weight-pilot-2026-09-20-v1';
for (const f of previous.artifacts)
  assert.equal(
    digest(await fs.readFile(path.join(root, f.file))),
    f.sha256,
    f.file,
  );
const bindings = { ...previous.run_receipt.bindings };
for (const [p, h] of Object.entries(bindings))
  assert.equal(digest(await fs.readFile(path.join(root, p))), h, p);
for (const f of previous.runtime_profile_audit.files) {
  assert.equal(
    digest(await fs.readFile(path.join(root, f.file))),
    f.sha256,
    f.file,
  );
  bindings[f.file] = f.sha256;
}
for (const p of ['freeze.json', 'w0.5-results.jsonl', 'summary.json']) {
  const file = path.join(priorDir, p).replaceAll(path.sep, '/');
  bindings[file] = digest(await fs.readFile(path.join(root, file)));
}
const oldPlan = await read(path.join(root, priorDir, 'freeze.json'));
const ids = oldPlan.ids;
assert.equal(ids.length, 101);
assert.equal(new Set(ids).size, 101);
const queries = new Map(
  jsonRows(
    await fs.readFile(path.join(root, 'prepared/qasper-queries.jsonl')),
  ).map((q) => [q.id, q]),
);
const selected = ids.map((id) => queries.get(id));
assert.ok(selected.every(Boolean));
assert.equal(selected.filter((q) => q.eligible).length, 78);
const docs = new Map();
for (const d of jsonRows(
  await fs.readFile(path.join(root, 'prepared/qasper-docs.jsonl')),
)) {
  if (!selected.some((q) => q.paper_id === d.id)) continue;
  const markdown = await fs.readFile(d.file, 'utf8');
  assert.equal(digest(markdown), d.sha256, d.id);
  docs.set(d.id, { ...d, markdown });
}
assert.equal(docs.size, 82);
const baselineBytes = await fs.readFile(
  path.join(root, priorDir, 'w0.5-results.jsonl'),
);
const baseline = jsonRows(baselineBytes);
assert.deepEqual(
  baseline.map((r) => r.id),
  ids,
);
const evidence = (result) =>
  result.results.map((p) => ({
    id: p.chunk_id,
    source_id: p.source_id,
    start_line: p.start_line,
    end_line: p.end_line,
    text: p.text,
  }));
const summarize = (values) => {
  const eligible = values.filter((r) => r.score.eligible);
  return {
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
  };
};
const ctx = await runtimeContext(root);
try {
  const cfg = await ctx.loadConfig(path.join(root, 'qasper/p1.json'));
  assert.equal(cfg.database, path.join(root, 'qasper/structure.sqlite'));
  assert.deepEqual(cfg.retrieval, oldPlan.retrieval);
  assert.equal(ctx.plan.fingerprint, oldPlan.model_fingerprint);
  assert.equal(cfg.retrieval.max_chunks_per_source, 3);
  assert.equal(cfg.retrieval.bm25_weight, 0.5);
  const before = digest(await fs.readFile(cfg.database));
  assert.equal(before, previous.run_receipt.index_sha256_after);
  for (let i = 0; i < baseline.length; i++) {
    const row = baseline[i],
      q = selected[i],
      doc = docs.get(q.paper_id);
    assert.equal(row.result.applied.max_chunks_per_source, 3);
    assert.equal(row.request_chars, JSON.stringify(row.request).length);
    assert.equal(row.response_chars, JSON.stringify(row.result).length);
    assert.ok(row.request_chars + row.response_chars <= 16000);
    assert.deepEqual(row.score, qasperScore(q, doc, row.result, doc.markdown));
  }
  await fs.mkdir(out);
  const plan = {
    created: new Date().toISOString(),
    scope: 'QASPER 101 frozen queries; only max_chunks_per_source 3 versus 5',
    ids,
    questions: 101,
    eligible: 78,
    categories: oldPlan.categories,
    papers: 82,
    sampling: {
      ...oldPlan.sampling,
      reuse: 'Exact previous frozen IDs; no resampling',
    },
    source_caps: [3, 5],
    baseline_reused: true,
    new_condition: 5,
    chunker: oldPlan.chunker,
    embedding: oldPlan.embedding,
    model_fingerprint: oldPlan.model_fingerprint,
    retrieval: cfg.retrieval,
    cumulative_budget_utf16: 16000,
    known_target_paper: true,
    query_input: oldPlan.query_input,
    request_accounting:
      'Cap 5 is an explicit request override; its serialized field counts against the same request-plus-response budget. Cap 3 bytes are reused unchanged.',
    previous_manifest_sha256: digest(previousManifestBytes),
    bindings,
    environment: { node: process.version, icu: process.versions.icu },
    implementation_sha256: digest(await fs.readFile(new URL(import.meta.url))),
    new_embedding_calls: 0,
    network_forbidden: true,
    limitations: [
      'Exploratory already-opened sample, not blind or full evaluation',
      'No default adoption, rerank, chunking or other parameter changes',
    ],
  };
  await write('freeze.json', plan);
  await fs.writeFile(path.join(out, 'cap3-results.jsonl'), baselineBytes, {
    flag: 'wx',
  });
  const file = await fs.open(path.join(out, 'cap5-results.jsonl'), 'wx');
  const values = [];
  try {
    for (let i = 0; i < selected.length; i++) {
      const q = selected[i],
        request = boundedRequest(q.text, q.source_id, 16000, {
          mode: 'hybrid',
          bm25_weight: 0.5,
          max_chunks_per_source: 5,
        });
      const start = performance.now();
      const result = await ctx.searchIndex(
        cfg,
        request,
        undefined,
        ctx.provider,
      );
      assert.ok(['ok', 'empty'].includes(result.status), result.status);
      const expected = {
        ...baseline[i].result.applied,
        max_chunks_per_source: 5,
        max_context_chars: request.overrides.max_context_chars,
      };
      assert.deepEqual(result.applied, expected);
      const requestChars = JSON.stringify(request).length,
        responseChars = JSON.stringify(result).length;
      assert.ok(requestChars + responseChars <= 16000);
      assert.ok(result.results.length <= 5 && result.results.length <= 10);
      assert.deepEqual(
        evidence({ results: result.results.slice(0, 3) }),
        evidence(baseline[i].result),
      );
      const doc = docs.get(q.paper_id),
        score = qasperScore(q, doc, result, doc.markdown);
      const row = {
        id: q.id,
        paper_id: q.paper_id,
        source_cap: 5,
        bm25_weight: 0.5,
        request,
        result,
        request_chars: requestChars,
        response_chars: responseChars,
        offline_ms: performance.now() - start,
        score,
      };
      await file.write(JSON.stringify(row) + '\n');
      values.push(row);
      if (values.length % 25 === 0)
        console.log(
          JSON.stringify({ cap: 5, completed: values.length, total: 101 }),
        );
    }
  } finally {
    await file.close();
  }
  const after = digest(await fs.readFile(cfg.database));
  assert.equal(after, before);
  const summaries = { 3: summarize(baseline), 5: summarize(values) };
  const sources = await archiveSources(out, 'qasper-source-cap-pilot', [
    'evals/run-qasper-source-cap-pilot.mjs',
    'evals/score-qasper-source-cap-pilot.py',
    'evals/lib/public-runtime.mjs',
    'evals/lib/public-provenance.mjs',
  ]);
  await write('run-receipt.json', {
    created: new Date().toISOString(),
    calls: values.length,
    baseline_reused_rows: 101,
    baseline_bytes_equal:
      digest(await fs.readFile(path.join(out, 'cap3-results.jsonl'))) ===
      digest(baselineBytes),
    baseline_scores_recomputed_equal: true,
    first_three_evidence_equal: true,
    summaries,
    index_sha256_before: before,
    index_sha256_after: after,
    bindings,
    previous_manifest_sha256: digest(previousManifestBytes),
    sources,
    source_archive_root: out,
    new_embedding_calls: 0,
    network_forbidden: true,
  });
  console.log(
    JSON.stringify({ calls: values.length, summaries, new_embedding_calls: 0 }),
  );
} finally {
  ctx.cache.close();
}
