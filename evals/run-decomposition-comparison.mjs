// Only the frozen markdown-structure-v1 development100 input form changes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { score, summarize, selfTest } from './lib/evidence-metrics.mjs';

const scopes = [
  'A-development',
  'B-development',
  'C-development',
  'mixed-development',
];
const arms = ['split', 'parent'];
const baselineName = 'structure-ab-2026-09-17-v3';
const deliveryHash =
  '75f477d35cbf6f95453b0e9b1ca49ddf3851c6e84e2352984fb4c69f8fc88744';
const endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const hash = (x) => createHash('sha256').update(x).digest('hex');
const json = (x) => JSON.stringify(x, null, 2) + '\n';
const get = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const fileHash = async (file) => hash(await fs.readFile(file));
const scriptPath = fileURLToPath(import.meta.url);
const metricsPath = fileURLToPath(
  new URL('./lib/evidence-metrics.mjs', import.meta.url),
);
const textsFor = (data) => [
  ...new Set(
    data.questions.flatMap((q) =>
      q.subquestions?.length
        ? q.subquestions.map((s) => s.text.trim())
        : [q.query.trim()],
    ),
  ),
];
export function parentOnly(data) {
  const copy = structuredClone(data);
  for (const q of copy.questions) delete q.subquestions;
  return copy;
}
function fixtures() {
  const data = {
    facts: [{ id: 'f' }],
    corpus: ['fixed'],
    questions: [
      {
        id: 'a',
        query: 'whole',
        required_facts: ['f'],
        no_answer: false,
        subquestions: [{ id: 's', text: 'part', required_facts: ['f'] }],
      },
      { id: 'b', query: 'unchanged', required_facts: ['f'], no_answer: false },
    ],
  };
  const before = structuredClone(data),
    after = parentOnly(data);
  assert.deepEqual(data, before);
  assert.deepEqual(after.facts, data.facts);
  assert.deepEqual(after.corpus, data.corpus);
  assert.deepEqual(after.questions[1], data.questions[1]);
  assert.deepEqual(textsFor(data), ['part', 'unchanged']);
  assert.deepEqual(textsFor(after), ['whole', 'unchanged']);
  return [...selfTest(), 'only-subquestions-removed-original-immutable'];
}
async function main() {
  const { values } = parseArgs({
    options: {
      lab: { type: 'string' },
      'run-id': { type: 'string' },
      phase: { type: 'string' },
      'self-test': { type: 'boolean' },
    },
  });
  if (values['self-test']) {
    console.log(json({ passed: fixtures() }));
    return;
  }
  assert.ok(values.lab && /^[a-z0-9-]+$/.test(values['run-id'] ?? ''));
  assert.ok(['prepare', 'run', 'summarize'].includes(values.phase));
  const lab = path.resolve(values.lab);
  const root = path.join(lab, 'evidence', values['run-id']);
  assert.notEqual(values['run-id'], baselineName);
  const baseline = path.join(lab, 'evidence', baselineName);
  const runtime = path.join(lab, 'echo-runtime-b454686/dist');
  const guardPath = path.join(lab, 'query-fetch-guard.mjs');
  const load = (name) => import(pathToFileURL(path.join(runtime, name)).href);
  const { loadConfig } = await load('config.js');
  const { snapshotRetrievalCorpus, runRetrievalEvaluation } = await load(
    'retrieval-evaluation.js',
  );
  const { openDatabase } = await load('database.js');
  const { profileStatus } = await load('profile-store.js');
  const { embeddingFingerprint } = await load('embedding.js');
  const currentCode = {
    driver: await fileHash(scriptPath),
    metrics: await fileHash(metricsPath),
    guard: await fileHash(guardPath),
  };
  const baselineDelivery = path.join(
    baseline,
    'comparisons/delivery-manifest-r2.public.json',
  );
  assert.equal(await fileHash(baselineDelivery), deliveryHash);
  const delivery = await get(baselineDelivery);
  for (const item of delivery.artifact_hashes)
    assert.equal(await fileHash(path.join(baseline, item.file)), item.sha256);
  const oldPlan = await get(path.join(baseline, 'plan.json'));
  const references = oldPlan.runs.filter(
    (r) => r.strategy === 'markdown-structure-v1',
  );
  assert.equal(references.length, 4);
  async function verify(item) {
    const ref = references.find((r) => r.scope === item.scope);
    assert.ok(ref);
    assert.equal(item.configPath, ref.configPath);
    assert.equal(await fileHash(ref.configPath), ref.config_sha256);
    const config = await loadConfig(ref.configPath);
    assert.equal(config.profile.active.chunker, 'markdown-structure-v1');
    assert.equal(config.profile.revision, ref.config_revision);
    assert.equal(config.profile.chunker.fingerprint, ref.chunker_fingerprint);
    const oldManifest = await get(
      path.join(baseline, 'queries', ref.outputName, 'manifest.json'),
    );
    assert.deepEqual(config.retrieval, oldManifest.retrieval);
    assert.equal(
      embeddingFingerprint(config.embedding),
      '2e6e9f07b732465d9a61d6336eb9901ccb3f525d8c626e294c8554ccc00c36c0',
    );
    for (const [file, expected] of Object.entries(oldManifest.runtime.files))
      assert.equal(await fileHash(path.join(runtime, file)), expected);
    const data = await get(item.datasetPath);
    assert.equal(await fileHash(item.datasetPath), item.dataset_sha256);
    const originalBytes = await fs.readFile(ref.datasetPath);
    assert.equal(hash(originalBytes), ref.dataset_sha256);
    const original = JSON.parse(originalBytes);
    assert.deepEqual(
      data,
      item.arm === 'split' ? original : parentOnly(original),
    );
    const normalize = (entries) =>
      [...entries].sort((a, b) =>
        JSON.stringify([a.collection_id, a.path]).localeCompare(
          JSON.stringify([b.collection_id, b.path]),
        ),
      );
    assert.deepEqual(
      normalize(await snapshotRetrievalCorpus(ref.configPath)),
      normalize(data.corpus),
    );
    const db = openDatabase(config.database, { readOnly: true });
    try {
      assert.ok(profileStatus(db, config).ready);
    } finally {
      db.close();
    }
    return data;
  }
  if (values.phase === 'prepare') {
    await fs.mkdir(root);
    await fs.mkdir(path.join(root, 'datasets'));
    const runs = [],
      changedIds = {};
    let requests = 0,
      inputChars = 0,
      childCount = 0,
      changedCount = 0;
    for (const [scopeIndex, scope] of scopes.entries()) {
      const ref = references.find((r) => r.scope === scope);
      const bytes = await fs.readFile(ref.datasetPath);
      assert.equal(hash(bytes), ref.dataset_sha256);
      const data = JSON.parse(bytes);
      assert.equal(data.split, 'development');
      const changed = data.questions.filter((q) => q.subquestions?.length);
      changedIds[scope] = changed.map((q) => q.id);
      changedCount += changed.length;
      childCount += changed.reduce((n, q) => n + q.subquestions.length, 0);
      // Alternate which arm runs first across scopes; not a latency benchmark.
      for (const arm of scopeIndex % 2 ? [...arms].reverse() : arms) {
        const selected = arm === 'split' ? data : parentOnly(data);
        const datasetPath = path.join(
          root,
          'datasets',
          scope + '-' + arm + '.json',
        );
        await fs.writeFile(
          datasetPath,
          arm === 'split' ? bytes : json(selected),
          { flag: 'wx' },
        );
        const queries = textsFor(selected);
        const item = {
          scope,
          arm,
          configPath: ref.configPath,
          datasetPath,
          dataset_sha256: await fileHash(datasetPath),
          parents: selected.questions.length,
          requests: queries.length,
          input_chars: queries.reduce((n, t) => n + t.length, 0),
          outputName: scope + '-' + arm,
        };
        await verify(item);
        requests += item.requests;
        inputChars += item.input_chars;
        runs.push(item);
      }
    }
    assert.equal(changedCount, 33);
    assert.equal(childCount, 68);
    assert.equal(
      runs.reduce((n, r) => n + r.parents, 0),
      200,
    );
    const plan = {
      status: 'prepared',
      baseline: baselineName,
      baseline_manifest_sha256: deliveryHash,
      code: currentCode,
      strategy: 'markdown-structure-v1',
      retrieval: oldPlan.retrieval,
      model: oldPlan.model,
      dimensions: oldPlan.dimensions,
      endpoint,
      changed_parent_count: changedCount,
      fixed_child_count: childCount,
      changedIds,
      parent_executions: 200,
      independent_questions: 100,
      final_queries: 0,
      caps: { requests, input_chars: inputChars },
      runs,
      authorization:
        'User requested only the new composite strategy: frozen subquestions versus unchanged full parent query; approved requested evaluation API use/cost. No index rebuild, other strategy or final data.',
      checks: fixtures(),
    };
    await fs.writeFile(path.join(root, 'plan.json'), json(plan), {
      flag: 'wx',
    });
    console.log(
      json({
        root,
        status: plan.status,
        caps: plan.caps,
        changedIds,
        checks: plan.checks,
      }),
    );
    return;
  }
  const plan = await get(path.join(root, 'plan.json'));
  assert.deepEqual(
    plan.code,
    currentCode,
    'Code changed after preparation; use a new run ID',
  );
  assert.equal(plan.baseline_manifest_sha256, deliveryHash);
  for (const item of plan.runs) await verify(item);
  if (values.phase === 'run') {
    const dir = path.join(root, 'queries');
    await fs.mkdir(dir); // Refuse overwriting or retrying a prior attempted batch.
    const allowed = new Set();
    for (const item of plan.runs)
      textsFor(await get(item.datasetPath)).forEach((t) => allowed.add(t));
    const { createQueryFetchGuard } = await import(
      pathToFileURL(guardPath).href
    );
    const originalFetch = globalThis.fetch;
    const guard = createQueryFetchGuard({
      fetchFn: originalFetch,
      endpoint,
      allowedTexts: allowed,
      caps: plan.caps,
      onAttempt: (event) =>
        fs.appendFile(
          path.join(dir, 'network-attempts.jsonl'),
          JSON.stringify(event) + '\n',
        ),
    });
    globalThis.fetch = guard.fetch;
    const runs = [];
    try {
      for (const item of plan.runs) {
        await verify(item);
        const run = await runRetrievalEvaluation({
          configPath: item.configPath,
          datasetPath: item.datasetPath,
          outputDir: path.join(dir, item.outputName),
          budgetChars: 12000,
          maxApiCalls: item.requests,
        });
        assert.equal(run.report.status, 'complete');
        assert.equal(run.report.rows.length, item.parents);
        for (const row of run.report.rows) {
          assert.equal(row.status, 'ok');
          assert.ok(row.context_chars <= 12000);
          assert.ok(row.result.results.length <= 10);
          const counts = new Map();
          for (const piece of row.result.results)
            counts.set(piece.source_id, (counts.get(piece.source_id) ?? 0) + 1);
          assert.ok([...counts.values()].every((n) => n <= 3));
        }
        const result = {
          scope: item.scope,
          arm: item.arm,
          outputName: item.outputName,
          summary: run.report.summary,
          api_usage: run.report.api_usage,
        };
        runs.push(result);
        await fs.appendFile(
          path.join(dir, 'completed-runs.jsonl'),
          JSON.stringify(result) + '\n',
        );
        console.log(
          JSON.stringify({
            scope: item.scope,
            arm: item.arm,
            complete: result.summary.complete_evidence,
            requests: guard.stats().requests,
          }),
        );
      }
      const apiUsage = {
        requests: runs.reduce((n, r) => n + r.api_usage.requests, 0),
        input_chars: runs.reduce((n, r) => n + r.api_usage.input_chars, 0),
        reported_tokens: runs.every((r) => r.api_usage.reported_tokens !== null)
          ? runs.reduce((n, r) => n + r.api_usage.reported_tokens, 0)
          : null,
      };
      assert.equal(apiUsage.requests, guard.stats().requests);
      assert.equal(apiUsage.input_chars, guard.stats().input_chars);
      await fs.writeFile(
        path.join(dir, 'report.json'),
        json({
          status: 'complete',
          runs,
          api_usage: apiUsage,
          network: guard.stats(),
          plan_sha256: await fileHash(path.join(root, 'plan.json')),
        }),
        { flag: 'wx' },
      );
    } catch (error) {
      await fs.writeFile(
        path.join(dir, 'failure.json'),
        json({
          status: 'failed',
          completed_runs: runs,
          network: guard.stats(),
          error: error.message,
        }),
        { flag: 'wx' },
      );
      throw error;
    } finally {
      globalThis.fetch = originalFetch;
    }
    return;
  }
  const batch = await get(path.join(root, 'queries/report.json'));
  assert.equal(batch.status, 'complete');
  assert.equal(batch.plan_sha256, await fileHash(path.join(root, 'plan.json')));
  const all = [],
    changes = [],
    controls = [],
    sourceHashes = [];
  for (const scope of scopes) {
    const armRuns = {};
    for (const arm of arms) {
      const item = plan.runs.find((r) => r.scope === scope && r.arm === arm);
      const dir = path.join(root, 'queries', item.outputName);
      const data = await get(path.join(dir, 'dataset.json'));
      assert.deepEqual(data, await get(item.datasetPath));
      const rows = (await fs.readFile(path.join(dir, 'rows.jsonl'), 'utf8'))
        .trim()
        .split(/\r?\n/)
        .map(JSON.parse);
      assert.deepEqual(
        rows.map((r) => r.query_id),
        data.questions.map((q) => q.id),
      );
      for (const file of [
        'dataset.json',
        'rows.jsonl',
        'manifest.json',
        'report.json',
      ])
        sourceHashes.push({
          file: 'queries/' + item.outputName + '/' + file,
          sha256: await fileHash(path.join(dir, file)),
        });
      const manifest = await get(path.join(dir, 'manifest.json'));
      const oldManifest = await get(
        path.join(baseline, 'queries', scope + '-2/manifest.json'),
      );
      for (const field of [
        'corpus',
        'runtime',
        'selection',
        'revision',
        'retrieval',
        'embedding',
        'index',
        'budget_chars',
      ])
        assert.deepEqual(
          manifest[field],
          oldManifest[field],
          'Frozen condition differs: ' + field,
        );
      const metrics = rows.map((row, i) => {
        assert.equal(row.status, 'ok');
        const m = score(data.questions[i], data.facts, row.result.results);
        if (!m.noAnswer) {
          assert.deepEqual(
            [...m.fullCovered].sort(),
            [...row.covered_facts].sort(),
          );
          assert.ok(
            Math.abs(m.fullPrefixRR - row.first_fact_reciprocal_rank) < 1e-12,
          );
        }
        const result = {
          scope,
          arm,
          id: row.query_id,
          changed: plan.changedIds[scope].includes(row.query_id),
          metric: m,
          row,
        };
        all.push(result);
        return result;
      });
      armRuns[arm] = metrics;
    }
    for (let i = 0; i < armRuns.split.length; i++) {
      const a = armRuns.split[i],
        b = armRuns.parent[i];
      assert.equal(a.id, b.id);
      const record = {
        scope,
        id: a.id,
        expected: a.row.expected_facts.length,
        split_facts: a.row.covered_facts.length,
        parent_facts: b.row.covered_facts.length,
        gained: b.row.covered_facts.filter(
          (f) => !a.row.covered_facts.includes(f),
        ),
        lost: a.row.covered_facts.filter(
          (f) => !b.row.covered_facts.includes(f),
        ),
        split_complete: !a.metric.noAnswer && a.metric.k[10].complete,
        parent_complete: !b.metric.noAnswer && b.metric.k[10].complete,
        split_context_chars: a.row.context_chars,
        parent_context_chars: b.row.context_chars,
        split_api_requests: a.row.api_requests,
        parent_api_requests: b.row.api_requests,
        split_count: a.row.result.results.length,
        parent_count: b.row.result.results.length,
      };
      if (a.changed) changes.push(record);
      else {
        assert.deepEqual(a.row.request, b.row.request);
        // Ignore latency/usage; bind ordered evidence, rankings and delivered JSON.
        const semantic = (row) => ({
          facts: row.covered_facts,
          result: row.result,
          context: row.context_chars,
        });
        controls.push({
          ...record,
          identical:
            JSON.stringify(semantic(a.row)) === JSON.stringify(semantic(b.row)),
        });
      }
    }
  }
  const metricsFor = (predicate) =>
    Object.fromEntries(
      arms.map((arm) => [
        arm,
        summarize(
          all.filter((r) => r.arm === arm && predicate(r)).map((r) => r.metric),
        ),
      ]),
    );
  const result = {
    status: 'complete',
    strategy: plan.strategy,
    retrieval: plan.retrieval,
    model: plan.model,
    dimensions: plan.dimensions,
    plan_sha256: await fileHash(path.join(root, 'plan.json')),
    code: currentCode,
    api_usage: batch.api_usage,
    network: batch.network,
    parent_executions: all.length,
    independent_questions: 100,
    final_queries: 0,
    all: metricsFor(() => true),
    changed: metricsFor((r) => r.changed),
    byScope: Object.fromEntries(
      scopes.map((scope) => [
        scope,
        {
          all: metricsFor((r) => r.scope === scope),
          changed: metricsFor((r) => r.scope === scope && r.changed),
        },
      ]),
    ),
    unchanged: {
      parents: controls.length,
      identical: controls.filter((r) => r.identical).length,
      differences: controls
        .filter((r) => !r.identical)
        .map((r) => ({ scope: r.scope, id: r.id })),
    },
    changedQuestions: changes,
    artifact_hashes: sourceHashes,
    cumulative_context_chars: Object.fromEntries(
      arms.map((arm) => [
        arm,
        all
          .filter((r) => r.arm === arm)
          .reduce((n, r) => n + r.row.context_chars, 0),
      ]),
    ),
    limits:
      'Frozen decomposition ablation on development data. Parent query text, labels and all index/retrieval settings fixed. Not a test of arbitrary Agent decomposition or answer generation.',
  };
  const target = path.join(root, 'summary.public.json');
  await fs.writeFile(target, json(result), { flag: 'wx' });
  console.log(
    json({
      target,
      all: Object.fromEntries(arms.map((a) => [a, result.all[a].k[10]])),
      changed: Object.fromEntries(
        arms.map((a) => [a, result.changed[a].k[10]]),
      ),
      unchanged: result.unchanged,
      api_usage: result.api_usage,
    }),
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
