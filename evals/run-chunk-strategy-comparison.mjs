import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';

const { values } = parseArgs({
  options: {
    lab: { type: 'string' },
    phase: { type: 'string' },
    'run-id': { type: 'string' },
    candidate: { type: 'string' },
  },
});
assert(
  values.lab && values.phase && /^[a-z0-9-]+$/.test(values['run-id'] ?? ''),
  'Require --lab LAB --phase prepare|index|queries|compare --run-id NAME; prepare also needs --candidate FILE',
);
const lab = path.resolve(values.lab),
  out = path.join(lab, 'evidence', values['run-id']);
const hash = (x) => createHash('sha256').update(x).digest('hex');
const json = (x) => JSON.stringify(x, null, 2) + '\n';
const get = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const byteHash = async (p) => hash(await fs.readFile(p));
const runtime = path.join(lab, 'echo-runtime-b454686/dist');
const mod = (p) => import(pathToFileURL(path.join(runtime, p)).href);
const { loadConfig } = await mod('config.js');
const { parseSource } = await mod('identity.js');
const { profileChunker } = await mod('profiles.js');
const { runChunker } = await mod('chunker.js');
const { syncIndex } = await mod('sync.js');
const { openDatabase } = await mod('database.js');
const { profileStatus } = await mod('profile-store.js');
const { createEmbeddingProvider, embeddingFingerprint, validateVectors } =
  await mod('embedding.js');
const { snapshotRetrievalCorpus, runRetrievalEvaluation } = await mod(
  'retrieval-evaluation.js',
);
const { createQueryFetchGuard } = await import(
  pathToFileURL(path.join(lab, 'query-fetch-guard.mjs')).href
);
const endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const fingerprint =
  '2e6e9f07b732465d9a61d6336eb9901ccb3f525d8c626e294c8554ccc00c36c0';
const strategies = [
  'heading-1000',
  'bagu-paragraph-800-lines',
  'markdown-structure-v1',
];
const retrieval = {
  id: 'chunk-fixed',
  mode: 'hybrid',
  topk: 10,
  max_chunks_per_source: 3,
  bm25_candidates: 60,
  dense_candidates: 60,
  rrf_k: 60,
  title_weight: 2,
  bm25_weight: 0.5,
  dense_weight: 1,
  min_dense_similarity: 0.3,
  max_context_chars: 12000,
};
const scopes = [
  {
    id: 'A-development',
    count: 30,
    files: [
      'echo-heading-1000.config.json',
      'echo-bagu-paragraph-800-lines.config.json',
    ],
  },
  {
    id: 'B-development',
    count: 25,
    files: [
      'echo-B-heading-1000.config.json',
      'echo-B-bagu-paragraph-800-lines.config.json',
    ],
  },
  {
    id: 'C-development',
    count: 15,
    files: [
      'echo-C-heading-1000-v2.config.json',
      'echo-C-bagu-paragraph-800-lines-v2.config.json',
    ],
  },
  {
    id: 'mixed-development',
    count: 30,
    files: [
      'echo-mixed-development-heading-1000-v2.config.json',
      'echo-mixed-development-bagu-paragraph-800-lines-v2.config.json',
    ],
  },
];
const bundlePath = path.join(
  lab,
  'evidence/frozen-evaluation-2026-09-16-v1/manifest.json',
);
const bundleHash =
  'e8df0296b50c522c5f2738e69aa9a82f881f8955e4070b4d8350c063b12d2565';
const currentScriptHash = await byteHash(fileURLToPath(import.meta.url));
const currentGuardHash = await byteHash(
  path.join(lab, 'query-fetch-guard.mjs'),
);
const sortCorpus = (rows) =>
  [...rows].sort((a, b) =>
    JSON.stringify([a.collection_id, a.path]).localeCompare(
      JSON.stringify([b.collection_id, b.path]),
    ),
  );
const corpusEqual = (a, b) => assert.deepEqual(sortCorpus(a), sortCorpus(b));
const queryTexts = (data) => [
  ...new Set(
    data.questions.flatMap((q) =>
      q.subquestions?.length
        ? q.subquestions.map((s) => s.text.trim())
        : [q.query.trim()],
    ),
  ),
];
function ready(config) {
  const db = openDatabase(config.database, { readOnly: true });
  try {
    return profileStatus(db, config).ready;
  } finally {
    db.close();
  }
}
function checkConfig(config) {
  for (const [k, v] of Object.entries(retrieval))
    if (k !== 'id') assert.equal(config.retrieval[k], v, k);
  assert.equal(embeddingFingerprint(config.embedding), fingerprint);
  assert.equal(config.embedding.batch_size, 8);
  assert.equal(config.embedding.timeout_ms, 30000);
  assert.equal(config.embedding.query_prefix, '');
  assert.equal(config.embedding.document_prefix, '');
}
async function dataset(scope) {
  assert.equal(await byteHash(bundlePath), bundleHash);
  const bundle = await get(bundlePath),
    entry = bundle.files.find((e) => e.scope === scope);
  assert(entry && entry.split === 'development');
  const file = path.join(path.dirname(bundlePath), entry.file);
  assert.equal(await byteHash(file), entry.sha256);
  const data = await get(file);
  assert.equal(data.split, 'development');
  return { data, file, sha256: entry.sha256 };
}
async function candidateTexts(config, data) {
  corpusEqual(
    await snapshotRetrievalCorpus(config.profile.configPath ?? config.__path),
    data.corpus,
  );
  const chunks = [],
    strategy = await profileChunker(config.profile.chunker);
  const roots = new Map(config.collections.map((c) => [c.id, c.root]));
  for (const entry of data.corpus) {
    const file = path.resolve(roots.get(entry.collection_id), entry.path),
      bytes = await fs.readFile(file);
    assert.equal(hash(bytes), entry.sha256);
    const parsed = parseSource(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    assert(parsed.sourceId);
    const lines = parsed.lines
      .map((text, i) => ({ text, number: i + 1 }))
      .filter((l) => l.number > parsed.frontmatterEnd + 1);
    const ranges = await runChunker(strategy, {
      sourceId: parsed.sourceId,
      path: file,
      lines,
      options: {},
    });
    for (const l of lines.filter((l) => l.text.trim()))
      assert(
        ranges.some((r) => r.startLine <= l.number && r.endLine >= l.number),
        'Lost original line',
      );
    for (const r of ranges) {
      assert(
        r.text.length <= 1500 || r.startLine === r.endLine,
        'Oversized multi-line chunk',
      );
      chunks.push({
        text: [path.basename(file, '.md'), ...r.headingPath, r.text].join('\n'),
        chars: r.text.length,
      });
    }
  }
  return chunks;
}
const cacheFolder = path.join(lab, '.echo/document-vector-cache', fingerprint);
const cacheKey = (text) =>
  hash(JSON.stringify([fingerprint, 'document', text]));
async function cachedVector(text) {
  try {
    const row = await get(path.join(cacheFolder, cacheKey(text) + '.json'));
    assert.equal(row.fingerprint, fingerprint);
    assert.equal(row.input_sha256, hash(text));
    assert.equal(row.dimensions, 1024);
    assert.equal(row.vector_sha256, hash(JSON.stringify(row.vector)));
    validateVectors([row.vector], 1, 1024);
    return row.vector;
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
}
async function verifyPlan(plan) {
  assert.equal(plan.script_sha256, currentScriptHash);
  assert.equal(plan.guard_sha256, currentGuardHash);
  assert.equal(plan.bundle_sha256, await byteHash(bundlePath));
  for (const item of plan.runs) {
    assert.equal(await byteHash(item.configPath), item.config_sha256);
    const config = await loadConfig(item.configPath);
    checkConfig(config);
    assert.equal(config.profile.revision, item.config_revision);
    assert.equal(config.profile.chunker.fingerprint, item.chunker_fingerprint);
    const d = await dataset(item.scope);
    assert.equal(d.sha256, item.dataset_sha256);
    corpusEqual(await snapshotRetrievalCorpus(item.configPath), d.data.corpus);
  }
}
const originalFetch = globalThis.fetch;
if (values.phase === 'prepare') {
  globalThis.fetch = async () => {
    throw new Error('No network in preparation');
  };
  assert(values.candidate);
  await fs.mkdir(out);
  for (const dir of ['configs', 'sources', 'retrieval', 'chunkers'])
    await fs.mkdir(path.join(out, dir));
  await fs.writeFile(
    path.join(out, 'chunkers/markdown-structure-v1.mjs'),
    await fs.readFile(path.resolve(values.candidate)),
    { flag: 'wx' },
  );
  await fs.writeFile(
    path.join(out, 'retrieval/chunk-fixed.json'),
    json(retrieval),
    { flag: 'wx' },
  );
  const runs = [],
    docTexts = new Set(),
    querySet = new Set();
  let documentRequestUpperBound = 0,
    documentCharacterUpperBound = 0,
    queryCalls = 0,
    queryChars = 0;
  for (const scope of scopes) {
    const d = await dataset(scope.id);
    assert.equal(d.data.questions.length, scope.count);
    const texts = queryTexts(d.data);
    texts.forEach((t) => querySet.add(t));
    for (let i = 0; i < strategies.length; i++) {
      const originalPath = path.join(lab, scope.files[i === 1 ? 1 : 0]);
      const original = await get(originalPath),
        parsed = await loadConfig(originalPath);
      const sourcesFile = path.join(
        out,
        'sources',
        scope.id + '-' + i + '.json',
      );
      await fs.writeFile(
        sourcesFile,
        json({ collections: parsed.collections }),
        { flag: 'wx' },
      );
      const selected = {
        ...original,
        database:
          i < 2
            ? parsed.database
            : path.join(lab, '.echo', values['run-id'], scope.id + '.sqlite'),
        sources: sourcesFile,
        runtime: path.resolve(lab, original.runtime),
        logging: path.resolve(lab, original.logging),
        directories: Object.fromEntries(
          Object.entries(original.directories).map(([k, v]) => [
            k,
            path.resolve(lab, v),
          ]),
        ),
        active: {
          ...original.active,
          chunker: strategies[i],
          retrieval: 'chunk-fixed',
        },
      };
      selected.directories.retrieval = path.join(out, 'retrieval');
      if (i === 2) selected.directories.chunkers = path.join(out, 'chunkers');
      const configPath = path.join(
        out,
        'configs',
        scope.id + '-' + i + '.json',
      );
      await fs.writeFile(configPath, json(selected), { flag: 'wx' });
      const config = await loadConfig(configPath);
      config.__path = configPath;
      checkConfig(config);
      corpusEqual(await snapshotRetrievalCorpus(configPath), d.data.corpus);
      const item = {
        scope: scope.id,
        strategy: strategies[i],
        configPath,
        config_sha256: await byteHash(configPath),
        config_revision: config.profile.revision,
        chunker_fingerprint: config.profile.chunker.fingerprint,
        datasetPath: d.file,
        dataset_sha256: d.sha256,
        parents: scope.count,
        query_requests: texts.length,
        query_chars: texts.reduce((n, t) => n + t.length, 0),
        outputName: scope.id + '-' + i,
      };
      if (i < 2) {
        assert(ready(config), 'Original strategy index must already be ready');
        item.index_reused = true;
      } else {
        const chunks = await candidateTexts(config, d.data);
        item.chunks = chunks.length;
        item.max_chunk_chars = Math.max(...chunks.map((c) => c.chars));
        for (const chunk of chunks) docTexts.add(chunk.text);
        documentRequestUpperBound += Math.ceil(chunks.length / 8);
        documentCharacterUpperBound += chunks.reduce(
          (n, c) => n + c.text.length,
          0,
        );
      }
      runs.push(item);
      queryCalls += item.query_requests;
      queryChars += item.query_chars;
    }
  }
  const missing = [];
  for (const text of docTexts)
    if (!(await cachedVector(text))) missing.push(text);
  const plan = {
    status: 'prepared',
    created_at: new Date().toISOString(),
    script_sha256: currentScriptHash,
    guard_sha256: currentGuardHash,
    bundle_sha256: bundleHash,
    runtime: 'b454686c0a03d842c75a8306df9251348ef1f69b',
    endpoint,
    model: 'qwen3.7-text-embedding',
    dimensions: 1024,
    retrieval,
    strategies,
    parents_per_strategy: 100,
    parent_executions: 300,
    final_queries: 0,
    document_caps: {
      requests: documentRequestUpperBound,
      input_chars: documentCharacterUpperBound,
    },
    documents: {
      unique_texts: docTexts.size,
      missing_texts: missing.length,
      missing_chars: missing.reduce((n, t) => n + t.length, 0),
    },
    query_caps: { requests: queryCalls, input_chars: queryChars },
    runs,
    authorization:
      'User explicitly approved calls required for this three-strategy100 development comparison; no final queries or parameter grid.',
  };
  assert.equal(queryCalls, 405);
  assert.equal(queryChars, 19764);
  await fs.writeFile(path.join(out, 'plan.json'), json(plan), { flag: 'wx' });
  console.log(
    json({
      out,
      documents: plan.documents,
      document_caps: plan.document_caps,
      query_caps: plan.query_caps,
      candidate_chunks: runs
        .filter((r) => r.strategy === strategies[2])
        .map(({ scope, chunks, max_chunk_chars }) => ({
          scope,
          chunks,
          max_chunk_chars,
        })),
      calls: 0,
    }),
  );
} else {
  const plan = await get(path.join(out, 'plan.json'));
  await verifyPlan(plan);
  if (values.phase === 'index') {
    const dir = path.join(out, 'index');
    await fs.mkdir(dir);
    const first = await loadConfig(plan.runs[0].configPath),
      base = createEmbeddingProvider(first.embedding);
    const allowed = new Set(),
      rows = [];
    for (const item of plan.runs.filter((r) => r.strategy === strategies[2])) {
      const config = await loadConfig(item.configPath);
      config.__path = item.configPath;
      for (const c of await candidateTexts(
        config,
        (await dataset(item.scope)).data,
      ))
        allowed.add(c.text);
    }
    const guard = createQueryFetchGuard({
      fetchFn: originalFetch,
      endpoint,
      allowedTexts: allowed,
      caps: plan.document_caps,
      onAttempt: (event) =>
        fs.appendFile(
          path.join(dir, 'network-attempts.jsonl'),
          JSON.stringify(event) + '\n',
        ),
    });
    globalThis.fetch = guard.fetch;
    let cacheHits = 0;
    const provider = {
      fingerprint: base.fingerprint,
      dimensions: base.dimensions,
      async embed(texts, purpose, signal) {
        assert.equal(purpose, 'document');
        const values = new Map(),
          missing = new Map();
        for (const text of texts) {
          if (values.has(text) || missing.has(text)) {
            cacheHits++;
            continue;
          }
          const vector = await cachedVector(text);
          if (vector) {
            values.set(text, vector);
            cacheHits++;
          } else missing.set(text, text);
        }
        const need = [...missing.values()];
        if (need.length) {
          const vectors = await base.embed(need, 'document', signal);
          validateVectors(vectors, need.length, 1024);
          for (let i = 0; i < need.length; i++) {
            const text = need[i],
              vector = vectors[i],
              file = path.join(cacheFolder, cacheKey(text) + '.json');
            const row = {
              fingerprint,
              dimensions: 1024,
              input_sha256: hash(text),
              vector_sha256: hash(JSON.stringify(vector)),
              vector,
            };
            const temporary = file + '.tmp-' + randomUUID();
            await fs.writeFile(temporary, json(row), { flag: 'wx' });
            try {
              await fs.link(temporary, file);
            } finally {
              await fs.unlink(temporary);
            }
            values.set(text, vector);
          }
        }
        return texts.map((t) => values.get(t));
      },
    };
    try {
      for (const item of plan.runs.filter(
        (r) => r.strategy === strategies[2],
      )) {
        const config = await loadConfig(item.configPath),
          before = await snapshotRetrievalCorpus(item.configPath);
        corpusEqual(before, (await dataset(item.scope)).data.corpus);
        const result = await syncIndex(config, undefined, provider);
        assert.equal(result.wrote_ids, 0);
        corpusEqual(await snapshotRetrievalCorpus(item.configPath), before);
        assert(ready(config));
        assert.equal(result.chunks, item.chunks);
        rows.push({
          scope: item.scope,
          strategy: item.strategy,
          result,
          ready: true,
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
      await fs.writeFile(
        path.join(dir, 'report.json'),
        json({
          status: 'complete',
          rows,
          api_usage: base.usage(),
          network: guard.stats(),
          cacheHits,
        }),
        { flag: 'wx' },
      );
    } catch (e) {
      await fs.writeFile(
        path.join(dir, 'failure.json'),
        json({
          status: 'failed',
          error: e.message,
          rows,
          api_usage: base.usage(),
          network: guard.stats(),
          cacheHits,
        }),
        { flag: 'wx' },
      );
      throw e;
    } finally {
      base.dispose?.();
      globalThis.fetch = originalFetch;
    }
  } else if (values.phase === 'queries') {
    assert.equal(
      (await get(path.join(out, 'index/report.json'))).status,
      'complete',
    );
    const dir = path.join(out, 'queries');
    await fs.mkdir(dir);
    const allowed = new Set(),
      rows = [];
    for (const scope of scopes)
      queryTexts((await dataset(scope.id)).data).forEach((t) => allowed.add(t));
    const guard = createQueryFetchGuard({
      fetchFn: originalFetch,
      endpoint,
      allowedTexts: allowed,
      caps: plan.query_caps,
      onAttempt: (event) =>
        fs.appendFile(
          path.join(dir, 'network-attempts.jsonl'),
          JSON.stringify(event) + '\n',
        ),
    });
    globalThis.fetch = guard.fetch;
    try {
      for (const item of plan.runs) {
        assert(ready(await loadConfig(item.configPath)));
        const run = await runRetrievalEvaluation({
          configPath: item.configPath,
          datasetPath: item.datasetPath,
          outputDir: path.join(dir, item.outputName),
          budgetChars: 12000,
          maxApiCalls: item.query_requests,
        });
        assert.equal(run.report.status, 'complete');
        assert.equal(run.report.rows.length, item.parents);
        for (const r of run.report.rows) {
          assert.equal(r.status, 'ok');
          assert(r.context_chars <= 12000);
          assert(r.result.results.length <= 10);
          const counts = new Map();
          for (const e of r.result.results)
            counts.set(e.source_id, (counts.get(e.source_id) ?? 0) + 1);
          assert([...counts.values()].every((n) => n <= 3));
        }
        rows.push({
          scope: item.scope,
          strategy: item.strategy,
          outputName: item.outputName,
          api_usage: run.report.api_usage,
          summary: run.report.summary,
        });
        await fs.appendFile(
          path.join(dir, 'runs.jsonl'),
          JSON.stringify(rows.at(-1)) + '\n',
        );
        console.log(
          JSON.stringify({
            scope: item.scope,
            strategy: item.strategy,
            complete: run.report.summary.complete_evidence,
            cumulative_requests: guard.stats().requests,
          }),
        );
      }
      const usage = {
        requests: rows.reduce((n, r) => n + r.api_usage.requests, 0),
        input_chars: rows.reduce((n, r) => n + r.api_usage.input_chars, 0),
        reported_tokens: rows.every((r) => r.api_usage.reported_tokens !== null)
          ? rows.reduce((n, r) => n + r.api_usage.reported_tokens, 0)
          : null,
      };
      assert.equal(usage.requests, guard.stats().requests);
      assert.equal(usage.input_chars, guard.stats().input_chars);
      await fs.writeFile(
        path.join(dir, 'report.json'),
        json({
          status: 'complete',
          parent_executions: 300,
          final_queries: 0,
          rows,
          api_usage: usage,
          network: guard.stats(),
        }),
        { flag: 'wx' },
      );
    } catch (e) {
      await fs.writeFile(
        path.join(dir, 'failure.json'),
        json({
          status: 'failed',
          error: e.message,
          completed_runs: rows,
          network: guard.stats(),
        }),
        { flag: 'wx' },
      );
      throw e;
    } finally {
      globalThis.fetch = originalFetch;
    }
  } else if (values.phase === 'compare') {
    const report = await get(path.join(out, 'queries/report.json'));
    assert.equal(report.status, 'complete');
    const { writeRetrievalComparison } = await import(
      pathToFileURL(
        path.join(lab, 'echo-runtime-e3c996f/dist/retrieval-comparison.js'),
      ).href
    );
    const dir = path.join(out, 'comparisons');
    await fs.mkdir(dir);
    const comparisons = [];
    for (const scope of scopes)
      for (const [a, b] of [
        [0, 1],
        [0, 2],
        [1, 2],
      ]) {
        const result = await writeRetrievalComparison(
          path.join(out, 'queries', scope.id + '-' + a),
          path.join(out, 'queries', scope.id + '-' + b),
          path.join(dir, scope.id + '-' + a + '-' + b + '.json'),
        );
        comparisons.push({
          scope: scope.id,
          baseline: strategies[a],
          candidate: strategies[b],
          paired: result.paired,
          subquestions: result.subquestions,
        });
      }
    const summary = {
      status: 'complete',
      plan_sha256: await byteHash(path.join(out, 'plan.json')),
      script_sha256: currentScriptHash,
      retrieval,
      corpus_scope: 'frozen A/B/C/mixed development100',
      strategies,
      parent_executions: 300,
      final_queries: 0,
      documents: (await get(path.join(out, 'index/report.json'))).api_usage,
      queries: report.api_usage,
      matrix: report.rows,
      comparisons,
      limits:
        'Whole-strategy comparison at fixed retrieval settings. No final questions, no parameter sweep, no attribution to one internal chunking rule.',
    };
    await fs.writeFile(path.join(dir, 'summary.public.json'), json(summary), {
      flag: 'wx',
    });
    console.log(
      JSON.stringify({
        out: dir,
        comparisons: comparisons.length,
        queries: report.api_usage,
      }),
    );
  } else throw new Error('Unknown phase');
}
