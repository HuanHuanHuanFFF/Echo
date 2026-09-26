import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const specs = {
  'public-A': { bm25_weight: 0.5, dense_weight: 1, rrf_k: 10 },
  'public-B': { bm25_weight: 0.31, dense_weight: 0.8, rrf_k: 5 },
};
const populations = { langchain: 203, godot: 99, du: 2000, qasper: 1005 };
const sampleCounts = { langchain: 20, godot: 10, du: 200, qasper: 101 };
const sourceCounts = { langchain: 49505, godot: 25477, du: 100001 };
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function* jsonLines(file) {
  let pending = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (pending.trim()) yield JSON.parse(pending);
}

async function rows(file) {
  const output = [];
  for await (const row of jsonLines(file)) output.push(row);
  return output;
}

async function sha(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function near(actual, expected) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) < 1e-12,
    `${actual} != ${expected}`,
  );
}

function rrf(row, spec) {
  let value = 0;
  for (const [rankKey, weightKey] of [
    ['bm25_rank', 'bm25_weight'],
    ['dense_rank', 'dense_weight'],
  ]) {
    const rank = row[rankKey];
    if (rank !== null && rank !== undefined) {
      assert.ok(Number.isInteger(rank) && rank >= 1 && rank <= 60);
      value += spec[weightKey] / (spec.rrf_k + rank);
    }
  }
  return value;
}

function identityOrder(data, ids) {
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    data.map((row) => row.id),
    ids,
  );
}

function rankingOrder(items) {
  assert.equal(new Set(items.map((row) => row.id)).size, items.length);
  for (const [index, row] of items.entries()) {
    assert.equal(row.rank, index + 1);
    assert.equal(row.rank_score, items.length - index);
    if (index) assert.ok(items[index - 1].rrf_score >= row.rrf_score - 1e-12);
  }
}

function withoutRrf(items) {
  return items.map(({ rrf_score: _score, ...item }) => item);
}

async function auditFixed(scope, publicRoot, out, freeze, refs, files) {
  const cohort = freeze.public.source_freeze.cohorts[scope];
  const poolsPath = path.join(out, 'public', `${scope}-candidates.jsonl`);
  const pools = await rows(poolsPath);
  identityOrder(pools, cohort.ids);
  files.push(poolsPath, cohort.corpus_file, cohort.query_file);
  const corpus = new Set();
  for await (const row of jsonLines(cohort.corpus_file)) {
    corpus.add(row._id ?? row.id);
  }
  assert.equal(corpus.size, sourceCounts[scope]);
  let formulaChecks = 0;
  const exactSamples = {};
  for (const [arm, spec] of Object.entries(specs)) {
    const outputPath = path.join(out, 'public', `${scope}-${arm}-hybrid.jsonl`);
    const data = await rows(outputPath);
    files.push(outputPath);
    identityOrder(data, cohort.ids);
    for (const [index, row] of data.entries()) {
      assert.equal(row.condition, `${arm}-hybrid`);
      assert.equal(row.rrf_k, spec.rrf_k);
      rankingOrder(row.rankings);
      const pool = pools[index][arm];
      assert.deepEqual(row.rankings, pool.hybrid);
      const laneMaps = {};
      for (const lane of ['bm25', 'dense']) {
        assert.ok(pool[lane].length <= 60);
        rankingOrder(pool[lane]);
        laneMaps[lane] = new Map(
          pool[lane].map((item) => [item.id, item.rank]),
        );
        for (const item of pool[lane]) {
          assert.ok(corpus.has(item.id));
          near(item.rrf_score, 1 / (spec.rrf_k + item.rank));
          if (lane === 'dense') assert.ok(item.similarity >= 0.3);
        }
      }
      assert.deepEqual(
        new Set(row.rankings.map((item) => item.id)),
        new Set([...laneMaps.bm25.keys(), ...laneMaps.dense.keys()]),
      );
      for (const item of row.rankings) {
        assert.equal(item.bm25_rank, laneMaps.bm25.get(item.id) ?? null);
        assert.equal(item.dense_rank, laneMaps.dense.get(item.id) ?? null);
        near(item.rrf_score, rrf(item, spec));
        formulaChecks++;
      }
    }
    const priorPath = path.join(
      refs[arm].root,
      'public',
      `${scope}-${refs[arm].label}-hybrid.jsonl`,
    );
    const prior = await rows(priorPath);
    assert.equal(prior.length, sampleCounts[scope]);
    const byId = new Map(data.map((row) => [row.id, row]));
    for (const row of prior)
      assert.deepEqual(byId.get(row.id)?.rankings, row.rankings);
    files.push(priorPath);
    exactSamples[arm] = prior.length;
  }
  for (const pool of pools)
    for (const lane of ['bm25', 'dense']) {
      assert.deepEqual(
        withoutRrf(pool['public-A'][lane]),
        withoutRrf(pool['public-B'][lane]),
      );
    }
  return {
    questions: pools.length,
    corpus_units: corpus.size,
    rrf_scores_checked: formulaChecks,
    same_candidate_pools: pools.length,
    exact_prior_samples: exactSamples,
  };
}

function scoreFromLines(query, doc, result, text) {
  const lines = text.split('\n');
  const returned = new Set();
  for (const piece of result.results) {
    assert.equal(piece.source_id, doc.source_id);
    assert.equal(path.resolve(piece.path), path.resolve(doc.file));
    assert.equal(piece.relative_path, doc.relative_path);
    assert.ok(
      Number.isInteger(piece.start_line) && Number.isInteger(piece.end_line),
    );
    assert.ok(
      piece.start_line >= 1 &&
        piece.end_line >= piece.start_line &&
        piece.end_line <= lines.length,
    );
    assert.equal(
      piece.text,
      lines.slice(piece.start_line - 1, piece.end_line).join('\n'),
    );
    for (let n = piece.start_line; n <= piece.end_line; n++) returned.add(n);
  }
  const selected = doc.paragraphs.filter((paragraph) => {
    for (let n = paragraph.start_line; n <= paragraph.end_line; n++) {
      if (lines[n - 1].trim() && !returned.has(n)) return false;
    }
    return true;
  });
  const ids = new Set(selected.map((paragraph) => paragraph.id));
  const predicted = new Set(selected.map((paragraph) => paragraph.text));
  const annotations = query.annotations.map((annotation) => {
    const gold = new Set(annotation.evidence.map((evidence) => evidence.text));
    const matched = [...predicted].filter((text) => gold.has(text)).length;
    const covered = annotation.evidence.filter((evidence) =>
      evidence.paragraph_ids.some((id) => ids.has(id)),
    ).length;
    const total = selected.length + annotation.evidence.length;
    return {
      valid: annotation.valid,
      complete: annotation.valid && covered === annotation.evidence.length,
      coverage: annotation.evidence.length
        ? covered / annotation.evidence.length
        : 0,
      f1: total ? (2 * matched) / total : 1,
    };
  });
  const valid = annotations.filter((row) => row.valid);
  return {
    selected: [...ids],
    complete: valid.some((row) => row.complete),
    coverage: valid.length
      ? Math.max(...valid.map((row) => row.coverage))
      : null,
    f1: Math.max(...annotations.map((row) => row.f1)),
  };
}

async function auditQasper(publicRoot, out, freeze, refs, files) {
  const cohort = freeze.public.source_freeze.cohorts.qasper;
  const queries = await rows(cohort.query_file);
  identityOrder(queries, cohort.ids);
  assert.equal(queries.filter((q) => q.eligible).length, 800);
  const categories = {};
  for (const query of queries)
    categories[query.category] = (categories[query.category] ?? 0) + 1;
  assert.deepEqual(categories, {
    text_evidence: 800,
    unsupported_evidence: 145,
    unanswerable: 60,
  });
  assert.equal(
    queries.filter(
      (query) =>
        query.annotations.length &&
        query.annotations.every((annotation) => annotation.unanswerable),
    ).length,
    60,
  );
  const docs = await rows(cohort.docs_file);
  assert.equal(docs.length, 281);
  assert.equal(new Set(docs.map((doc) => doc.id)).size, docs.length);
  const byPaper = new Map();
  for (const doc of docs) {
    const bytes = await fs.readFile(doc.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), doc.sha256);
    byPaper.set(doc.id, { doc, text: bytes.toString('utf8') });
    files.push(doc.file);
  }
  files.push(cohort.query_file, cohort.docs_file);
  const summary = {};
  for (const [arm, spec] of Object.entries(specs)) {
    const outputPath = path.join(out, 'public', `qasper-${arm}-hybrid.jsonl`);
    const data = await rows(outputPath);
    files.push(outputPath);
    identityOrder(data, cohort.ids);
    let complete = 0,
      formulaChecks = 0;
    for (const [index, row] of data.entries()) {
      const query = queries[index];
      const { doc, text } = byPaper.get(query.paper_id);
      assert.equal(query.source_id, doc.source_id);
      assert.equal(row.condition, `${arm}-hybrid`);
      assert.equal(row.paper_id, query.paper_id);
      assert.equal(row.request.query, query.text.trim());
      assert.deepEqual(row.request.filters, { source_ids: [query.source_id] });
      assert.equal(row.request_chars, JSON.stringify(row.request).length);
      assert.equal(row.response_chars, JSON.stringify(row.result).length);
      assert.ok(row.request_chars + row.response_chars <= 20000);
      assert.equal(row.result.status, 'ok');
      const applied = row.result.applied;
      assert.deepEqual(applied, {
        lexical_engine: 'minisearch',
        topk: 10,
        max_chunks_per_source: 6,
        bm25_candidates: 60,
        dense_candidates: 60,
        title_weight: 2,
        dense_weight: spec.dense_weight,
        min_dense_similarity: 0.3,
        max_context_chars: row.request.overrides.max_context_chars,
        mode: 'hybrid',
        minisearch_k: 1.2,
        minisearch_b: 0.7,
        minisearch_d: 0.5,
        bm25_weight: spec.bm25_weight,
        rrf_k: spec.rrf_k,
      });
      assert.ok(row.response_chars <= applied.max_context_chars);
      assert.ok(row.request_chars + applied.max_context_chars <= 20000);
      assert.ok(row.result.results.length <= 6);
      assert.equal(
        new Set(row.result.results.map((piece) => piece.chunk_id)).size,
        row.result.results.length,
      );
      for (const piece of row.result.results) {
        assert.deepEqual(piece.matched_query_ids, ['q0']);
        assert.equal(piece.rankings.length, 1);
        assert.ok(
          piece.rankings[0].bm25_rank != null ||
            piece.rankings[0].dense_rank != null,
        );
        for (const rank of piece.rankings) {
          assert.equal(rank.query_id, 'q0');
          near(rank.rrf_score, rrf(rank, spec));
          formulaChecks++;
        }
      }
      const recomputed = scoreFromLines(query, doc, row.result, text);
      assert.equal(row.score.eligible, query.eligible);
      assert.equal(row.score.category, query.category);
      assert.deepEqual(row.score.selected_paragraphs, recomputed.selected);
      assert.equal(row.score.strict_complete, recomputed.complete);
      assert.equal(row.score.strict_coverage, recomputed.coverage);
      near(row.score.official_formula_evidence_f1, recomputed.f1);
      if (query.eligible && recomputed.complete) complete++;
    }
    const priorPath = path.join(
      refs[arm].root,
      'public',
      `qasper-${refs[arm].label}-hybrid.jsonl`,
    );
    const prior = await rows(priorPath);
    assert.equal(prior.length, 101);
    const byId = new Map(data.map((row) => [row.id, row]));
    for (const old of prior)
      for (const key of [
        'request',
        'result',
        'request_chars',
        'response_chars',
        'score',
      ]) {
        assert.deepEqual(
          byId.get(old.id)?.[key],
          old[key],
          `QASPER ${arm}/${old.id}/${key}`,
        );
      }
    files.push(priorPath);
    summary[arm] = {
      questions: data.length,
      strict_eligible: 800,
      complete,
      rrf_scores_checked: formulaChecks,
      exact_prior_samples: prior.length,
    };
  }
  return { documents_verified: docs.length, conditions: summary };
}

async function auditFreeze(freeze, receipt, executionRoot, files) {
  const frozenFiles = new Map();
  const databaseHashes = {};
  for (const [scope, cohort] of Object.entries(
    freeze.public.source_freeze.cohorts,
  )) {
    databaseHashes[scope] = cohort.database_sha256;
    frozenFiles.set(cohort.database, cohort.database_sha256);
    frozenFiles.set(cohort.query_file, cohort.query_file_sha256);
    if (cohort.corpus_file)
      frozenFiles.set(cohort.corpus_file, cohort.corpus_file_sha256);
    if (cohort.docs_file)
      frozenFiles.set(cohort.docs_file, cohort.docs_file_sha256);
    assert.equal(receipt.results[scope].questions, populations[scope]);
  }
  const vectors = freeze.public.vectors;
  frozenFiles.set(vectors.cache, vectors.cache_sha256);
  frozenFiles.set(vectors.plan_file, vectors.plan_sha256);
  frozenFiles.set(
    path.join(executionRoot, 'evals/run-public-full-cap6.mjs'),
    freeze.code.runner,
  );
  frozenFiles.set(
    path.join(executionRoot, 'evals/run-minisearch-parameter-exploration.mjs'),
    freeze.code.shared_core,
  );
  for (const [file, expected] of Object.entries(freeze.code.dist))
    frozenFiles.set(path.join(executionRoot, 'dist', file), expected);
  assert.equal(receipt.unchanged_inputs, true);
  assert.deepEqual(receipt.arms, Object.keys(specs));
  assert.deepEqual(receipt.scopes, Object.keys(populations));
  assert.equal(receipt.network, 'forbidden; frozen-cache-only provider');
  assert.deepEqual(receipt.before_database_sha256, databaseHashes);
  assert.deepEqual(receipt.after_database_sha256, databaseHashes);
  assert.equal(receipt.vector_cache_sha256, vectors.cache_sha256);
  const verified = {};
  for (const [file, expected] of frozenFiles) {
    assert.match(expected, /^[0-9a-f]{64}$/);
    const actual = await sha(file);
    assert.equal(
      actual,
      expected,
      'Frozen input or execution code changed: ' + file,
    );
    verified[path.resolve(file)] = actual;
    files.push(file);
  }
  return verified;
}

async function auditReferences(freeze, refs, files) {
  const verified = {};
  for (const reference of Object.values(refs)) {
    const priorFreezePath = path.join(reference.root, 'freeze.json');
    const priorReceiptPath = path.join(reference.root, 'run-receipt.json');
    const provenancePath = path.join(reference.root, 'provenance.json');
    const priorFreeze = await readJson(priorFreezePath);
    const priorReceipt = await readJson(priorReceiptPath);
    const provenance = await readJson(provenancePath);
    assert.equal(priorReceipt.status, 'complete');
    assert.equal(priorReceipt.new_embedding_calls, 0);
    assert.equal(
      priorReceipt.after_database_sha256['public:vectors.sqlite'],
      freeze.public.vectors.cache_sha256,
    );
    const priorHashes = new Map(
      provenance.artifacts.map((item) => [
        path.resolve(reference.root, item.file),
        item.sha256,
      ]),
    );
    for (const scope of Object.keys(populations)) {
      const prior = priorFreeze.public.scopes[scope];
      const current = freeze.public.source_freeze.cohorts[scope];
      assert.equal(prior.database_sha256, current.database_sha256);
      assert.equal(prior.query_file_sha256, current.query_file_sha256);
      assert.equal(
        prior.corpus_file_sha256 ?? prior.docs_file_sha256,
        current.corpus_file_sha256 ?? current.docs_file_sha256,
      );
      const file = path.resolve(
        reference.root,
        'public',
        scope + '-' + reference.label + '-hybrid.jsonl',
      );
      const expected = priorHashes.get(file);
      assert.ok(expected, 'Reference artifact is not bound: ' + file);
      const actual = await sha(file);
      assert.equal(actual, expected, 'Reference output changed: ' + file);
      verified[file] = actual;
      files.push(file);
    }
    files.push(priorFreezePath, priorReceiptPath, provenancePath);
  }
  return verified;
}

async function main() {
  const [publicArg, outArg, referenceA, referenceB, executionArg] =
    process.argv.slice(2);
  assert.ok(
    publicArg && outArg && referenceA && referenceB,
    'Usage: node evals/audit-public-full-cap6.mjs PUBLIC_ROOT OUT REFERENCE_A REFERENCE_B [EXECUTION_ROOT]',
  );
  const publicRoot = path.resolve(publicArg),
    out = path.resolve(outArg);
  const freezePath = path.join(out, 'freeze.json'),
    receiptPath = path.join(out, 'run-receipt.json');
  const freeze = await readJson(freezePath),
    receipt = await readJson(receiptPath);
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.new_embedding_calls, 0);
  assert.equal(receipt.questions, 3307);
  assert.equal(receipt.executions, 6614);
  assert.equal(path.resolve(freeze.public.root), publicRoot);
  assert.deepEqual(Object.keys(freeze.arms), Object.keys(specs));
  const files = [fileURLToPath(import.meta.url), freezePath, receiptPath];
  const executionRoot = path.resolve(
    executionArg ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  );
  const frozenHashes = await auditFreeze(freeze, receipt, executionRoot, files);
  const refs = {
    'public-A': { root: path.resolve(referenceA), label: 'default20-cap6' },
    'public-B': { root: path.resolve(referenceB), label: 'recall20-cap6' },
  };
  for (const [scope, count] of Object.entries(populations)) {
    assert.equal(freeze.public.source_freeze.cohorts[scope].ids.length, count);
  }
  for (const [arm, spec] of Object.entries(specs)) {
    for (const [key, value] of Object.entries(spec))
      assert.equal(freeze.arms[arm][key], value);
    assert.deepEqual(freeze.arms[arm].retrieval, {
      max_chunks_per_source: 6,
      max_context_chars: 20000,
    });
  }
  const referenceHashes = await auditReferences(freeze, refs, files);
  const fixed = {};
  for (const scope of ['langchain', 'godot', 'du'])
    fixed[scope] = await auditFixed(
      scope,
      publicRoot,
      out,
      freeze,
      refs,
      files,
    );
  const qasper = await auditQasper(publicRoot, out, freeze, refs, files);
  const hashes = { ...frozenHashes, ...referenceHashes };
  for (const file of new Set(files)) {
    const absolute = path.resolve(file);
    if (!(absolute in hashes)) hashes[absolute] = await sha(file);
  }
  const audit = {
    status: 'complete',
    created_at: new Date().toISOString(),
    public_questions: 3307,
    primary_executions: 6614,
    frozen_files_verified: Object.keys(frozenHashes).length,
    execution_root: executionRoot,
    reference_artifacts_verified: Object.keys(referenceHashes).length,
    fixed,
    qasper,
    files: hashes,
    note: 'Read-only validation of actual two-arm outputs, source ranges, UTF-16 budget and old sample equivalence; no new retrieval or model calls.',
  };
  await fs.writeFile(
    path.join(out, 'independent-audit.json'),
    JSON.stringify(audit, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify({ status: audit.status, fixed, qasper }));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();

export { auditFixed, rows, rrf, scoreFromLines };
