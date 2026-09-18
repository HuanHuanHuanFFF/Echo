// Read-only stability audit; never retries retrieval or calls a model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const get = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const evidence = (row) =>
  row.result.results.map(({ rankings, ...piece }) => piece);
const [root] = process.argv.slice(2);
assert.ok(
  root && process.argv.length === 3,
  'Usage: node evals/audit-decomposition-results.mjs <run-root>',
);
const plan = await get(path.join(root, 'plan.json'));
const summary = await get(path.join(root, 'summary.public.json'));
assert.equal(
  hash(await fs.readFile(path.join(root, 'plan.json'))),
  summary.plan_sha256,
);
for (const item of summary.artifact_hashes)
  assert.equal(
    hash(await fs.readFile(path.join(root, item.file))),
    item.sha256,
  );
const rows = async (dir, name) =>
  (await fs.readFile(path.join(dir, 'queries', name, 'rows.jsonl'), 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
const fields = {};
function differences(a, b, key) {
  if (equal(a, b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)]))
      differences(
        a[field],
        b[field],
        key + '.' + (/^\d+$/.test(field) ? '*' : field),
      );
    return;
  }
  const found = (fields[key] ??= {
    count: 0,
    types: [],
    max_absolute_difference: null,
  });
  found.count++;
  const type = typeof a + '/' + typeof b;
  if (!found.types.includes(type)) found.types.push(type);
  if (typeof a === 'number' && typeof b === 'number')
    found.max_absolute_difference = Math.max(
      found.max_absolute_difference ?? 0,
      Math.abs(a - b),
    );
}
const baseline = path.join(path.dirname(root), plan.baseline);
assert.equal(
  hash(
    await fs.readFile(
      path.join(baseline, 'comparisons/delivery-manifest-r2.public.json'),
    ),
  ),
  plan.baseline_manifest_sha256,
);
const baselineDelivery = await get(
  path.join(baseline, 'comparisons/delivery-manifest-r2.public.json'),
);
const controls = [],
  repeat = [],
  costs = { split: {}, parent: {} };
for (const scope of Object.keys(plan.changedIds)) {
  const split = await rows(root, scope + '-split'),
    parent = await rows(root, scope + '-parent');
  const original = await rows(baseline, scope + '-2');
  const oldRowsPath = 'queries/' + scope + '-2/rows.jsonl';
  assert.equal(
    hash(await fs.readFile(path.join(baseline, oldRowsPath))),
    baselineDelivery.artifact_hashes.find((x) => x.file === oldRowsPath).sha256,
  );
  assert.deepEqual(
    split.map((r) => r.query_id),
    parent.map((r) => r.query_id),
  );
  assert.deepEqual(
    split.map((r) => r.query_id),
    original.map((r) => r.query_id),
  );
  for (const [arm, entries] of [
    ['split', split],
    ['parent', parent],
  ]) {
    const report = await get(
      path.join(root, 'queries', scope + '-' + arm, 'report.json'),
    );
    const changed = entries.filter((r) =>
      plan.changedIds[scope].includes(r.query_id),
    );
    const unchanged = entries.filter(
      (r) => !plan.changedIds[scope].includes(r.query_id),
    );
    costs[arm][scope] = {
      api_usage: report.api_usage,
      all_context_chars: entries.reduce((n, r) => n + r.context_chars, 0),
      changed_context_chars: changed.reduce((n, r) => n + r.context_chars, 0),
      unchanged_context_chars: unchanged.reduce(
        (n, r) => n + r.context_chars,
        0,
      ),
      changed_requests: changed.reduce((n, r) => n + r.api_requests, 0),
      unchanged_requests: unchanged.reduce((n, r) => n + r.api_requests, 0),
      no_answer_nonempty: entries.filter(
        (r) => r.no_answer && r.result.results.length > 0,
      ).length,
    };
  }
  for (let i = 0; i < split.length; i++) {
    const a = split[i],
      b = parent[i],
      old = original[i];
    repeat.push({
      scope,
      id: a.query_id,
      request: equal(a.request, old.request),
      evidence: equal(evidence(a), evidence(old)),
      facts: equal([...a.covered_facts].sort(), [...old.covered_facts].sort()),
    });
    if (plan.changedIds[scope].includes(a.query_id)) continue;
    assert.deepEqual(a.request, b.request);
    controls.push({
      scope,
      id: a.query_id,
      evidence_identical: equal(evidence(a), evidence(b)),
      facts_identical: equal(
        [...a.covered_facts].sort(),
        [...b.covered_facts].sort(),
      ),
      full_result_identical: equal(a.result, b.result),
      context_identical: a.context_chars === b.context_chars,
      parent_minus_split_context: b.context_chars - a.context_chars,
    });
    differences(a.result, b.result, 'result');
  }
}
const changed = summary.changedQuestions;
const result = {
  status: 'complete',
  script_sha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
  plan_sha256: summary.plan_sha256,
  summary_sha256: hash(
    await fs.readFile(path.join(root, 'summary.public.json')),
  ),
  source_artifacts_verified: summary.artifact_hashes.length,
  controls: {
    total: controls.length,
    identical_evidence: controls.filter((r) => r.evidence_identical).length,
    identical_fact_sets: controls.filter((r) => r.facts_identical).length,
    identical_full_results: controls.filter((r) => r.full_result_identical)
      .length,
    identical_context: controls.filter((r) => r.context_identical).length,
    changed_numeric_fields: fields,
    rows: controls,
  },
  split_repeat: {
    total: repeat.length,
    identical_request: repeat.filter((r) => r.request).length,
    identical_evidence: repeat.filter((r) => r.evidence).length,
    identical_facts: repeat.filter((r) => r.facts).length,
    changed_evidence_ids: repeat
      .filter((r) => !r.evidence)
      .map((r) => ({ scope: r.scope, id: r.id })),
  },
  parent_relative_to_split: {
    complete_gains: changed
      .filter((r) => r.parent_complete && !r.split_complete)
      .map((r) => r.id),
    complete_losses: changed
      .filter((r) => !r.parent_complete && r.split_complete)
      .map((r) => r.id),
    fact_set_gains: changed.filter((r) => r.gained.length).map((r) => r.id),
    fact_set_losses: changed.filter((r) => r.lost.length).map((r) => r.id),
    facts_gained: changed.reduce((n, r) => n + r.gained.length, 0),
    facts_lost: changed.reduce((n, r) => n + r.lost.length, 0),
  },
  costs,
  interpretation:
    'Ordered delivered evidence excludes only rankings; full JSON differences remain recorded. Stable controls constrain observed outcome drift, not a guarantee that remote embeddings are bit-identical.',
};
await fs.writeFile(
  path.join(root, 'stability.public.json'),
  JSON.stringify(result, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify(
    {
      controls: { ...result.controls, rows: undefined },
      repeat: result.split_repeat,
      changes: result.parent_relative_to_split,
      costs,
    },
    null,
    2,
  ),
);
