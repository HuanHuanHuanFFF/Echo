import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [rootArg, oldArg, outputName = 'comparison.json'] = process.argv.slice(2);
assert.match(outputName, /^[a-z0-9-]+\.json$/);
assert.ok(
  rootArg && oldArg,
  'Usage: node evals/audit-default-budget20-cap.mjs NEW_OUT OLD_DEFAULT_OUT',
);
const root = path.resolve(rootArg);
const old = path.resolve(oldArg);
const bindings = {};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function read(file, base = root) {
  const bytes = await fs.readFile(path.join(base, file));
  bindings[(base === root ? 'current/' : 'previous/') + file] = sha(bytes);
  return JSON.parse(bytes.toString('utf8'));
}
async function rows(file, base = root) {
  const bytes = await fs.readFile(path.join(base, file));
  bindings[(base === root ? 'current/' : 'previous/') + file] = sha(bytes);
  return bytes.toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
}
const freeze = await read('freeze.json');
const receipt = await read('run-receipt.json');
const privateScore = await read('private-score.json');
const publicScore = await read('public-score.json');
const oldFreeze = await read('freeze.json', old);
for (const side of ['private', 'public'])
  for (const [scope, value] of Object.entries(freeze[side].scopes))
    for (const field of [
      'question_ids',
      'database_sha256',
      'dataset_sha256',
      'query_file_sha256',
      'corpus_file_sha256',
      'docs_file_sha256',
      'input_sha256',
    ]) {
      if (side === 'public' && scope === 'qasper' && field === 'input_sha256')
        continue;
      assert.deepEqual(
        value[field],
        oldFreeze[side].scopes[scope][field],
        side + ':' + scope + ':' + field,
      );
    }
const qasper = freeze.public.scopes.qasper;
const qBytes = await fs.readFile(qasper.query_file);
assert.equal(sha(qBytes), qasper.query_file_sha256);
const qMap = new Map(
  qBytes
    .toString('utf8')
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse)
    .map((r) => [r.id, r]),
);
const raw = qasper.question_ids.map((id) => ({ id, text: qMap.get(id).text }));
const normalized = raw.map((r) => ({ ...r, text: r.text.trim() }));
assert.equal(
  sha(JSON.stringify(raw)),
  oldFreeze.public.scopes.qasper.input_sha256,
);
assert.equal(sha(JSON.stringify(normalized)), qasper.input_sha256);
const identity = {
  status: 'passed',
  same_question_ids_files_databases: true,
  original_qasper_freeze_hash_was_untrimmed: true,
  trim_affected_questions: raw.filter((r, i) => r.text !== normalized[i].text)
    .length,
};
const priorReceipt = await read('run-receipt.json', old);
assert.ok(priorReceipt.execution_correction);
identity.prior_correction = priorReceipt.execution_correction;
if (
  await fs.stat(path.join(root, 'input-identity-check.json')).catch(() => null)
)
  await read('input-identity-check.json');
for (const [name, expected] of Object.entries(freeze.code.dist)) {
  assert.equal(
    sha(await fs.readFile(new URL('../dist/' + name, import.meta.url))),
    expected,
    'current dist: ' + name,
  );
}
assert.equal(
  sha(
    await fs.readFile(
      new URL('./run-minisearch-parameter-exploration.mjs', import.meta.url),
    ),
  ),
  freeze.code.script,
);
assert.equal(receipt.status, 'complete');
assert.equal(receipt.unchanged_inputs, true);
assert.equal(receipt.new_embedding_calls, 0);
assert.deepEqual(receipt.before_database_sha256, receipt.after_database_sha256);
const ids = ['default20-cap3', 'default20-cap6'];
assert.deepEqual(Object.keys(freeze.arms), ids);
const primary = Object.keys(privateScore.primary);
assert.deepEqual(primary, [
  'A-test',
  'B-test',
  'C-test',
  'D-test',
  'mixed-test',
]);
const result = {
  status: 'passed',
  parameters: freeze.arms,
  private: {},
  public: publicScore.results,
  qasper: publicScore.qasper.conditions,
  comparisons: {},
  validation: { unchanged_inputs: true, new_embedding_calls: 0, identity },
  bindings,
};
const allHybrid = {};
function complete(row) {
  return (
    row.expected_facts.length > 0 &&
    row.expected_facts.every((id) => row.covered_facts.includes(id))
  );
}
function paired(before, after) {
  const oldRows = new Map(before.map((row) => [row.query_id, row]));
  const counts = { wins: 0, losses: 0, ties: 0 };
  for (const row of after.filter((r) => !r.no_answer)) {
    const prior = oldRows.get(row.query_id);
    assert.ok(prior);
    assert.deepEqual(row.expected_facts, prior.expected_facts);
    const a = complete(prior),
      b = complete(row);
    counts[a === b ? 'ties' : b ? 'wins' : 'losses']++;
  }
  return counts;
}
for (const [index, id] of ids.entries()) {
  const arm = freeze.arms[id],
    cap = index ? 6 : 3;
  assert.deepEqual(
    [
      arm.bm25_weight,
      arm.dense_weight,
      arm.rrf_k,
      arm.minisearch_k,
      arm.minisearch_b,
      arm.minisearch_d,
    ],
    [0.5, 1, 10, 1.2, 0.7, 0.5],
  );
  assert.deepEqual(arm.retrieval, {
    max_chunks_per_source: cap,
    max_context_chars: 20000,
  });
  for (const mode of ['hybrid', 'bm25']) {
    const label = id + '-' + mode;
    const all = [];
    for (const scope of [...primary, 'paired-test']) {
      const data = await rows('private/' + scope + '/' + label + '.jsonl');
      assert.deepEqual(
        data.map((r) => r.query_id),
        freeze.private.scopes[scope].question_ids,
      );
      for (const row of data) {
        const applied = row.result.applied;
        assert.equal(applied.max_chunks_per_source, cap);
        assert.equal(
          applied.max_context_chars,
          row.request.overrides.max_context_chars,
        );
        assert.equal(applied.mode, mode);
        assert.equal(applied.lexical_engine, 'minisearch');
        assert.equal(applied.rrf_k, 10);
        assert.equal(row.response_chars, JSON.stringify(row.result).length);
        assert.equal(row.request_chars, JSON.stringify(row.request).length);
        assert.equal(row.context_chars, row.response_chars + row.request_chars);
        assert.ok(row.context_chars <= 20000);
        assert.equal(row.returned_chunks, row.result.results.length);
        assert.ok(row.returned_chunks <= 10);
        const sources = new Map();
        for (const piece of row.result.results)
          sources.set(piece.source_id, (sources.get(piece.source_id) ?? 0) + 1);
        assert.ok([...sources.values()].every((n) => n <= cap));
      }
      if (scope !== 'paired-test') all.push(...data);
    }
    assert.equal(all.length, 200);
    assert.equal(all.filter((r) => !r.no_answer).length, 196);
    assert.equal(new Set(all.map((r) => r.query_id)).size, 200);
    const metrics = privateScore.primary_overall[label];
    assert.equal(
      metrics.byK[10].complete,
      all.filter(complete).length + '/196',
    );
    const avg = (key) => all.reduce((n, r) => n + r[key], 0) / all.length;
    result.private[label] = {
      metrics,
      scopes: Object.fromEntries(
        primary.map((scope) => [
          scope,
          privateScore.primary[scope][label].byK[10],
        ]),
      ),
      paired40: privateScore.paired['paired-test'][label].byK[10],
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
result.comparisons.cap6_vs_cap3_complete = paired(
  allHybrid[ids[0]],
  allHybrid[ids[1]],
);
const previous = (
  await Promise.all(
    primary.map((scope) =>
      rows('private/' + scope + '/default-hybrid.jsonl', old),
    ),
  )
).flat();
result.comparisons.cap3_20k_vs_previous_16k_complete = paired(
  previous,
  allHybrid[ids[0]],
);
const publicEquality = {};
for (const scope of ['langchain', 'godot', 'du']) {
  const expected = freeze.public.scopes[scope].question_ids;
  for (const mode of ['hybrid', 'bm25']) {
    const current = await Promise.all(
      ids.map((id) =>
        rows('public/' + scope + '-' + id + '-' + mode + '.jsonl'),
      ),
    );
    const previousRows = await rows(
      'public/' + scope + '-default-' + mode + '.jsonl',
      old,
    );
    for (const data of [...current, previousRows])
      assert.deepEqual(
        data.map((r) => r.id),
        expected,
      );
    for (let i = 0; i < expected.length; i++) {
      assert.deepEqual(current[0][i].rankings, current[1][i].rankings);
      assert.deepEqual(current[0][i].rankings, previousRows[i].rankings);
    }
  }
  publicEquality[scope] = {
    queries: expected.length,
    current_arms_and_previous_rankings_equal: true,
  };
}
result.validation.public_rankings = publicEquality;
for (const id of ids) await rows('public/qasper-' + id + '-hybrid.jsonl');
result.validation.runtime_hashes = freeze.code.dist;
const scriptBytes = await fs.readFile(new URL(import.meta.url));
result.validation.audit_script_sha256 = sha(scriptBytes);
await fs.writeFile(
  path.join(root, outputName),
  JSON.stringify(result, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    status: result.status,
    comparison: result.comparisons,
    public_rankings: publicEquality,
  }),
);
