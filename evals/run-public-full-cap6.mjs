import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../dist/database.js';
import {
  arms,
  createPublicProvider,
  discoverTables,
  loadPublicQueries,
  makeEmbeddingConfig,
  publicPaths,
  publicQueryId,
  publicQueryText,
  runPublicRankingScope,
  runQasper,
  setArmIdsForExternal,
} from './run-minisearch-parameter-exploration.mjs';

const PUBLIC_SCOPES = ['langchain', 'godot', 'du', 'qasper'];
const ARM_IDS = ['public-A', 'public-B'];
const EXPECTED = { langchain: 203, godot: 99, du: 2000, qasper: 1005 };
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const scriptPath = fileURLToPath(import.meta.url);

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const compact = (value) => JSON.stringify(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function shaFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readJsonLines(file) {
  const rows = [];
  let pending = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) rows.push(JSON.parse(line));
    }
  }
  if (pending.trim()) rows.push(JSON.parse(pending));
  return rows;
}

async function writeJson(file, value) {
  await fs.writeFile(file, json(value), { flag: 'wx' });
}

function sourceFiles(root, scope) {
  const paths = publicPaths(root, scope);
  return {
    ...paths,
    ...(scope === 'qasper'
      ? {}
      : {
          corpus: paths.corpus,
        }),
  };
}

async function cohortFreeze(root, scope) {
  const paths = sourceFiles(root, scope);
  const queryRows = await readJsonLines(paths.queries);
  const ids = queryRows.map((row) => publicQueryId(scope, row));
  assert.equal(
    new Set(ids).size,
    ids.length,
    'duplicate full query IDs in ' + scope,
  );
  assert.equal(
    ids.length,
    EXPECTED[scope],
    'unexpected ' + scope + ' denominator',
  );
  const inputs = queryRows.map((row) => ({
    id: publicQueryId(scope, row),
    text: publicQueryText(scope, row),
  }));
  const database = openDatabase(paths.db, { readOnly: true });
  const tables = discoverTables(database);
  database.close();
  const cohort = {
    population: ids.length,
    sample: ids.length,
    ids,
    input_sha256: digest(compact(inputs)),
    database: paths.db,
    database_sha256: await shaFile(paths.db),
    tables,
    table_counts: tables.counts,
    query_file: paths.queries,
    query_file_sha256: await shaFile(paths.queries),
  };
  if (scope === 'qasper') {
    cohort.docs_file = paths.docs;
    cohort.docs_file_sha256 = await shaFile(paths.docs);
  } else {
    cohort.corpus_file = paths.corpus;
    cohort.corpus_file_sha256 = await shaFile(paths.corpus);
  }
  return cohort;
}

async function vectorFreeze(root) {
  const planFile = path.join(root, 'embedding-plan.json');
  const vectorFile = path.join(root, 'vectors.sqlite');
  const plan = await readJson(planFile);
  const stat = await fs.stat(vectorFile);
  const db = openDatabase(vectorFile, { readOnly: true });
  const entries = db.prepare('SELECT count(*) AS n FROM entries').get().n;
  db.close();
  return {
    plan,
    plan_file: planFile,
    plan_sha256: await shaFile(planFile),
    cache: vectorFile,
    cache_stat: {
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      entries,
    },
    cache_sha256: await shaFile(vectorFile),
  };
}

async function buildFreeze(privateRoot, publicRoot, out) {
  await fs.stat(privateRoot);
  const vectors = await vectorFreeze(publicRoot);
  const embedding = makeEmbeddingConfig(vectors.plan.config);
  const sourceFreeze = {};
  for (const scope of PUBLIC_SCOPES)
    sourceFreeze[scope] = await cohortFreeze(publicRoot, scope);
  const distNames = [
    'config.js',
    'database.js',
    'embedding.js',
    'lexical.js',
    'minisearch.js',
    'retrieval.js',
    'store.js',
  ];
  const dist = {};
  for (const name of distNames)
    dist[name] = await shaFile(path.join(repoRoot, 'dist', name));
  const freeze = {
    status: 'frozen',
    created_at: new Date().toISOString(),
    experiment: '2026-09-22-cap6-public-full-v2',
    supersedes:
      '2026-09-22-cap6-public-full-v1 freeze-only attempt; stopped before any scope output after audit correction',
    scope: 'public full only; two primary hybrid conditions',
    arms: Object.fromEntries(ARM_IDS.map((id) => [id, arms[id]])),
    fixed: {
      chunker:
        'markdown-structure-v1@1.0.1 for QASPER; official fixed units unchanged for FreshStack/Du',
      lexical_engine:
        'MiniSearch 7.2.0; query-term coverage multiplier disabled',
      tokenizer: 'ICU zh-CN with existing expansion chain',
      model: embedding.model,
      dimensions: embedding.dimensions,
      bm25_candidates: 60,
      dense_candidates: 60,
      title_weight: 2,
      min_dense_similarity: 0.3,
      topk: 10,
      max_chunks_per_source: 6,
      max_context_chars_utf16: 20000,
      rerank: false,
      mmr: false,
      qasper_filter: 'known target paper source UUID per question',
      qasper_input: 'original complete question; no answer/nugget rewrite',
      fixed_input:
        'original official query; no Echo rechunking, product cap, or JSON budget',
    },
    denominators: {
      total_questions: 3307,
      executions: 6614,
      scopes: { langchain: 203, godot: 99, du: 2000, qasper: 1005 },
      qasper_strict_text: 800,
      qasper_all_annotated: 1005,
      qasper_all_annotation_unanswerable: 60,
    },
    private_reference: {
      root: privateRoot,
      role: 'personal 200-question results are a separate comparison only; not in public totals',
    },
    public: {
      root: publicRoot,
      source_freeze: { cohorts: sourceFreeze },
      vectors: {
        plan_file: vectors.plan_file,
        plan_sha256: vectors.plan_sha256,
        cache: vectors.cache,
        cache_stat: vectors.cache_stat,
        cache_sha256: vectors.cache_sha256,
      },
    },
    code: {
      runner: await shaFile(scriptPath),
      shared_core: await shaFile(
        path.join(
          repoRoot,
          'evals',
          'run-minisearch-parameter-exploration.mjs',
        ),
      ),
      dist,
    },
    environment: {
      node: process.version,
      icu: process.versions.icu,
      platform: process.platform,
    },
    constraints: [
      'Only public full cohorts are run in this output; no private questions or historical 1/10 sample cohort.',
      'Only public-A and public-B hybrid are primary conditions; lane exports are diagnostic support for the two fusions.',
      'No API/network calls; all query and document vectors are read from the frozen public cache.',
      'Do not modify product defaults, source notes, old Chroma/SQLite, old caches, or old experiment outputs.',
      'Public full results are opened data already inspected; they are not a blind held-out evaluation.',
    ],
  };
  await fs.mkdir(out, { recursive: false });
  await writeJson(path.join(out, 'freeze.json'), freeze);
  return freeze;
}

async function verifyFreeze(freeze, publicRoot) {
  assert.equal(path.resolve(freeze.public.root), path.resolve(publicRoot));
  assert.deepEqual(
    freeze.arms,
    Object.fromEntries(ARM_IDS.map((id) => [id, arms[id]])),
  );
  assert.equal(await shaFile(scriptPath), freeze.code.runner);
  assert.equal(
    await shaFile(
      path.join(repoRoot, 'evals', 'run-minisearch-parameter-exploration.mjs'),
    ),
    freeze.code.shared_core,
  );
  for (const [name, expected] of Object.entries(freeze.code.dist))
    assert.equal(await shaFile(path.join(repoRoot, 'dist', name)), expected);
  for (const cohort of Object.values(freeze.public.source_freeze.cohorts)) {
    assert.equal(await shaFile(cohort.database), cohort.database_sha256);
    assert.equal(await shaFile(cohort.query_file), cohort.query_file_sha256);
    if (cohort.corpus_file)
      assert.equal(
        await shaFile(cohort.corpus_file),
        cohort.corpus_file_sha256,
      );
    if (cohort.docs_file)
      assert.equal(await shaFile(cohort.docs_file), cohort.docs_file_sha256);
  }
  assert.equal(
    await shaFile(freeze.public.vectors.plan_file),
    freeze.public.vectors.plan_sha256,
  );
  const stat = await fs.stat(freeze.public.vectors.cache);
  assert.equal(stat.size, freeze.public.vectors.cache_stat.size);
  assert.equal(stat.mtimeMs, freeze.public.vectors.cache_stat.mtime_ms);
  assert.equal(
    await shaFile(freeze.public.vectors.cache),
    freeze.public.vectors.cache_sha256,
  );
}

async function runAll(publicRoot, out, freeze) {
  setArmIdsForExternal(ARM_IDS);
  const plan = await readJson(freeze.public.vectors.plan_file);
  assert.equal(freeze.arms['public-A'].retrieval.max_context_chars, 20000);
  assert.equal(freeze.arms['public-B'].retrieval.max_context_chars, 20000);
  const embedding = makeEmbeddingConfig(plan.config);
  assert.equal(embedding.model, 'qwen3.7-text-embedding');
  const vectorDb = openDatabase(freeze.public.vectors.cache, {
    readOnly: true,
  });
  const provider = createPublicProvider(vectorDb, plan.fingerprint);
  const results = {};
  for (const scope of PUBLIC_SCOPES) {
    const queries = await loadPublicQueries(
      publicRoot,
      scope,
      freeze.public.source_freeze,
    );
    console.log(
      JSON.stringify({
        status: 'scope-start',
        scope,
        questions: queries.length,
      }),
    );
    if (scope === 'qasper') {
      results[scope] = await runQasper({
        root: publicRoot,
        out,
        queries,
        provider,
        embedding,
        selection: {
          chunker: 'markdown-structure-v1',
          tokenizer: 'icu-zh',
          embedding: 'qwen',
          retrieval: 'rrf10',
        },
        mode: 'public-full',
      });
    } else {
      results[scope] = await runPublicRankingScope({
        root: publicRoot,
        out,
        scope,
        queries,
        provider,
        embedding,
        selection: {
          chunker: 'public-fixed',
          tokenizer: 'icu-zh',
          embedding: 'qwen3.7-text-embedding',
          retrieval: 'public-full-cap6',
        },
        mode: 'public-full',
      });
    }
    console.log(
      JSON.stringify({
        status: 'scope-complete',
        scope,
        questions: queries.length,
      }),
    );
  }
  vectorDb.close();
  await writeJson(path.join(out, 'scope-results.json'), results);
  return results;
}

async function main() {
  const [privateRoot, publicRoot, outArg, mode = 'freeze'] =
    process.argv.slice(2);
  assert.ok(
    privateRoot && publicRoot && outArg,
    'Usage: node evals/run-public-full-cap6.mjs PRIVATE_ROOT PUBLIC_ROOT OUT [freeze|run]',
  );
  const out = path.resolve(outArg);
  if (mode === 'freeze') {
    assert.ok(!(await fs.stat(out).catch(() => null)), 'Output exists');
    const freeze = await buildFreeze(
      path.resolve(privateRoot),
      path.resolve(publicRoot),
      out,
    );
    console.log(
      JSON.stringify({
        status: 'frozen',
        output: out,
        arms: ARM_IDS,
        questions: freeze.denominators.total_questions,
      }),
    );
    return;
  }
  assert.equal(mode, 'run');
  globalThis.fetch = async () => {
    throw new Error('Network forbidden in public full replay');
  };
  const freeze = await readJson(path.join(out, 'freeze.json'));
  assert.deepEqual(Object.keys(freeze.arms), ARM_IDS);
  const publicRootResolved = path.resolve(publicRoot);
  await verifyFreeze(freeze, publicRootResolved);
  const results = await runAll(publicRootResolved, out, freeze);
  const before = Object.fromEntries(
    Object.entries(freeze.public.source_freeze.cohorts).map(
      ([scope, cohort]) => [scope, cohort.database_sha256],
    ),
  );
  const after = Object.fromEntries(
    Object.entries(freeze.public.source_freeze.cohorts).map(
      ([scope, cohort]) => [scope, shaFile(cohort.database)],
    ),
  );
  const afterResolved = Object.fromEntries(
    await Promise.all(
      Object.entries(after).map(async ([scope, promise]) => [
        scope,
        await promise,
      ]),
    ),
  );
  assert.deepEqual(afterResolved, before);
  const vectorStat = await fs.stat(freeze.public.vectors.cache);
  assert.equal(vectorStat.size, freeze.public.vectors.cache_stat.size);
  assert.equal(vectorStat.mtimeMs, freeze.public.vectors.cache_stat.mtime_ms);
  assert.equal(
    await shaFile(freeze.public.vectors.cache),
    freeze.public.vectors.cache_sha256,
  );
  await verifyFreeze(freeze, publicRootResolved);
  await writeJson(path.join(out, 'run-receipt.json'), {
    status: 'complete',
    created_at: new Date().toISOString(),
    mode: 'public-full-cap6',
    arms: ARM_IDS,
    questions: freeze.denominators.total_questions,
    executions: freeze.denominators.executions,
    scopes: PUBLIC_SCOPES,
    results,
    before_database_sha256: before,
    after_database_sha256: afterResolved,
    unchanged_inputs: true,
    vector_cache_sha256: freeze.public.vectors.cache_sha256,
    new_embedding_calls: 0,
    network: 'forbidden; frozen-cache-only provider',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath)
  await main();
