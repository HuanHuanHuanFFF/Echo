import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { score, summarize } from './lib/evidence-metrics.mjs';
import { frozenQueryFetch } from './lib/frozen-query-fetch.mjs';

const hash = (x) => createHash('sha256').update(x).digest('hex');
const json = (x) => JSON.stringify(x, null, 2) + '\n';
const get = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const digest = async (file) => hash(await fs.readFile(file));
const scopes = [
  'A-development',
  'B-development',
  'C-development',
  'mixed-development',
];
const limits = [3, 4];
const endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const fingerprint =
  '2e6e9f07b732465d9a61d6336eb9901ccb3f525d8c626e294c8554ccc00c36c0';
const oldDeliveryHash =
  '75f477d35cbf6f95453b0e9b1ca49ddf3851c6e84e2352984fb4c69f8fc88744';
const texts = (data) => [
  ...new Set(
    data.questions.flatMap((q) =>
      q.subquestions?.length
        ? q.subquestions.map((s) => s.text.trim())
        : [q.query.trim()],
    ),
  ),
];
const sorted = (rows) =>
  [...rows].sort((a, b) =>
    JSON.stringify([a.collection_id, a.path]).localeCompare(
      JSON.stringify([b.collection_id, b.path]),
    ),
  );
const sameSet = (a, b) => assert.deepEqual([...a].sort(), [...b].sort());
export function sourceLimitRetrieval(original, limit) {
  assert.ok(limits.includes(limit));
  assert.equal(original.max_chunks_per_source, 3);
  return { ...original, max_chunks_per_source: limit };
}
async function main() {
  const { values } = parseArgs({
    options: {
      lab: { type: 'string' },
      'run-id': { type: 'string' },
      phase: { type: 'string' },
    },
  });
  assert.ok(values.lab && /^[a-z0-9-]+$/.test(values['run-id'] ?? ''));
  assert.ok(['prepare', 'run', 'summarize'].includes(values.phase));
  const lab = path.resolve(values.lab),
    root = path.join(lab, 'evidence', values['run-id']);
  const baseline = path.join(lab, 'evidence/structure-ab-2026-09-17-v3');
  assert.notEqual(root, baseline);
  const runtime = path.join(lab, 'echo-runtime-b454686/dist');
  const load = (name) => import(pathToFileURL(path.join(runtime, name)).href);
  const { loadConfig } = await load('config.js');
  const { snapshotRetrievalCorpus, runRetrievalEvaluation } = await load(
    'retrieval-evaluation.js',
  );
  const { embeddingFingerprint, validateVectors } = await load('embedding.js');
  const { openDatabase } = await load('database.js');
  const { profileStatus } = await load('profile-store.js');
  const guardPath = path.join(lab, 'query-fetch-guard.mjs');
  const code = {
    driver: await digest(fileURLToPath(import.meta.url)),
    metrics: await digest(
      new URL('./lib/evidence-metrics.mjs', import.meta.url),
    ),
    replay: await digest(
      new URL('./lib/frozen-query-fetch.mjs', import.meta.url),
    ),
    guard: await digest(guardPath),
  };
  const deliveryPath = path.join(
    baseline,
    'comparisons/delivery-manifest-r2.public.json',
  );
  assert.equal(await digest(deliveryPath), oldDeliveryHash);
  for (const item of (await get(deliveryPath)).artifact_hashes)
    assert.equal(await digest(path.join(baseline, item.file)), item.sha256);
  const old = await get(path.join(baseline, 'plan.json'));
  const refs = old.runs.filter((r) => r.strategy === 'markdown-structure-v1');
  assert.equal(refs.length, 4);
  async function verify(item) {
    const ref = refs.find((r) => r.scope === item.scope);
    assert.ok(ref);
    assert.ok(limits.includes(item.limit));
    assert.equal(await digest(ref.configPath), ref.config_sha256);
    assert.equal(await digest(item.configPath), item.config_sha256);
    const original = await loadConfig(ref.configPath),
      current = await loadConfig(item.configPath);
    assert.equal(current.profile.active.chunker, 'markdown-structure-v1');
    assert.equal(current.profile.revision, item.config_revision);
    assert.deepEqual(current.profile.active, original.profile.active);
    for (const key of ['database', 'collections', 'embedding', 'runtime'])
      assert.deepEqual(current[key], original[key]);
    assert.equal(current.profile.chunker.fingerprint, ref.chunker_fingerprint);
    assert.equal(
      current.profile.tokenizer.fingerprint,
      original.profile.tokenizer.fingerprint,
    );
    assert.deepEqual(
      current.retrieval,
      sourceLimitRetrieval(original.retrieval, item.limit),
    );
    assert.equal(embeddingFingerprint(current.embedding), fingerprint);
    assert.equal(current.embedding.batch_size, 8);
    assert.equal(current.embedding.query_prefix, '');
    assert.equal(current.embedding.document_prefix, '');
    const manifest = await get(
      path.join(baseline, 'queries', ref.outputName, 'manifest.json'),
    );
    for (const [file, sha] of Object.entries(manifest.runtime.files))
      assert.equal(await digest(path.join(runtime, file)), sha);
    assert.equal(await digest(item.datasetPath), ref.dataset_sha256);
    const data = await get(item.datasetPath);
    assert.equal(data.split, 'development');
    assert.deepEqual(
      sorted(await snapshotRetrievalCorpus(item.configPath)),
      sorted(data.corpus),
    );
    const db = openDatabase(current.database, { readOnly: true });
    try {
      assert.ok(profileStatus(db, current).ready);
    } finally {
      db.close();
    }
    return data;
  }
  if (values.phase === 'prepare') {
    await fs.mkdir(root);
    await fs.mkdir(path.join(root, 'configs'));
    await fs.mkdir(path.join(root, 'datasets'));
    for (const limit of limits) {
      const dir = path.join(root, 'retrieval-' + limit);
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, 'chunk-fixed.json'),
        json(sourceLimitRetrieval(old.retrieval, limit)),
        { flag: 'wx' },
      );
    }
    const runs = [],
      unique = new Set();
    let childParents = 0,
      childQueries = 0;
    for (const scope of scopes) {
      const ref = refs.find((r) => r.scope === scope);
      assert.equal(await digest(ref.datasetPath), ref.dataset_sha256);
      const datasetPath = path.join(root, 'datasets', scope + '.json');
      await fs.copyFile(
        ref.datasetPath,
        datasetPath,
        fs.constants.COPYFILE_EXCL,
      );
      const data = await get(datasetPath);
      childParents += data.questions.filter(
        (q) => q.subquestions?.length,
      ).length;
      childQueries += data.questions.reduce(
        (n, q) => n + (q.subquestions?.length ?? 0),
        0,
      );
      texts(data).forEach((t) => unique.add(t));
      const original = await get(ref.configPath);
      for (const limit of limits) {
        const config = {
          ...original,
          directories: {
            ...original.directories,
            retrieval: path.join(root, 'retrieval-' + limit),
          },
        };
        const configPath = path.join(
          root,
          'configs',
          scope + '-' + limit + '.json',
        );
        await fs.writeFile(configPath, json(config), { flag: 'wx' });
        const parsed = await loadConfig(configPath);
        const item = {
          scope,
          limit,
          configPath,
          config_sha256: await digest(configPath),
          config_revision: parsed.profile.revision,
          datasetPath,
          dataset_sha256: ref.dataset_sha256,
          parents: data.questions.length,
          logical_requests: texts(data).length,
          outputName: scope + '-' + limit,
        };
        await verify(item);
        runs.push(item);
      }
    }
    assert.equal(childParents, 33);
    assert.equal(childQueries, 68);
    assert.equal(
      runs.reduce((n, r) => n + r.parents, 0),
      200,
    );
    const plan = {
      status: 'prepared',
      code,
      baseline_manifest_sha256: oldDeliveryHash,
      strategy: 'markdown-structure-v1',
      variable: 'max_chunks_per_source',
      limits,
      base_retrieval: old.retrieval,
      model: old.model,
      dimensions: old.dimensions,
      endpoint,
      independent_questions: 100,
      parent_executions: 200,
      split_parents: 33,
      fixed_subquestions: 68,
      final_queries: 0,
      caps: {
        requests: unique.size,
        input_chars: [...unique].reduce((n, t) => n + t.length, 0),
      },
      logical_requests: runs.reduce((n, r) => n + r.logical_requests, 0),
      runs,
      vector_control:
        'First successful real response for each exact query request is frozen and replayed. Same vectors in both arms; never synthetic vectors.',
      authorization:
        'User requested further parameter testing with fixed decomposition; only source limit 3 versus 4. Existing API/cost authorization applies; no index rebuild or final data.',
    };
    await fs.writeFile(path.join(root, 'plan.json'), json(plan), {
      flag: 'wx',
    });
    console.log(
      json({
        root,
        code,
        caps: plan.caps,
        logical_requests: plan.logical_requests,
        split_parents: 33,
      }),
    );
    return;
  }
  const plan = await get(path.join(root, 'plan.json'));
  assert.deepEqual(plan.code, code);
  assert.equal(plan.baseline_manifest_sha256, oldDeliveryHash);
  for (const item of plan.runs) await verify(item);
  if (values.phase === 'run') {
    const dir = path.join(root, 'queries');
    await fs.mkdir(dir);
    const vectors = path.join(root, 'query-responses');
    await fs.mkdir(vectors);
    const allowed = new Set();
    for (const item of plan.runs)
      texts(await get(item.datasetPath)).forEach((t) => allowed.add(t));
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
    const memo = frozenQueryFetch({
      fetchFn: guard.fetch,
      endpoint,
      model: plan.model,
      dimensions: plan.dimensions,
      validate: (body, count) => {
        assert.ok(Array.isArray(body.data));
        assert.equal(body.data.length, count);
        const ordered = [...body.data].sort((a, b) => a.index - b.index);
        assert.deepEqual(
          ordered.map((r) => r.index),
          [0],
        );
        validateVectors(
          ordered.map((r) => r.embedding),
          count,
          plan.dimensions,
        );
      },
      onCapture: (entry) =>
        fs.writeFile(path.join(vectors, entry.key + '.json'), json(entry), {
          flag: 'wx',
        }),
      onUse: (event) =>
        fs.appendFile(
          path.join(dir, 'vector-uses.jsonl'),
          JSON.stringify(event) + '\n',
        ),
    });
    const reports = [];
    try {
      for (const item of plan.runs) {
        await verify(item);
        globalThis.fetch = memo.forRun(
          item.outputName,
          new Set(texts(await get(item.datasetPath))),
        );
        const before = memo.stats();
        const run = await runRetrievalEvaluation({
          configPath: item.configPath,
          datasetPath: item.datasetPath,
          outputDir: path.join(dir, item.outputName),
          budgetChars: 12000,
          maxApiCalls: item.logical_requests,
        });
        assert.equal(run.report.status, 'complete');
        assert.equal(run.report.rows.length, item.parents);
        for (const row of run.report.rows) {
          assert.equal(row.status, 'ok');
          assert.ok(row.context_chars <= 12000);
          assert.ok(row.result.results.length <= 10);
          const counts = new Map();
          for (const p of row.result.results)
            counts.set(p.source_id, (counts.get(p.source_id) ?? 0) + 1);
          assert.ok([...counts.values()].every((n) => n <= item.limit));
        }
        const after = memo.stats();
        const result = {
          scope: item.scope,
          limit: item.limit,
          outputName: item.outputName,
          summary: run.report.summary,
          logical_provider_usage: run.report.api_usage,
          actual_network_requests:
            after.network_requests - before.network_requests,
        };
        reports.push(result);
        await fs.appendFile(
          path.join(dir, 'completed-runs.jsonl'),
          JSON.stringify(result) + '\n',
        );
        console.log(
          JSON.stringify({
            scope: item.scope,
            limit: item.limit,
            complete: result.summary.complete_evidence,
            network: after.network_requests,
            reused: after.reused_responses,
          }),
        );
      }
      assert.equal(memo.stats().logical_requests, plan.logical_requests);
      assert.equal(memo.stats().network_requests, guard.stats().requests);
      assert.equal(memo.stats().network_input_chars, guard.stats().input_chars);
      assert.equal(memo.stats().network_requests, plan.caps.requests);
      await fs.writeFile(
        path.join(dir, 'report.json'),
        json({
          status: 'complete',
          reports,
          network: guard.stats(),
          replay: memo.stats(),
          plan_sha256: await digest(path.join(root, 'plan.json')),
        }),
        { flag: 'wx' },
      );
    } catch (error) {
      await fs.writeFile(
        path.join(dir, 'failure.json'),
        json({
          status: 'failed',
          error: error.message,
          completed: reports,
          network: guard.stats(),
          replay: memo.stats(),
        }),
        { flag: 'wx' },
      );
      throw error;
    } finally {
      globalThis.fetch = originalFetch;
    }
    return;
  }
  const report = await get(path.join(root, 'queries/report.json'));
  assert.equal(report.status, 'complete');
  assert.equal(report.plan_sha256, await digest(path.join(root, 'plan.json')));
  const uses = (
    await fs.readFile(path.join(root, 'queries/vector-uses.jsonl'), 'utf8')
  )
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  const captureHashes = [];
  for (const file of await fs.readdir(path.join(root, 'query-responses'))) {
    const full = path.join(root, 'query-responses', file),
      entry = await get(full);
    assert.equal(
      entry.key,
      hash(endpoint + '\n' + JSON.stringify(entry.request)),
    );
    assert.equal(file, entry.key + '.json');
    assert.equal(
      entry.vector_sha256,
      hash(JSON.stringify(entry.response.data)),
    );
    for (const use of uses.filter((u) => u.request_sha256 === entry.key))
      assert.equal(use.vector_sha256, entry.vector_sha256);
    captureHashes.push({
      file: 'query-responses/' + file,
      sha256: await digest(full),
    });
  }
  assert.equal(captureHashes.length, report.replay.network_requests);
  const all = [],
    changes = [],
    artifactHashes = [];
  for (const scope of scopes) {
    let prior, priorManifest;
    const armRows = {};
    for (const limit of limits) {
      const item = plan.runs.find(
          (r) => r.scope === scope && r.limit === limit,
        ),
        dir = path.join(root, 'queries', item.outputName);
      const data = await get(path.join(dir, 'dataset.json'));
      assert.deepEqual(data, await get(item.datasetPath));
      const raw = (await fs.readFile(path.join(dir, 'rows.jsonl'), 'utf8'))
        .trim()
        .split(/\r?\n/)
        .map(JSON.parse);
      assert.deepEqual(
        raw.map((r) => r.query_id),
        data.questions.map((q) => q.id),
      );
      const manifest = await get(path.join(dir, 'manifest.json'));
      if (prior) {
        for (const field of [
          'corpus',
          'runtime',
          'selection',
          'embedding',
          'index',
          'budget_chars',
        ])
          assert.deepEqual(manifest[field], priorManifest[field]);
        assert.deepEqual(
          manifest.retrieval,
          sourceLimitRetrieval(priorManifest.retrieval, 4),
        );
        assert.deepEqual(
          raw.map((r) => r.request),
          prior.map((r) => r.request),
        );
        const keys = (arm) =>
          uses
            .filter((u) => u.run === scope + '-' + arm)
            .map((u) => u.request_sha256 + ':' + u.vector_sha256)
            .sort();
        assert.deepEqual(
          keys(3),
          keys(4),
          'The arms used different query vectors',
        );
      }
      prior = raw;
      priorManifest = manifest;
      armRows[limit] = raw;
      for (const name of [
        'dataset.json',
        'manifest.json',
        'rows.jsonl',
        'report.json',
      ])
        artifactHashes.push({
          file: 'queries/' + item.outputName + '/' + name,
          sha256: await digest(path.join(dir, name)),
        });
      raw.forEach((row, i) => {
        assert.equal(row.status, 'ok');
        const metrics = score(
          data.questions[i],
          data.facts,
          row.result.results,
        );
        if (!metrics.noAnswer) {
          sameSet(metrics.fullCovered, row.covered_facts);
          assert.ok(
            Math.abs(metrics.fullPrefixRR - row.first_fact_reciprocal_rank) <
              1e-12,
          );
        }
        all.push({ scope, limit, id: row.query_id, metrics, row });
      });
    }
    armRows[3].forEach((a, i) => {
      const b = armRows[4][i];
      const gained = b.covered_facts.filter(
        (f) => !a.covered_facts.includes(f),
      );
      const lost = a.covered_facts.filter((f) => !b.covered_facts.includes(f));
      if (gained.length || lost.length)
        changes.push({
          scope,
          id: a.query_id,
          expected: a.expected_facts.length,
          baseline_facts: a.covered_facts.length,
          candidate_facts: b.covered_facts.length,
          gained,
          lost,
          baseline_complete:
            !a.no_answer && a.covered_facts.length === a.expected_facts.length,
          candidate_complete:
            !b.no_answer && b.covered_facts.length === b.expected_facts.length,
          baseline_context: a.context_chars,
          candidate_context: b.context_chars,
          baseline_count: a.result.results.length,
          candidate_count: b.result.results.length,
        });
    });
  }
  const aggregate = (predicate) =>
    Object.fromEntries(
      limits.map((limit) => [
        limit,
        summarize(
          all
            .filter((r) => r.limit === limit && predicate(r))
            .map((r) => r.metrics),
        ),
      ]),
    );
  const totals = Object.fromEntries(
    limits.map((limit) => [
      limit,
      {
        context_chars: all
          .filter((r) => r.limit === limit)
          .reduce((n, r) => n + r.row.context_chars, 0),
        result_chunks: all
          .filter((r) => r.limit === limit)
          .reduce((n, r) => n + r.row.result.results.length, 0),
      },
    ]),
  );
  const result = {
    status: 'complete',
    variable: plan.variable,
    limits,
    plan_sha256: report.plan_sha256,
    code,
    strategy: plan.strategy,
    base_retrieval: plan.base_retrieval,
    model: plan.model,
    dimensions: plan.dimensions,
    independent_questions: 100,
    parent_executions: 200,
    final_queries: 0,
    all: aggregate(() => true),
    byScope: Object.fromEntries(
      scopes.map((scope) => [scope, aggregate((r) => r.scope === scope)]),
    ),
    changedQuestions: changes,
    totals,
    network: report.network,
    replay: report.replay,
    paired_vector_use_verified: true,
    artifact_hashes: artifactHashes,
    real_response_hashes: captureHashes,
    cost_note:
      'Provider api_usage.requests counts logical calls including replay; only network/replay.network_* describe actual external usage. Replayed responses carry zero new token usage. Latency is not comparable between cold and replayed runs.',
  };
  await fs.writeFile(path.join(root, 'summary.public.json'), json(result), {
    flag: 'wx',
  });
  console.log(
    json({
      all: Object.fromEntries(limits.map((n) => [n, result.all[n].k[10]])),
      changes,
      totals,
      network: report.network,
      replay: report.replay,
    }),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
