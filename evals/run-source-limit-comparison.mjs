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
const experiments = {
  'source-limit': { key: 'max_chunks_per_source', values: [3, 4], baseline: 3 },
  'bm25-weight': { key: 'bm25_weight', values: [0.5, 0.25], baseline: 0.5 },
  'rrf-k': { key: 'rrf_k', values: [60, 30], baseline: 60 },
  'title-weight': { key: 'title_weight', values: [2, 1], baseline: 2 },
  'dense-threshold': {
    key: 'min_dense_similarity',
    values: [0.3, 0.25],
    baseline: 0.3,
  },
  'context-budget': {
    key: 'max_context_chars',
    values: [12000, 16000],
    baseline: 12000,
  },
};
export function experimentMetadata(experimentName) {
  const experiment = experiments[experimentName];
  assert.ok(experiment, 'Unknown experiment');
  return {
    values: [...experiment.values],
    ...(experimentName === 'source-limit'
      ? { limits: [...experiment.values] }
      : {}),
    authorization:
      experimentName === 'source-limit'
        ? 'User requested only source limit 3 versus 4 with fixed decomposition. No default change, index rebuild or final data.'
        : 'User requested ' +
          experiment.key +
          ' ' +
          experiment.values.join(' versus ') +
          ' while retaining source limit 3 and fixed decomposition. Each experiment starts from the same baseline. Use only verified frozen real responses; no new API, default change, index rebuild or final data.',
  };
}
export function experimentRetrieval(original, experimentName, value) {
  const experiment = experiments[experimentName];
  assert.ok(experiment && experiment.values.includes(value));
  assert.equal(original[experiment.key], experiment.baseline);
  assert.equal(original.max_chunks_per_source, 3);
  return { ...original, [experiment.key]: value };
}
export function experimentBudget(original, experimentName, value) {
  return experimentRetrieval(original, experimentName, value).max_context_chars;
}
export function budgetRequestPayload(request, budget) {
  assert.deepEqual(Object.keys(request.overrides ?? {}), ['max_context_chars']);
  const allowance = request.overrides.max_context_chars;
  assert.ok(Number.isInteger(allowance) && allowance >= 256);
  assert.ok(
    JSON.stringify(request).length + allowance <= budget,
    'Request plus response allowance exceeds total budget',
  );
  const { overrides, ...payload } = request;
  return payload;
}
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
export function checkedIndexState(index, revision) {
  assert.equal(
    index.revision,
    revision,
    'Index snapshot belongs to a different config revision',
  );
  const { revision: verifiedRevision, ...state } = index;
  return state;
}
async function main() {
  const { values } = parseArgs({
    options: {
      lab: { type: 'string' },
      'run-id': { type: 'string' },
      phase: { type: 'string' },
      experiment: { type: 'string' },
    },
  });
  const experimentName = values.experiment ?? 'source-limit';
  const experiment = experiments[experimentName];
  assert.ok(experiment, 'Unknown experiment');
  const limits = experiment.values;
  const offline = experimentName !== 'source-limit';
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
  const replayRoot = path.join(
    lab,
    'evidence/structure-source-limit-2026-09-17-v1',
  );
  const replayManifestSha =
    '747c30c2dd6b8a6773007427a4222869a7bb3a6423d74ae732615246cbb78910';
  const seeds = [],
    seedFiles = [];
  if (offline) {
    const file = path.join(replayRoot, 'delivery.public.json');
    assert.equal(await digest(file), replayManifestSha);
    const manifest = await get(file);
    assert.equal(manifest.model, old.model);
    assert.equal(manifest.dimensions, old.dimensions);
    for (const item of manifest.real_response_hashes) {
      assert.match(item.file, /^query-responses\/[a-f0-9]{64}\.json$/);
      const source = path.join(replayRoot, item.file);
      assert.equal(await digest(source), item.sha256);
      seeds.push(await get(source));
      seedFiles.push(source);
    }
    assert.equal(seeds.length, 135);
  }
  const responseOrigin = offline
    ? {
        run: path.basename(replayRoot),
        manifest_sha256: replayManifestSha,
        responses: seeds.length,
      }
    : null;
  async function verify(item) {
    const ref = refs.find((r) => r.scope === item.scope);
    assert.ok(ref);
    assert.ok(limits.includes(item.limit));
    assert.equal(await digest(ref.configPath), ref.config_sha256);
    assert.equal(await digest(item.configPath), item.config_sha256);
    const original = await loadConfig(ref.configPath),
      current = await loadConfig(item.configPath);
    assert.equal(
      original.profile.revision,
      ref.config_revision,
      'Reference configuration drifted',
    );
    assert.equal(current.profile.active.chunker, 'markdown-structure-v1');
    assert.equal(
      item.budget_chars ?? 12000,
      experimentBudget(original.retrieval, experimentName, item.limit),
    );
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
      experimentRetrieval(original.retrieval, experimentName, item.limit),
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
    await fs.copyFile(
      fileURLToPath(import.meta.url),
      path.join(root, 'execution-driver.mjs'),
      fs.constants.COPYFILE_EXCL,
    );
    await fs.mkdir(path.join(root, 'configs'));
    await fs.mkdir(path.join(root, 'datasets'));
    for (const limit of limits) {
      const dir = path.join(root, 'retrieval-' + limit);
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, 'chunk-fixed.json'),
        json(experimentRetrieval(old.retrieval, experimentName, limit)),
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
          budget_chars: experimentBudget(old.retrieval, experimentName, limit),
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
      experiment: experimentName,
      variable: experiment.key,
      limits,
      values: limits,
      response_origin: responseOrigin,
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
        requests: offline ? 0 : unique.size,
        input_chars: offline
          ? 0
          : [...unique].reduce((n, t) => n + t.length, 0),
      },
      logical_requests: runs.reduce((n, r) => n + r.logical_requests, 0),
      runs,
      vector_control: offline
        ? 'Reuse SHA-bound real responses from the preceding source-limit experiment; network disabled.'
        : 'First successful real response for each exact query request is frozen and replayed. Same vectors in both arms; never synthetic vectors.',
      authorization: experimentMetadata(experimentName).authorization,
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
  if (values.phase === 'summarize') {
    // Execution is immutable; a separately fingerprinted offline analyzer may be fixed.
    const { driver: executionDriver, ...executionDependencies } = plan.code;
    const { driver: analysisDriver, ...analysisDependencies } = code;
    assert.deepEqual(executionDependencies, analysisDependencies);
    assert.equal(
      await digest(path.join(root, 'execution-driver.mjs')),
      executionDriver,
    );
  } else assert.deepEqual(plan.code, code);
  assert.equal(plan.baseline_manifest_sha256, oldDeliveryHash);
  assert.equal(plan.experiment ?? 'source-limit', experimentName);
  assert.deepEqual(plan.response_origin ?? null, responseOrigin);
  for (const item of plan.runs) await verify(item);
  if (values.phase === 'run') {
    const dir = path.join(root, 'queries');
    await fs.mkdir(dir);
    const vectors = path.join(root, 'query-responses');
    await fs.mkdir(vectors);
    await fs.writeFile(path.join(dir, 'network-attempts.jsonl'), '', {
      flag: 'wx',
    });
    for (const file of seedFiles)
      await fs.copyFile(
        file,
        path.join(vectors, path.basename(file)),
        fs.constants.COPYFILE_EXCL,
      );
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
      seeds,
      offlineOnly: offline,
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
        if (offline) {
          // The frozen runtime requires a nonempty key to construct its provider.
          // All fetches are served from verified responses; cache misses throw.
          const config = await loadConfig(item.configPath);
          process.env[config.embedding.api_key_env] ||=
            'offline-replay-no-network';
        }
        const before = memo.stats();
        const run = await runRetrievalEvaluation({
          configPath: item.configPath,
          datasetPath: item.datasetPath,
          outputDir: path.join(dir, item.outputName),
          budgetChars: item.budget_chars ?? 12000,
          maxApiCalls: item.logical_requests,
        });
        assert.equal(run.report.status, 'complete');
        assert.equal(run.report.rows.length, item.parents);
        for (const row of run.report.rows) {
          assert.equal(row.status, 'ok');
          assert.ok(row.context_chars <= (item.budget_chars ?? 12000));
          budgetRequestPayload(row.request, item.budget_chars ?? 12000);
          assert.ok(row.result.results.length <= 10);
          const counts = new Map();
          for (const p of row.result.results)
            counts.set(p.source_id, (counts.get(p.source_id) ?? 0) + 1);
          const sourceLimit =
            experiment.key === 'max_chunks_per_source'
              ? item.limit
              : plan.base_retrieval.max_chunks_per_source;
          assert.ok([...counts.values()].every((n) => n <= sourceLimit));
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
  assert.equal(
    captureHashes.length,
    report.replay.network_requests + (report.replay.seeded_responses ?? 0),
  );
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
      assert.equal(manifest.revision, item.config_revision);
      assert.equal(manifest.budget_chars, item.budget_chars ?? 12000);
      assert.equal(
        manifest.retrieval.max_context_chars,
        item.budget_chars ?? 12000,
      );
      const indexState = checkedIndexState(manifest.index, manifest.revision);
      if (prior) {
        assert.deepEqual(
          indexState,
          checkedIndexState(priorManifest.index, priorManifest.revision),
        );
        for (const field of ['corpus', 'runtime', 'selection', 'embedding'])
          assert.deepEqual(manifest[field], priorManifest[field]);
        assert.deepEqual(
          manifest.retrieval,
          experimentRetrieval(
            priorManifest.retrieval,
            experimentName,
            limits[1],
          ),
        );
        if (experiment.key === 'max_context_chars') {
          assert.deepEqual(
            raw.map((r) =>
              budgetRequestPayload(r.request, manifest.budget_chars),
            ),
            prior.map((r) =>
              budgetRequestPayload(r.request, priorManifest.budget_chars),
            ),
          );
        } else
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
          keys(limits[0]),
          keys(limits[1]),
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
        const payload = budgetRequestPayload(
          row.request,
          manifest.budget_chars,
        );
        const q = data.questions[i];
        assert.deepEqual(
          payload,
          q.subquestions
            ? {
                queries: q.subquestions.map((s) => ({
                  query_id: s.id,
                  text: s.text,
                })),
              }
            : { query: q.query },
        );
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
    armRows[limits[0]].forEach((a, i) => {
      const b = armRows[limits[1]][i];
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
    ...experimentMetadata(experimentName),
    response_origin: responseOrigin,
    plan_sha256: report.plan_sha256,
    code: plan.code,
    analysis_code: code,
    execution_driver_sha256: await digest(
      path.join(root, 'execution-driver.mjs'),
    ),
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
