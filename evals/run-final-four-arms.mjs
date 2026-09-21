import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { frozenQueryFetch } from './lib/frozen-query-fetch.mjs';

const hash = (x) => createHash('sha256').update(x).digest('hex');
const digest = async (p) => hash(await fs.readFile(p));
const get = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const json = (x) => JSON.stringify(x, null, 2) + '\n';
const endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const fingerprint =
  '2e6e9f07b732465d9a61d6336eb9901ccb3f525d8c626e294c8554ccc00c36c0';
const bundleHash =
  'e8df0296b50c522c5f2738e69aa9a82f881f8955e4070b4d8350c063b12d2565';
const choiceHash =
  '52ceeb079f558728d44bf96f4a1f6ed650123b59bd9563a42b1396bb1c7b4d69';
const scopes = [
  ['A-test', 50, 'echo-A-heading-1000-hybrid.config.json'],
  ['B-test', 35, 'echo-B-heading-1000-hybrid.config.json'],
  ['C-test', 25, 'echo-C-heading-1000-hybrid.config.json'],
  ['D-test', 30, 'echo-D-heading-1000-hybrid.config.json'],
  ['mixed-test', 60, 'echo-mixed-test-heading-1000-hybrid.config.json'],
  ['paired-test', 40, 'echo-mixed-test-heading-1000-hybrid.config.json'],
];
const texts = (d) => [
  ...new Set(
    d.questions.flatMap((q) =>
      q.subquestions?.length
        ? q.subquestions.map((s) => s.text.trim())
        : [q.query.trim()],
    ),
  ),
];
const normalized = (a) =>
  [...a].sort((x, y) =>
    JSON.stringify([x.collection_id, x.path]).localeCompare(
      JSON.stringify([y.collection_id, y.path]),
    ),
  );
export function assertFinalChoice(choice) {
  assert.equal(choice.status, 'frozen');
  assert.equal(choice.based_only_on, 'development');
  assert.equal(choice.final_runs_before_freeze, 0);
  assert.equal(choice.frozen_bundle_sha256, bundleHash);
  assert.deepEqual(choice.arms, [
    {
      id: 'structure-hybrid',
      strategy: 'markdown-structure-v1',
      mode: 'hybrid',
    },
    { id: 'heading-hybrid', strategy: 'heading-1000', mode: 'hybrid' },
    { id: 'structure-dense', strategy: 'markdown-structure-v1', mode: 'dense' },
    { id: 'structure-bm25', strategy: 'markdown-structure-v1', mode: 'bm25' },
  ]);
  assert.deepEqual(choice.retrieval, {
    id: 'final-fixed',
    mode: 'hybrid',
    topk: 10,
    max_chunks_per_source: 3,
    bm25_candidates: 60,
    dense_candidates: 60,
    rrf_k: 10,
    title_weight: 2,
    bm25_weight: 0.5,
    dense_weight: 1,
    min_dense_similarity: 0.3,
    max_context_chars: 16000,
  });
  assert.equal(choice.primary_questions, 200);
  assert.equal(choice.paired_existing_questions, 40);
}
export function reusableDevelopmentScope(scope) {
  return ['A-test', 'B-test', 'C-test'].includes(scope)
    ? scope.replace('-test', '-development')
    : null;
}
export function finalRetrieval(choice, mode) {
  assert.ok(['hybrid', 'dense', 'bm25'].includes(mode));
  const { id, ...options } = choice.retrieval;
  assert.equal(id, 'final-fixed');
  return { ...options, mode };
}
export function verifyPairedQuestions(primary, paired) {
  const all = primary.flatMap((d) => d.questions);
  assert.equal(all.length, 200);
  assert.equal(new Set(all.map((q) => q.id)).size, 200);
  assert.equal(paired.questions.length, 40);
  assert.equal(new Set(paired.questions.map((q) => q.id)).size, 40);
  const single = primary.filter((d) => d.scenario.kind === 'separate');
  for (const q of paired.questions) {
    const origin = single.find((d) => d.questions.some((x) => x.id === q.id));
    assert.ok(origin);
    assert.deepEqual(
      q,
      origin.questions.find((x) => x.id === q.id),
    );
    for (const id of q.required_facts)
      assert.deepEqual(
        paired.facts.find((f) => f.id === id),
        origin.facts.find((f) => f.id === id),
      );
  }
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
  assert.ok(['prepare', 'index', 'capture', 'run'].includes(values.phase));
  const lab = path.resolve(values.lab),
    root = path.join(lab, 'evidence', values['run-id']);
  const selection = path.join(root, 'selection.json');
  assert.equal(await digest(selection), choiceHash);
  const choice = await get(selection);
  assertFinalChoice(choice);
  const runtime = path.join(lab, 'echo-runtime-b454686/dist'),
    load = (n) => import(pathToFileURL(path.join(runtime, n)).href);
  const { loadConfig } = await load('config.js');
  const { snapshotRetrievalCorpus, runRetrievalEvaluation } = await load(
    'retrieval-evaluation.js',
  );
  const { parseSource } = await load('identity.js');
  const { profileChunker } = await load('profiles.js');
  const { runChunker } = await load('chunker.js');
  const { syncIndex } = await load('sync.js');
  const { openDatabase } = await load('database.js');
  const { profileStatus } = await load('profile-store.js');
  const { createEmbeddingProvider, embeddingFingerprint, validateVectors } =
    await load('embedding.js');
  const guardFile = path.join(lab, 'query-fetch-guard-final.mjs');
  const { createQueryFetchGuard } = await import(pathToFileURL(guardFile).href);
  const bundlePath = path.join(
    lab,
    'evidence/frozen-evaluation-2026-09-16-v1/manifest.json',
  );
  assert.equal(await digest(bundlePath), bundleHash);
  const bundle = await get(bundlePath),
    datasets = new Map();
  for (const [scope, count] of scopes) {
    const entry = [...bundle.files, ...bundle.paired_files].find(
      (f) => f.scope === scope,
    );
    assert.ok(entry);
    const file = path.join(path.dirname(bundlePath), entry.file);
    assert.equal(await digest(file), entry.sha256);
    const data = await get(file);
    assert.equal(data.split, 'test');
    assert.equal(data.questions.length, count);
    datasets.set(scope, { file, sha256: entry.sha256, data });
  }
  verifyPairedQuestions(
    scopes.slice(0, 5).map(([s]) => datasets.get(s).data),
    datasets.get('paired-test').data,
  );
  const oldRoot = path.join(lab, 'evidence/structure-ab-2026-09-17-v3'),
    old = await get(path.join(oldRoot, 'plan.json'));
  const sourceManifest = await get(
    path.join(oldRoot, 'queries/A-development-2/manifest.json'),
  );
  for (const [file, sha] of Object.entries(sourceManifest.runtime.files))
    assert.equal(await digest(path.join(runtime, file)), sha);
  const code = {
    driver: await digest(fileURLToPath(import.meta.url)),
    replay: await digest(
      new URL('./lib/frozen-query-fetch.mjs', import.meta.url),
    ),
    guard: await digest(guardFile),
  };
  const status = (config) => {
    const db = openDatabase(config.database, { readOnly: true });
    try {
      return profileStatus(db, config);
    } finally {
      db.close();
    }
  };
  const cacheFolder = path.join(
    lab,
    '.echo/document-vector-cache',
    fingerprint,
  );
  const cacheKey = (text) =>
    hash(JSON.stringify([fingerprint, 'document', text]));
  async function cached(text) {
    try {
      const c = await get(path.join(cacheFolder, cacheKey(text) + '.json'));
      assert.equal(c.fingerprint, fingerprint);
      assert.equal(c.input_sha256, hash(text));
      assert.equal(c.dimensions, 1024);
      assert.equal(c.vector_sha256, hash(JSON.stringify(c.vector)));
      validateVectors([c.vector], 1, 1024);
      return c.vector;
    } catch (e) {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    }
  }
  async function chunkTexts(config, data, configPath) {
    assert.deepEqual(
      normalized(await snapshotRetrievalCorpus(configPath)),
      normalized(data.corpus),
    );
    const strategy = await profileChunker(config.profile.chunker),
      roots = new Map(config.collections.map((c) => [c.id, c.root])),
      out = [];
    for (const entry of data.corpus) {
      const file = path.resolve(roots.get(entry.collection_id), entry.path),
        bytes = await fs.readFile(file);
      assert.equal(hash(bytes), entry.sha256);
      const parsed = parseSource(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
      assert.ok(parsed.sourceId);
      const lines = parsed.lines
        .map((text, i) => ({ text, number: i + 1 }))
        .filter((l) => l.number > parsed.frontmatterEnd + 1);
      const chunks = await runChunker(strategy, {
        sourceId: parsed.sourceId,
        path: file,
        lines,
        options: {},
      });
      for (const l of lines.filter((l) => l.text.trim()))
        assert.ok(
          chunks.some((c) => c.startLine <= l.number && c.endLine >= l.number),
        );
      for (const c of chunks) {
        assert.ok(c.text.length <= 1500 || c.startLine === c.endLine);
        out.push(
          [path.basename(file, '.md'), ...c.headingPath, c.text].join('\n'),
        );
      }
    }
    return out;
  }
  async function verify(item, { ready = true } = {}) {
    assert.equal(await digest(item.configPath), item.config_sha256);
    const c = await loadConfig(item.configPath);
    assert.equal(c.profile.revision, item.config_revision);
    assert.equal(c.profile.active.chunker, item.strategy);
    assert.equal(c.profile.active.tokenizer, 'icu-zh');
    assert.equal(c.profile.chunker.fingerprint, item.chunker_fingerprint);
    assert.equal(c.profile.tokenizer.fingerprint, item.tokenizer_fingerprint);
    assert.deepEqual(c.retrieval, finalRetrieval(choice, item.mode));
    assert.equal(embeddingFingerprint(c.embedding), fingerprint);
    assert.equal(c.embedding.batch_size, 8);
    assert.equal(c.embedding.timeout_ms, 30000);
    assert.equal(c.embedding.document_prefix, '');
    assert.equal(c.embedding.query_prefix, '');
    assert.equal(await digest(item.datasetPath), item.dataset_sha256);
    assert.deepEqual(
      normalized(await snapshotRetrievalCorpus(item.configPath)),
      normalized(datasets.get(item.scope).data.corpus),
    );
    if (ready) assert.ok(status(c).ready);
    return c;
  }
  if (values.phase === 'prepare') {
    await fs.mkdir(path.join(root, 'configs'));
    await fs.mkdir(path.join(root, 'retrieval'));
    await fs.copyFile(
      fileURLToPath(import.meta.url),
      path.join(root, 'execution-driver.mjs'),
      fs.constants.COPYFILE_EXCL,
    );
    for (const arm of choice.arms) {
      const dir = path.join(root, 'retrieval', arm.id);
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, 'final-fixed.json'),
        json({ ...choice.retrieval, mode: arm.mode }),
        { flag: 'wx' },
      );
    }
    const runs = [],
      indexRuns = [],
      existingDatabases = {},
      docTexts = new Set(),
      queries = new Set();
    for (const [scope, count, headingFile] of scopes) {
      const ds = datasets.get(scope);
      texts(ds.data).forEach((t) => queries.add(t));
      let canonical = null;
      for (const arm of choice.arms) {
        const heading = await get(path.join(lab, headingFile)),
          parsedHeading = await loadConfig(path.join(lab, headingFile));
        let original = heading,
          originDir = lab,
          createIndex = false,
          db = parsedHeading.database;
        if (arm.strategy === 'markdown-structure-v1') {
          const oldScope = reusableDevelopmentScope(scope);
          const ref = old.runs.find(
            (r) => r.scope === oldScope && r.strategy === arm.strategy,
          );
          if (ref) {
            original = await get(ref.configPath);
            originDir = path.dirname(ref.configPath);
            db = (await loadConfig(ref.configPath)).database;
          } else {
            original = await get(
              old.runs.find((r) => r.strategy === arm.strategy).configPath,
            );
            originDir = path.dirname(
              old.runs.find((r) => r.strategy === arm.strategy).configPath,
            );
            db = path.join(
              lab,
              '.echo',
              values['run-id'],
              scope === 'paired-test' ? 'mixed-test.sqlite' : scope + '.sqlite',
            );
            createIndex = scope !== 'paired-test';
          }
        }
        const sourceFile = path.join(
          root,
          'configs',
          scope + '-' + arm.id + '-sources.json',
        );
        await fs.writeFile(
          sourceFile,
          json({ collections: parsedHeading.collections }),
          { flag: 'wx' },
        );
        const clone = {
          ...original,
          database: db,
          sources: sourceFile,
          active: {
            ...original.active,
            chunker: arm.strategy,
            retrieval: 'final-fixed',
          },
          runtime: path.resolve(originDir, original.runtime),
          logging: path.resolve(originDir, original.logging),
          directories: {
            ...Object.fromEntries(
              Object.entries(original.directories).map(([k, v]) => [
                k,
                path.resolve(originDir, v),
              ]),
            ),
            retrieval: path.join(root, 'retrieval', arm.id),
          },
        };
        const configPath = path.join(
          root,
          'configs',
          scope + '-' + arm.id + '.json',
        );
        await fs.writeFile(configPath, json(clone), { flag: 'wx' });
        const c = await loadConfig(configPath);
        const common = {
          embedding: c.embedding,
          collections: c.collections,
          runtime: c.runtime,
          tokenizer: c.profile.tokenizer.fingerprint,
        };
        if (canonical) assert.deepEqual(common, canonical);
        else canonical = common;
        const item = {
          ...arm,
          scope,
          parents: count,
          paired: scope === 'paired-test',
          configPath,
          config_sha256: await digest(configPath),
          config_revision: c.profile.revision,
          chunker_fingerprint: c.profile.chunker.fingerprint,
          tokenizer_fingerprint: c.profile.tokenizer.fingerprint,
          datasetPath: ds.file,
          dataset_sha256: ds.sha256,
          outputName: scope + '-' + arm.id,
          logical_requests: arm.mode === 'bm25' ? 0 : texts(ds.data).length,
          new_index:
            arm.strategy === 'markdown-structure-v1' &&
            ['D-test', 'mixed-test', 'paired-test'].includes(scope),
        };
        await verify(item, { ready: !item.new_index });
        if (!item.new_index)
          existingDatabases[c.database] = await digest(c.database);
        if (createIndex && arm.mode === 'hybrid') {
          const chunks = await chunkTexts(c, ds.data, configPath);
          chunks.forEach((t) => docTexts.add(t));
          indexRuns.push({ ...item, chunks: chunks.length });
        }
        runs.push(item);
      }
    }
    assert.deepEqual(
      indexRuns.map((r) => r.scope),
      ['D-test', 'mixed-test'],
    );
    const missing = [];
    for (const t of docTexts) if (!(await cached(t))) missing.push(t);
    const queryCaps = {
      requests: queries.size,
      input_chars: [...queries].reduce((n, t) => n + t.length, 0),
    };
    assert.ok(queryCaps.requests <= 3000 && queryCaps.input_chars <= 200000);
    const primary = scopes
      .slice(0, 5)
      .flatMap(([s]) => datasets.get(s).data.questions);
    const plan = {
      status: 'prepared',
      created_at: new Date().toISOString(),
      selection_sha256: choiceHash,
      bundle_sha256: bundleHash,
      code,
      runtime: sourceManifest.runtime,
      arms: choice.arms,
      retrieval: choice.retrieval,
      model: choice.model,
      dimensions: 1024,
      endpoint,
      runs,
      indexRuns,
      existingDatabases,
      primary_questions: 200,
      paired_existing_questions: 40,
      primary_parent_executions: 800,
      paired_parent_executions: 160,
      answerable: primary.filter((q) => !q.no_answer).length,
      no_answer: primary.filter((q) => q.no_answer).length,
      facts: primary.reduce((n, q) => n + q.required_facts.length, 0),
      intent_groups: new Set(primary.map((q) => q.intent_group)).size,
      split_parents: primary.filter((q) => q.subquestions?.length).length,
      fixed_subquestions: primary.reduce(
        (n, q) => n + (q.subquestions?.length ?? 0),
        0,
      ),
      query_caps: queryCaps,
      logical_query_replays: runs.reduce((n, r) => n + r.logical_requests, 0),
      document_caps: {
        requests: missing.length,
        input_chars: missing.reduce((n, t) => n + t.length, 0),
      },
      documents: {
        unique_texts: docTexts.size,
        missing_texts: missing.length,
        missing_chars: missing.reduce((n, t) => n + t.length, 0),
      },
      authorization: choice.authorization,
      labels:
        'Original frozen final labels unchanged; no development amendments.',
    };
    await fs.writeFile(path.join(root, 'plan.json'), json(plan), {
      flag: 'wx',
    });
    console.log(
      json({
        root,
        questions: 200,
        paired: 40,
        answerable: plan.answerable,
        facts: plan.facts,
        intent_groups: plan.intent_groups,
        documents: plan.documents,
        document_caps: plan.document_caps,
        query_caps: queryCaps,
        logical_replays: plan.logical_query_replays,
      }),
    );
    return;
  }
  const plan = await get(path.join(root, 'plan.json'));
  assert.deepEqual(plan.code, code);
  assert.equal(plan.selection_sha256, choiceHash);
  for (const [file, sha] of Object.entries(plan.existingDatabases))
    assert.equal(await digest(file), sha);
  for (const item of plan.runs)
    await verify(item, { ready: values.phase !== 'index' || !item.new_index });
  const originalFetch = globalThis.fetch;
  if (values.phase === 'index') {
    const dir = path.join(root, 'index');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'network-attempts.jsonl'), '', {
      flag: 'wx',
    });
    const allowed = new Set();
    for (const item of plan.indexRuns)
      for (const t of await chunkTexts(
        await loadConfig(item.configPath),
        datasets.get(item.scope).data,
        item.configPath,
      ))
        allowed.add(t);
    const guard = createQueryFetchGuard({
      fetchFn: originalFetch,
      endpoint,
      allowedTexts: allowed,
      caps: plan.document_caps,
      onAttempt: (e) =>
        fs.appendFile(
          path.join(dir, 'network-attempts.jsonl'),
          JSON.stringify(e) + '\n',
        ),
    });
    globalThis.fetch = guard.fetch;
    const first = await loadConfig(plan.indexRuns[0].configPath),
      base = createEmbeddingProvider(first.embedding),
      rows = [];
    let cacheHits = 0;
    const provider = {
      fingerprint: base.fingerprint,
      dimensions: base.dimensions,
      async embed(input, purpose, signal) {
        assert.equal(purpose, 'document');
        const values = new Map(),
          need = [];
        for (const t of new Set(input)) {
          const v = await cached(t);
          if (v) {
            values.set(t, v);
            cacheHits++;
          } else need.push(t);
        }
        if (need.length) {
          const vectors = await base.embed(need, purpose, signal);
          validateVectors(vectors, need.length, 1024);
          for (const [i, t] of need.entries()) {
            const vector = vectors[i],
              file = path.join(cacheFolder, cacheKey(t) + '.json'),
              tmp = file + '.tmp-' + randomUUID();
            await fs.writeFile(
              tmp,
              json({
                fingerprint,
                dimensions: 1024,
                input_sha256: hash(t),
                vector_sha256: hash(JSON.stringify(vector)),
                vector,
              }),
              { flag: 'wx' },
            );
            try {
              await fs.link(tmp, file);
            } finally {
              await fs.unlink(tmp);
            }
            values.set(t, vector);
          }
        }
        return input.map((t) => values.get(t));
      },
    };
    try {
      for (const item of plan.indexRuns) {
        const c = await loadConfig(item.configPath);
        await fs.mkdir(path.dirname(c.database), { recursive: true });
        // Fresh output only. Never retry into an existing index automatically.
        try {
          await fs.access(c.database);
          throw new Error('New index already exists');
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        const result = await syncIndex(c, undefined, provider);
        assert.equal(result.wrote_ids, 0);
        assert.equal(result.chunks, item.chunks);
        assert.ok(status(c).ready);
        assert.deepEqual(
          normalized(await snapshotRetrievalCorpus(item.configPath)),
          normalized(datasets.get(item.scope).data.corpus),
        );
        rows.push({
          scope: item.scope,
          result,
          database_sha256: await digest(c.database),
        });
        await fs.appendFile(
          path.join(dir, 'rows.jsonl'),
          JSON.stringify(rows.at(-1)) + '\n',
        );
        console.log(
          JSON.stringify({
            scope: item.scope,
            chunks: result.chunks,
            api: base.usage(),
            cacheHits,
          }),
        );
      }
      assert.equal(base.usage().requests, guard.stats().requests);
      const databases = { ...plan.existingDatabases };
      for (const item of plan.indexRuns) {
        const c = await loadConfig(item.configPath);
        databases[c.database] = await digest(c.database);
      }
      for (const [file, sha] of Object.entries(plan.existingDatabases))
        assert.equal(await digest(file), sha);
      await fs.writeFile(
        path.join(dir, 'report.json'),
        json({
          status: 'complete',
          rows,
          databases,
          usage: base.usage(),
          network: guard.stats(),
          cacheHits,
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
          rows,
          usage: base.usage(),
          network: guard.stats(),
        }),
        { flag: 'wx' },
      );
      throw error;
    } finally {
      base.dispose?.();
      globalThis.fetch = originalFetch;
    }
    return;
  }
  const indexed = await get(path.join(root, 'index/report.json'));
  assert.equal(indexed.status, 'complete');
  for (const [file, sha] of Object.entries(indexed.databases))
    assert.equal(await digest(file), sha);
  const allowed = new Set([...datasets.values()].flatMap((x) => texts(x.data)));
  const validate = (p, n) => {
    assert.equal(p.data.length, n);
    assert.deepEqual(
      p.data.map((x) => x.index),
      [0],
    );
    validateVectors(
      p.data.map((x) => x.embedding),
      n,
      1024,
    );
  };
  if (values.phase === 'capture') {
    const dir = path.join(root, 'capture');
    await fs.mkdir(dir);
    await fs.mkdir(path.join(dir, 'responses'));
    await fs.writeFile(path.join(dir, 'network-attempts.jsonl'), '', {
      flag: 'wx',
    });
    const guard = createQueryFetchGuard({
      fetchFn: originalFetch,
      endpoint,
      allowedTexts: allowed,
      caps: plan.query_caps,
      onAttempt: (e) =>
        fs.appendFile(
          path.join(dir, 'network-attempts.jsonl'),
          JSON.stringify(e) + '\n',
        ),
    });
    const memo = frozenQueryFetch({
      fetchFn: guard.fetch,
      endpoint,
      model: plan.model,
      dimensions: 1024,
      validate,
      onCapture: (e) =>
        fs.writeFile(path.join(dir, 'responses', e.key + '.json'), json(e), {
          flag: 'wx',
        }),
      onUse: (e) =>
        fs.appendFile(
          path.join(dir, 'vector-uses.jsonl'),
          JSON.stringify(e) + '\n',
        ),
    });
    globalThis.fetch = memo.forRun('capture', allowed);
    const c = await loadConfig(plan.runs[0].configPath),
      base = createEmbeddingProvider(c.embedding);
    try {
      for (const [i, t] of [...allowed].entries()) {
        await base.embed([t], 'query');
        if ((i + 1) % 25 === 0)
          console.log(JSON.stringify({ captured: i + 1, total: allowed.size }));
      }
      assert.equal(memo.stats().network_requests, allowed.size);
      assert.equal(guard.stats().requests, allowed.size);
      const hashes = [];
      for (const f of await fs.readdir(path.join(dir, 'responses')))
        hashes.push({
          file: f,
          sha256: await digest(path.join(dir, 'responses', f)),
        });
      await fs.writeFile(
        path.join(dir, 'report.json'),
        json({
          status: 'complete',
          replay: memo.stats(),
          network: guard.stats(),
          usage: base.usage(),
          response_hashes: hashes,
          plan_sha256: await digest(path.join(root, 'plan.json')),
        }),
        { flag: 'wx' },
      );
      console.log(
        json({ status: 'complete', phase: 'capture', usage: base.usage() }),
      );
    } catch (error) {
      await fs.writeFile(
        path.join(dir, 'failure.json'),
        json({
          status: 'failed',
          error: error.message,
          replay: memo.stats(),
          usage: base.usage(),
          network: guard.stats(),
        }),
        { flag: 'wx' },
      );
      throw error;
    } finally {
      base.dispose?.();
      globalThis.fetch = originalFetch;
    }
    return;
  }
  const capture = await get(path.join(root, 'capture/report.json'));
  assert.equal(capture.status, 'complete');
  const seeds = [];
  for (const f of capture.response_hashes) {
    const file = path.join(root, 'capture/responses', f.file);
    assert.equal(await digest(file), f.sha256);
    seeds.push(await get(file));
  }
  const dir = path.join(root, 'queries');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'network-attempts.jsonl'), '', {
    flag: 'wx',
  });
  await fs.writeFile(path.join(dir, 'vector-uses.jsonl'), '', { flag: 'wx' });
  const memo = frozenQueryFetch({
    fetchFn: async () => {
      throw Error('Network forbidden during comparisons');
    },
    endpoint,
    model: plan.model,
    dimensions: 1024,
    seeds,
    offlineOnly: true,
    validate,
    onUse: (e) =>
      fs.appendFile(
        path.join(dir, 'vector-uses.jsonl'),
        JSON.stringify(e) + '\n',
      ),
  });
  const completed = [];
  try {
    for (const item of plan.runs) {
      const c = await verify(item);
      globalThis.fetch =
        item.mode === 'bm25'
          ? async () => {
              throw Error('BM25 cannot request embedding');
            }
          : memo.forRun(
              item.outputName,
              new Set(texts(datasets.get(item.scope).data)),
            );
      process.env[c.embedding.api_key_env] ||= 'offline-replay-no-network';
      const before = memo.stats().logical_requests;
      const run = await runRetrievalEvaluation({
        configPath: item.configPath,
        datasetPath: item.datasetPath,
        outputDir: path.join(dir, item.outputName),
        budgetChars: 16000,
        maxApiCalls: item.logical_requests,
      });
      assert.equal(run.report.status, 'complete');
      assert.equal(run.report.rows.length, item.parents);
      assert.equal(
        memo.stats().logical_requests - before,
        item.logical_requests,
      );
      for (const row of run.report.rows) {
        assert.ok(['ok', 'empty'].includes(row.status));
        assert.ok(row.context_chars <= 16000);
        assert.ok(row.result.results.length <= 10);
        const counts = new Map();
        for (const p of row.result.results)
          counts.set(p.source_id, (counts.get(p.source_id) ?? 0) + 1);
        assert.ok([...counts.values()].every((n) => n <= 3));
      }
      completed.push({
        scope: item.scope,
        arm: item.id,
        parents: item.parents,
      });
      await fs.appendFile(
        path.join(dir, 'completed-runs.jsonl'),
        JSON.stringify(completed.at(-1)) + '\n',
      );
      console.log(JSON.stringify(completed.at(-1)));
    }
    assert.equal(memo.stats().network_requests, 0);
    assert.equal(memo.stats().logical_requests, plan.logical_query_replays);
    for (const [file, sha] of Object.entries(indexed.databases))
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
        error: error.message,
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
