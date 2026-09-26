import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [outArg, baseArg, highArg] = process.argv.slice(2);
assert.ok(
  outArg && baseArg && highArg,
  'Usage: node evals/audit-budget20-followup.mjs OUT BASE20 HIGH16',
);
const out = path.resolve(outArg),
  base = path.resolve(baseArg),
  high = path.resolve(highArg);
const bindings = {};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const side = (root) =>
  root === out ? 'current' : root === base ? 'base20' : 'high16';
async function bytes(root, file) {
  const data = await fs.readFile(path.join(root, file));
  bindings[side(root) + '/' + file] = sha(data);
  return data;
}
const read = async (root, file) =>
  JSON.parse((await bytes(root, file)).toString('utf8'));
const rows = async (root, file) =>
  (await bytes(root, file))
    .toString('utf8')
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
const freeze = await read(out, 'freeze.json'),
  receipt = await read(out, 'run-receipt.json');
assert.equal(receipt.status, 'complete');
assert.equal(receipt.new_embedding_calls, 0);
assert.equal(receipt.unchanged_inputs, true);
assert.deepEqual(receipt.before_database_sha256, receipt.after_database_sha256);
const inputAfter = {};
for (const reference of [base, high]) {
  const previous = await read(reference, 'freeze.json');
  for (const kind of ['private', 'public'])
    for (const [scope, current] of Object.entries(freeze[kind].scopes)) {
      for (const key of [
        'question_ids',
        'input_sha256',
        'database_sha256',
        'dataset_sha256',
        'query_file_sha256',
        'corpus_file_sha256',
        'docs_file_sha256',
      ])
        assert.deepEqual(
          current[key],
          previous[kind].scopes[scope][key],
          kind + ':' + scope + ':' + key,
        );
      for (const [key, hashKey] of [
        ['dataset', 'dataset_sha256'],
        ['query_file', 'query_file_sha256'],
        ['corpus_file', 'corpus_file_sha256'],
        ['docs_file', 'docs_file_sha256'],
      ]) {
        if (!current[key]) continue;
        const digest = sha(await fs.readFile(current[key]));
        assert.equal(digest, current[hashKey]);
        inputAfter[kind + ':' + scope + ':' + key] = digest;
      }
    }
}
for (const [name, expected] of Object.entries(freeze.code.dist))
  assert.equal(
    sha(await fs.readFile(new URL('../dist/' + name, import.meta.url))),
    expected,
  );
assert.equal(
  sha(
    await fs.readFile(
      new URL('./run-minisearch-parameter-exploration.mjs', import.meta.url),
    ),
  ),
  freeze.code.script,
);
const expected = {
  'default20-cap5': {
    bm25_weight: 0.5,
    dense_weight: 1,
    rrf_k: 10,
    max_chunks_per_source: 5,
  },
  'recall20-cap6': {
    bm25_weight: 0.31,
    dense_weight: 0.8,
    rrf_k: 5,
    max_chunks_per_source: 6,
  },
};
assert.deepEqual(Object.keys(freeze.arms), Object.keys(expected));
const primary = ['A-test', 'B-test', 'C-test', 'D-test', 'mixed-test'];
const result = {
  status: 'passed',
  parameters: freeze.arms,
  private: {},
  references: {},
  comparisons: {},
  validation: {
    inputs_after_match_freeze: inputAfter,
    new_embedding_calls: 0,
    unchanged_indexes_and_vectors: true,
  },
  bindings,
};
const score = await read(out, 'private-score.json');
const publicScore = await read(out, 'public-score.json');
result.public = publicScore.results;
result.qasper = publicScore.qasper.conditions;
const complete = (r) =>
  !r.no_answer &&
  r.expected_facts.length > 0 &&
  r.expected_facts.every((f) => r.covered_facts.includes(f));
function verifyScore(row, arm, mode) {
  const lexical = row.bm25_rank
    ? (mode === 'bm25' ? 1 : arm.bm25_weight) / (arm.rrf_k + row.bm25_rank)
    : 0;
  const dense = row.dense_rank
    ? arm.dense_weight / (arm.rrf_k + row.dense_rank)
    : 0;
  assert.ok(
    Math.abs(row.rrf_score - lexical - dense) < 1e-12,
    'RRF score does not match effective arm',
  );
}
const allHybrid = {};
async function collect(root, label) {
  return (
    await Promise.all(
      primary.map((s) => rows(root, 'private/' + s + '/' + label + '.jsonl')),
    )
  ).flat();
}
function compare(a, b) {
  assert.equal(a.length, 200);
  assert.equal(b.length, 200);
  const index = new Map(a.map((r) => [r.query_id, r]));
  const pair = { wins: 0, losses: 0, ties: 0, facts_gained: 0, facts_lost: 0 };
  for (const r of b) {
    const old = index.get(r.query_id);
    assert.ok(old);
    assert.deepEqual(r.expected_facts, old.expected_facts);
    if (r.no_answer) continue;
    const was = complete(old),
      now = complete(r);
    pair[was === now ? 'ties' : now ? 'wins' : 'losses']++;
    pair.facts_gained += r.covered_facts.filter(
      (f) => !old.covered_facts.includes(f),
    ).length;
    pair.facts_lost += old.covered_facts.filter(
      (f) => !r.covered_facts.includes(f),
    ).length;
  }
  return pair;
}
for (const [id, exp] of Object.entries(expected)) {
  const arm = freeze.arms[id];
  for (const field of ['bm25_weight', 'dense_weight', 'rrf_k'])
    assert.equal(arm[field], exp[field]);
  assert.deepEqual(arm.retrieval, {
    max_chunks_per_source: exp.max_chunks_per_source,
    max_context_chars: 20000,
  });
  for (const mode of ['hybrid', 'bm25']) {
    const label = id + '-' + mode,
      all = [];
    for (const scope of [...primary, 'paired-test']) {
      const data = await rows(out, 'private/' + scope + '/' + label + '.jsonl');
      assert.deepEqual(
        data.map((r) => r.query_id),
        freeze.private.scopes[scope].question_ids,
      );
      for (const r of data) {
        const opts = r.result.applied;
        for (const evidence of r.result.results)
          for (const ranking of evidence.rankings)
            verifyScore(ranking, arm, mode);
        for (const [k, v] of Object.entries({
          ...exp,
          mode,
          lexical_engine: 'minisearch',
          topk: 10,
          bm25_candidates: 60,
          dense_candidates: 60,
          title_weight: 2,
          min_dense_similarity: 0.3,
          minisearch_k: 1.2,
          minisearch_b: 0.7,
          minisearch_d: 0.5,
        }))
          assert.equal(opts[k], v, k);
        assert.equal(r.request_chars, JSON.stringify(r.request).length);
        assert.equal(r.response_chars, JSON.stringify(r.result).length);
        assert.equal(r.context_chars, r.request_chars + r.response_chars);
        assert.equal(
          opts.max_context_chars,
          r.request.overrides.max_context_chars,
        );
        assert.ok(r.context_chars <= 20000);
        assert.ok(r.result.results.length <= 10);
        assert.equal(r.returned_chunks, r.result.results.length);
        const counts = new Map();
        for (const piece of r.result.results)
          counts.set(piece.source_id, (counts.get(piece.source_id) ?? 0) + 1);
        assert.ok(
          [...counts.values()].every((n) => n <= exp.max_chunks_per_source),
        );
      }
      if (scope !== 'paired-test') all.push(...data);
    }
    assert.equal(all.length, 200);
    assert.equal(all.filter((r) => !r.no_answer).length, 196);
    assert.equal(new Set(all.map((r) => r.query_id)).size, 200);
    const metrics = score.primary_overall[label];
    assert.equal(
      metrics.byK[10].complete,
      all.filter(complete).length + '/196',
    );
    assert.equal(
      metrics.byK[10].fact_recall_micro,
      all.reduce((n, r) => n + r.covered_facts.length, 0) + '/403',
    );
    const avg = (k) => all.reduce((n, r) => n + r[k], 0) / all.length;
    result.private[label] = {
      metrics,
      scopes: Object.fromEntries(
        primary.map((s) => [s, score.primary[s][label].byK[10]]),
      ),
      paired40: score.paired['paired-test'][label].byK[10],
      mean_context_chars: avg('context_chars'),
      mean_returned_chunks: avg('returned_chunks'),
      mean_sources: avg('distinct_sources'),
      budget_exclusion_questions: all.filter((r) => r.excluded.budget > 0)
        .length,
      no_answer_nonempty: all.filter(
        (r) => r.no_answer && r.returned_chunks > 0,
      ).length,
    };
    if (mode === 'hybrid') allHybrid[id] = all;
  }
}
const base3 = await collect(base, 'default20-cap3-hybrid'),
  base6 = await collect(base, 'default20-cap6-hybrid'),
  high16 = await collect(high, 'bm25w031-cap6-rrf05-dw08-hybrid');
result.comparisons.cap5_vs_cap3 = compare(base3, allHybrid['default20-cap5']);
result.comparisons.cap6_vs_cap5 = compare(allHybrid['default20-cap5'], base6);
result.comparisons.recall20_vs_default20cap6 = compare(
  base6,
  allHybrid['recall20-cap6'],
);
result.comparisons.recall20_vs_same_params16k = compare(
  high16,
  allHybrid['recall20-cap6'],
);
for (const [name, root, labels] of [
  ['base20', base, ['default20-cap3-hybrid', 'default20-cap6-hybrid']],
  ['high16', high, ['bm25w031-cap6-rrf05-dw08-hybrid']],
]) {
  const ps = await read(root, 'private-score.json'),
    pub = await read(root, 'public-score.json');
  result.references[name] = {
    private: Object.fromEntries(labels.map((l) => [l, ps.primary_overall[l]])),
    public: pub.results,
    qasper: pub.qasper.conditions,
  };
}
const rankEquality = {};
for (const scope of ['langchain', 'godot', 'du'])
  for (const [id, reference, label] of [
    ['default20-cap5', base, 'default20-cap3'],
    ['recall20-cap6', high, 'bm25w031-cap6-rrf05-dw08'],
  ]) {
    for (const mode of ['hybrid', 'bm25']) {
      const a = await rows(
          out,
          'public/' + scope + '-' + id + '-' + mode + '.jsonl',
        ),
        b = await rows(
          reference,
          'public/' + scope + '-' + label + '-' + mode + '.jsonl',
        );
      for (const data of [a, b])
        assert.deepEqual(
          data.map((r) => r.id),
          freeze.public.scopes[scope].question_ids,
        );
      for (const row of a)
        for (const ranking of row.rankings)
          verifyScore(ranking, freeze.arms[id], mode);
      for (let i = 0; i < a.length; i++)
        assert.deepEqual(a[i].rankings, b[i].rankings);
    }
    rankEquality[scope + ':' + id] = {
      questions: freeze.public.scopes[scope].sample,
      rankings_equal_matching_reference: true,
    };
  }
result.validation.public_rankings = rankEquality;
result.validation.audit_script_sha256 = sha(
  await fs.readFile(new URL(import.meta.url)),
);
await fs.writeFile(
  path.join(out, 'comparison.json'),
  JSON.stringify(result, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({ status: result.status, comparisons: result.comparisons }),
);
