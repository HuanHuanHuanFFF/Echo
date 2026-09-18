import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { frozenQueryFetch } from './lib/frozen-query-fetch.mjs';

export const currentArms = [
  { id: 'heading-hybrid', strategy: 'heading-1000', mode: 'hybrid' },
  { id: 'structure-bm25', strategy: 'markdown-structure-v1', mode: 'bm25' },
  { id: 'structure-dense', strategy: 'markdown-structure-v1', mode: 'dense' },
];
export function currentRetrieval(original, mode) {
  assert.ok(['hybrid', 'bm25', 'dense'].includes(mode));
  assert.equal(original.topk, 10);
  assert.equal(original.max_chunks_per_source, 3);
  assert.equal(original.bm25_weight, 0.5);
  assert.equal(original.dense_weight, 1);
  assert.equal(original.bm25_candidates, 60);
  assert.equal(original.dense_candidates, 60);
  assert.equal(original.title_weight, 2);
  assert.equal(original.min_dense_similarity, 0.3);
  return { ...original, mode, rrf_k: 10, max_context_chars: 16000 };
}
const hash = (x) => createHash('sha256').update(x).digest('hex');
const digest = async (p) => hash(await fs.readFile(p));
const get = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const json = (x) => JSON.stringify(x, null, 2) + '\n';
const texts = (data) => [
  ...new Set(
    data.questions.flatMap((q) =>
      q.subquestions?.length ? q.subquestions.map((s) => s.text) : [q.query],
    ),
  ),
];
const sorted = (corpus) =>
  [...corpus].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
const baselineHash =
  '75f477d35cbf6f95453b0e9b1ca49ddf3851c6e84e2352984fb4c69f8fc88744';
const seedHash =
  '747c30c2dd6b8a6773007427a4222869a7bb3a6423d74ae732615246cbb78910';
const priorHash =
  '5cf20ff58e22c995df99a6d56f039a63ff443f439192b7d6ac8a3556da90a4e8';
const endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const scopes = [
  'A-development',
  'B-development',
  'C-development',
  'mixed-development',
];

async function main() {
  const { values } = parseArgs({
    options: {
      lab: { type: 'string' },
      'run-id': { type: 'string' },
      phase: { type: 'string' },
    },
  });
  assert.ok(values.lab && /^[a-z0-9-]+$/.test(values['run-id'] ?? ''));
  assert.ok(['prepare', 'run'].includes(values.phase));
  const lab = path.resolve(values.lab),
    root = path.join(lab, 'evidence', values['run-id']);
  const base = path.join(lab, 'evidence/structure-ab-2026-09-17-v3');
  const runtime = path.join(lab, 'echo-runtime-b454686/dist');
  const seedRoot = path.join(
    lab,
    'evidence/structure-source-limit-2026-09-17-v1',
  );
  const prior = path.join(
    lab,
    'evidence/rrf10-bm25-weights-2026-09-18-v1/delivery.public.json',
  );
  assert.equal(await digest(prior), priorHash);
  const load = (name) => import(pathToFileURL(path.join(runtime, name)).href);
  const { loadConfig } = await load('config.js');
  const { runRetrievalEvaluation, snapshotRetrievalCorpus } = await load(
    'retrieval-evaluation.js',
  );
  const { embeddingFingerprint, validateVectors } = await load('embedding.js');
  const { openDatabase } = await load('database.js');
  const { profileStatus } = await load('profile-store.js');
  const delivery = path.join(
    base,
    'comparisons/delivery-manifest-r2.public.json',
  );
  assert.equal(await digest(delivery), baselineHash);
  for (const f of (await get(delivery)).artifact_hashes)
    assert.equal(await digest(path.join(base, f.file)), f.sha256);
  const old = await get(path.join(base, 'plan.json'));
  const seedFile = path.join(seedRoot, 'delivery.public.json');
  assert.equal(await digest(seedFile), seedHash);
  const seedManifest = await get(seedFile),
    seeds = [];
  for (const f of seedManifest.real_response_hashes) {
    assert.match(f.file, /^query-responses\/[a-f0-9]{64}\.json$/);
    assert.equal(await digest(path.join(seedRoot, f.file)), f.sha256);
    seeds.push(await get(path.join(seedRoot, f.file)));
  }
  assert.equal(seeds.length, 135);
  const code = {
    driver: await digest(fileURLToPath(import.meta.url)),
    replay: await digest(
      new URL('./lib/frozen-query-fetch.mjs', import.meta.url),
    ),
  };
  async function verify(item) {
    const ref = old.runs.find(
      (r) => r.scope === item.scope && r.strategy === item.strategy,
    );
    assert.ok(ref);
    assert.equal(await digest(ref.configPath), ref.config_sha256);
    assert.equal(await digest(item.configPath), item.config_sha256);
    const original = await loadConfig(ref.configPath),
      config = await loadConfig(item.configPath);
    assert.equal(original.profile.revision, ref.config_revision);
    assert.equal(config.profile.revision, item.config_revision);
    assert.deepEqual(config.profile.active, original.profile.active);
    for (const k of ['database', 'collections', 'embedding', 'runtime'])
      assert.deepEqual(config[k], original[k]);
    assert.equal(config.profile.chunker.fingerprint, ref.chunker_fingerprint);
    assert.equal(
      config.profile.tokenizer.fingerprint,
      original.profile.tokenizer.fingerprint,
    );
    assert.deepEqual(
      config.retrieval,
      currentRetrieval(original.retrieval, item.mode),
    );
    assert.equal(
      embeddingFingerprint(config.embedding),
      '2e6e9f07b732465d9a61d6336eb9901ccb3f525d8c626e294c8554ccc00c36c0',
    );
    assert.equal(config.embedding.query_prefix, '');
    assert.equal(config.embedding.document_prefix, '');
    const manifest = await get(
      path.join(base, 'queries', ref.outputName, 'manifest.json'),
    );
    for (const [name, sha] of Object.entries(manifest.runtime.files))
      assert.equal(await digest(path.join(runtime, name)), sha);
    assert.equal(await digest(item.datasetPath), ref.dataset_sha256);
    const data = await get(item.datasetPath);
    assert.equal(data.split, 'development');
    assert.deepEqual(
      sorted(await snapshotRetrievalCorpus(item.configPath)),
      sorted(data.corpus),
    );
    const db = openDatabase(config.database, { readOnly: true });
    try {
      const status = profileStatus(db, config);
      assert.ok(status.ready);
      assert.deepEqual(status.indexes, manifest.index.indexes);
      assert.equal(status.chunks, manifest.index.chunks);
    } finally {
      db.close();
    }
    return { data, config };
  }
  if (values.phase === 'prepare') {
    await fs.mkdir(root);
    await fs.copyFile(
      fileURLToPath(import.meta.url),
      path.join(root, 'execution-driver.mjs'),
      fs.constants.COPYFILE_EXCL,
    );
    await fs.mkdir(path.join(root, 'configs'));
    await fs.mkdir(path.join(root, 'retrieval'));
    const runs = [];
    for (const arm of currentArms) {
      const dir = path.join(root, 'retrieval', arm.id);
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, 'chunk-fixed.json'),
        json(currentRetrieval(old.retrieval, arm.mode)),
        { flag: 'wx' },
      );
      for (const scope of scopes) {
        const ref = old.runs.find(
          (r) => r.scope === scope && r.strategy === arm.strategy,
        );
        const original = await get(ref.configPath);
        const configPath = path.join(
          root,
          'configs',
          scope + '-' + arm.id + '.json',
        );
        await fs.writeFile(
          configPath,
          json({
            ...original,
            directories: { ...original.directories, retrieval: dir },
          }),
          { flag: 'wx' },
        );
        const config = await loadConfig(configPath),
          data = await get(ref.datasetPath);
        const item = {
          ...arm,
          scope,
          configPath,
          config_sha256: await digest(configPath),
          config_revision: config.profile.revision,
          datasetPath: ref.datasetPath,
          dataset_sha256: ref.dataset_sha256,
          parents: data.questions.length,
          outputName: scope + '-' + arm.id,
          logical_requests: arm.mode === 'bm25' ? 0 : texts(data).length,
        };
        await verify(item);
        runs.push(item);
      }
    }
    const databases = {};
    for (const r of runs) {
      const c = await loadConfig(r.configPath);
      databases[c.database] = await digest(c.database);
    }
    const plan = {
      status: 'prepared',
      code,
      baseline_manifest_sha256: baselineHash,
      prior_delivery_sha256: priorHash,
      seeds_manifest_sha256: seedHash,
      model: old.model,
      dimensions: old.dimensions,
      endpoint,
      retrieval: currentRetrieval(old.retrieval, 'hybrid'),
      arms: currentArms,
      runs,
      databases,
      new_parent_executions: 300,
      independent_questions: 100,
      reused_baseline_parents: 100,
      logical_replays: 270,
      network_requests: 0,
      final_queries: 0,
      reused_baseline: 'structure-rrf10-current-2026-09-18-v1',
      authorization:
        'User requested label audit, current-parameter heading versus structure, and current structure BM25/dense/hybrid. Only three missing arms run. Frozen real query replay only; no new API, defaults, source/index edits or final data.',
    };
    await fs.writeFile(path.join(root, 'plan.json'), json(plan), {
      flag: 'wx',
    });
    console.log(
      json({
        root,
        runs: runs.length,
        new_parents: 300,
        replays: 270,
        network: 0,
      }),
    );
    return;
  }
  const plan = await get(path.join(root, 'plan.json'));
  assert.deepEqual(plan.code, code);
  assert.deepEqual(plan.arms, currentArms);
  for (const item of plan.runs) await verify(item);
  for (const [file, sha] of Object.entries(plan.databases))
    assert.equal(await digest(file), sha);
  const dir = path.join(root, 'queries');
  await fs.mkdir(dir);
  const seedDir = path.join(root, 'query-responses');
  await fs.mkdir(seedDir);
  for (const f of seedManifest.real_response_hashes)
    await fs.copyFile(
      path.join(seedRoot, f.file),
      path.join(seedDir, path.basename(f.file)),
      fs.constants.COPYFILE_EXCL,
    );
  await fs.writeFile(path.join(dir, 'network-attempts.jsonl'), '', {
    flag: 'wx',
  });
  await fs.writeFile(path.join(dir, 'vector-uses.jsonl'), '', { flag: 'wx' });
  const memo = frozenQueryFetch({
    endpoint,
    model: plan.model,
    dimensions: plan.dimensions,
    seeds,
    offlineOnly: true,
    fetchFn: async () => {
      throw new Error('Network forbidden');
    },
    validate: (p, n) => {
      assert.equal(p.data.length, n);
      assert.deepEqual(
        p.data.map((x) => x.index),
        [0],
      );
      validateVectors(
        p.data.map((x) => x.embedding),
        n,
        plan.dimensions,
      );
    },
    onUse: (e) =>
      fs.appendFile(
        path.join(dir, 'vector-uses.jsonl'),
        JSON.stringify(e) + '\n',
      ),
  });
  const originalFetch = globalThis.fetch,
    completed = [];
  try {
    for (const item of plan.runs) {
      const { data, config } = await verify(item);
      globalThis.fetch =
        item.mode === 'bm25'
          ? async () => {
              throw new Error('BM25 cannot request vectors');
            }
          : memo.forRun(item.outputName, new Set(texts(data)));
      process.env[config.embedding.api_key_env] ||= 'offline-replay-no-network';
      const before = memo.stats().logical_requests;
      const result = await runRetrievalEvaluation({
        configPath: item.configPath,
        datasetPath: item.datasetPath,
        outputDir: path.join(dir, item.outputName),
        budgetChars: 16000,
        maxApiCalls: item.logical_requests,
      });
      assert.equal(result.report.status, 'complete');
      assert.equal(result.report.rows.length, item.parents);
      assert.equal(
        memo.stats().logical_requests - before,
        item.logical_requests,
      );
      for (const row of result.report.rows) {
        assert.equal(row.status, 'ok');
        assert.ok(row.context_chars <= 16000);
        assert.equal(row.result.applied.mode, item.mode);
        assert.equal(row.result.selection.chunker, item.strategy);
        assert.ok(row.result.results.length <= 10);
        const counts = new Map();
        for (const piece of row.result.results)
          counts.set(piece.source_id, (counts.get(piece.source_id) ?? 0) + 1);
        assert.ok([...counts.values()].every((n) => n <= 3));
      }
      completed.push({ id: item.id, scope: item.scope, parents: item.parents });
      await fs.appendFile(
        path.join(dir, 'completed-runs.jsonl'),
        JSON.stringify(completed.at(-1)) + '\n',
      );
      console.log(JSON.stringify(completed.at(-1)));
    }
    assert.equal(memo.stats().logical_requests, 270);
    assert.equal(memo.stats().network_requests, 0);
    for (const [file, sha] of Object.entries(plan.databases))
      assert.equal(await digest(file), sha);
    await fs.writeFile(
      path.join(dir, 'report.json'),
      json({
        status: 'complete',
        completed,
        replay: memo.stats(),
        plan_sha256: await digest(path.join(root, 'plan.json')),
        databases_unchanged: true,
      }),
      { flag: 'wx' },
    );
  } catch (error) {
    await fs.writeFile(
      path.join(dir, 'failure.json'),
      json({
        status: 'failed',
        message: error.message,
        completed,
        replay: memo.stats(),
      }),
      { flag: 'wx' },
    );
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
