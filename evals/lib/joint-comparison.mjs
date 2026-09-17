import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { score, summarize } from './evidence-metrics.mjs';
const hash = (x) => createHash('sha256').update(x).digest('hex');
const get = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const digest = async (p) => hash(await fs.readFile(p));
const scopes = [
  'A-development',
  'B-development',
  'C-development',
  'mixed-development',
];
const expectedDelivery =
  'de55af401f736ac892677ad2e75b4b7800521e08286a66cdebe950b307ab5558';
export async function jointReferences(lab) {
  const file = path.join(
    lab,
    'evidence/four-parameter-comparisons-2026-09-17-v1/delivery.public.json',
  );
  assert.equal(await digest(file), expectedDelivery);
  const study = await get(file);
  const settings = [
    {
      id: 'baseline',
      experiment: 'rrf-k',
      value: 60,
      rrf_k: 60,
      budget: 12000,
    },
    {
      id: 'rrf_only',
      experiment: 'rrf-k',
      value: 30,
      rrf_k: 30,
      budget: 12000,
    },
    {
      id: 'budget_only',
      experiment: 'context-budget',
      value: 16000,
      rrf_k: 60,
      budget: 16000,
    },
  ];
  for (const c of settings) {
    const e = study.experiments.find((e) => e.experiment === c.experiment);
    assert.ok(e);
    c.run = e.run;
    c.files = e.artifact_hashes.filter((f) =>
      scopes.some((s) =>
        f.file.startsWith('queries/' + s + '-' + c.value + '/'),
      ),
    );
    c.files.push(
      ...e.additional_artifact_hashes.filter(
        (f) => f.file === 'queries/vector-uses.jsonl',
      ),
    );
    assert.equal(c.files.length, 17);
    for (const f of c.files)
      assert.equal(
        await digest(path.join(lab, 'evidence', c.run, f.file)),
        f.sha256,
      );
  }
  return { delivery_sha256: expectedDelivery, conditions: settings };
}
async function rows(root, name) {
  return (
    await fs.readFile(path.join(root, 'queries', name, 'rows.jsonl'), 'utf8')
  )
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
}
const queryPart = (r) => {
  const { overrides, ...q } = r.request;
  assert.deepEqual(Object.keys(overrides), ['max_context_chars']);
  return q;
};
const indexPart = (m) => {
  assert.equal(m.index.revision, m.revision);
  const { revision, ...rest } = m.index;
  return rest;
};
export async function compareJoint(lab, root, plan) {
  const refs = await jointReferences(lab);
  assert.deepEqual(refs, plan.comparison_references);
  const newSummary = await get(path.join(root, 'summary.public.json'));
  assert.equal(newSummary.parent_executions, 100);
  const uses = async (dir) =>
    (await fs.readFile(path.join(dir, 'queries/vector-uses.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse);
  const currentUses = await uses(root);
  const conditions = [
    ...refs.conditions,
    {
      id: 'joint',
      run: path.basename(root),
      value: 'joint',
      rrf_k: 30,
      budget: 16000,
    },
  ];
  const collected = new Map(),
    comparison = [];
  for (const c of conditions) {
    const folder = path.join(lab, 'evidence', c.run),
      all = [],
      byScope = {},
      costs = [];
    const log = c.id === 'joint' ? currentUses : await uses(folder);
    for (const scope of scopes) {
      const name = scope + '-' + c.value,
        dir = path.join(folder, 'queries', name);
      const data = await get(path.join(dir, 'dataset.json')),
        manifest = await get(path.join(dir, 'manifest.json'));
      const current = await get(
        path.join(root, 'queries', scope + '-joint', 'manifest.json'),
      );
      assert.equal(
        await digest(path.join(dir, 'dataset.json')),
        current.dataset.sha256,
      );
      for (const field of ['corpus', 'runtime', 'embedding', 'selection'])
        assert.deepEqual(manifest[field], current[field]);
      assert.deepEqual(indexPart(manifest), indexPart(current));
      assert.equal(manifest.retrieval.rrf_k, c.rrf_k);
      assert.equal(manifest.retrieval.max_context_chars, c.budget);
      assert.equal(manifest.budget_chars, c.budget);
      assert.deepEqual(
        { ...manifest.retrieval, rrf_k: 30, max_context_chars: 16000 },
        current.retrieval,
      );
      const keyset = (entries, id) =>
        entries
          .filter((u) => u.run === id)
          .map((u) => u.request_sha256 + ':' + u.vector_sha256)
          .sort();
      assert.deepEqual(
        keyset(log, name),
        keyset(currentUses, scope + '-joint'),
      );
      const rs = await rows(folder, name),
        newRows = await rows(root, scope + '-joint');
      assert.deepEqual(
        rs.map((r) => r.query_id),
        newRows.map((r) => r.query_id),
      );
      assert.deepEqual(rs.map(queryPart), newRows.map(queryPart));
      assert.deepEqual(rs, (await get(path.join(dir, 'report.json'))).rows);
      const metrics = rs.map((r, i) => {
        assert.equal(r.status, 'ok');
        assert.equal(r.request_chars, JSON.stringify(r.request).length);
        assert.equal(r.response_chars, JSON.stringify(r.result).length);
        assert.equal(r.context_chars, r.request_chars + r.response_chars);
        assert.ok(r.context_chars <= c.budget);
        assert.ok(
          r.request_chars + r.request.overrides.max_context_chars <= c.budget,
        );
        assert.ok(r.result.results.length <= 10);
        const counts = new Map();
        for (const p of r.result.results)
          counts.set(p.source_id, (counts.get(p.source_id) ?? 0) + 1);
        assert.ok([...counts.values()].every((n) => n <= 3));
        const m = score(data.questions[i], data.facts, r.result.results);
        if (!m.noAnswer)
          assert.deepEqual(
            [...m.fullCovered].sort(),
            [...r.covered_facts].sort(),
          );
        return m;
      });
      byScope[scope] = summarize(metrics);
      all.push(...metrics);
      collected.set(c.id + ':' + scope, rs);
      costs.push(...rs);
    }
    comparison.push({
      id: c.id,
      run: c.run,
      rrf_k: c.rrf_k,
      budget: c.budget,
      execution: c.id === 'joint' ? 'new' : 'reused',
      all: summarize(all),
      byScope,
      context_chars: costs.reduce((n, r) => n + r.context_chars, 0),
      result_chunks: costs.reduce((n, r) => n + r.result.results.length, 0),
      queries_with_budget_exclusion: costs.filter(
        (r) => r.result.excluded.budget > 0,
      ).length,
      queries_under_topk: costs.filter((r) => r.result.results.length < 10)
        .length,
    });
  }
  const changes = {};
  for (const c of refs.conditions) {
    changes[c.id] = [];
    for (const scope of scopes) {
      const old = collected.get(c.id + ':' + scope),
        joint = collected.get('joint:' + scope);
      old.forEach((a, i) => {
        const b = joint[i],
          gained = b.covered_facts.filter((f) => !a.covered_facts.includes(f)),
          lost = a.covered_facts.filter((f) => !b.covered_facts.includes(f));
        if (gained.length || lost.length)
          changes[c.id].push({
            scope,
            id: a.query_id,
            expected: a.expected_facts.length,
            reference_facts: a.covered_facts.length,
            joint_facts: b.covered_facts.length,
            gained,
            lost,
            reference_complete:
              !a.no_answer &&
              a.covered_facts.length === a.expected_facts.length,
            joint_complete:
              !b.no_answer &&
              b.covered_facts.length === b.expected_facts.length,
          });
      });
    }
  }
  assert.deepEqual(
    comparison.find((c) => c.id === 'joint').all,
    newSummary.all.joint,
  );
  const output = {
    status: 'complete',
    new_parent_executions: 100,
    reused_parent_rows: 300,
    independent_questions: 100,
    reference_manifest_sha256: refs.delivery_sha256,
    conditions: comparison,
    changes,
    references: refs.conditions,
    plan_sha256: await digest(path.join(root, 'plan.json')),
    summary_sha256: await digest(path.join(root, 'summary.public.json')),
    new_model_requests: newSummary.network.requests,
    logical_replays: newSummary.replay.logical_requests,
  };
  await fs.writeFile(
    path.join(root, 'comparison.public.json'),
    JSON.stringify(output, null, 2) + '\n',
    { flag: 'wx' },
  );
  return output;
}
