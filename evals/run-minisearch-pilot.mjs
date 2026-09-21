import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { jsonLines } from './prepare-public-benchmarks.mjs';
import { archiveSources } from './lib/public-provenance.mjs';
import {
  runtimeContext,
  boundedRequest,
  qasperScore,
} from './lib/public-runtime.mjs';
import {
  miniArms,
  miniOptions,
  miniRank,
  miniRankWithoutCoverage,
  denseLane,
  splitTerms,
} from './lib/minisearch-pilot.mjs';
import { laneExport, hybridExport, queryTerms } from './lib/lexical-pilot.mjs';

const root = path.resolve(process.argv[2] ?? ''),
  out = path.resolve(process.argv[3] ?? '');
assert.ok(
  process.argv[2] && process.argv[3],
  'Usage: ROOT NEW_OUT [--worker SCOPE]',
);
const relative = path.relative(root, out);
assert.ok(
  relative &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep),
);
globalThis.fetch = async () => {
  throw new Error('Network disabled in MiniSearch pilot');
};
const read = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const write = (name, value) =>
  fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
async function sha(p) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(p)) h.update(chunk);
  return h.digest('hex');
}
const dependency = 'tooling/minisearch-7.2.0';
const miniFile = path.join(
  root,
  dependency,
  'node_modules/minisearch/dist/cjs/index.cjs',
);
const MiniSearch = createRequire(path.join(root, dependency, 'package.json'))(
  'minisearch',
);

async function prepare() {
  const noCoverage = process.argv[4] === '--without-coverage';
  const previous = noCoverage ? process.argv[5] : null;
  if (noCoverage) {
    assert.ok(previous, 'Pass previous frozen output relative to ROOT');
    const rel = path.relative(root, path.resolve(root, previous));
    assert.ok(
      rel &&
        !path.isAbsolute(rel) &&
        rel !== '..' &&
        !rel.startsWith('..' + path.sep),
    );
    assert.notEqual(path.resolve(root, previous), out);
  }
  await fs.mkdir(out);
  const known = new Map(),
    manifestHashes = {};
  for (const name of [
    'public-full-results',
    'public-mode-contrast',
    'bm25-weight-pilot',
    'qasper-weight-pilot',
  ]) {
    const file = 'docs/evals/2026-09-20-' + name + '.manifest.json';
    const m = await read(file);
    manifestHashes[file] = await sha(file);
    for (const a of m.artifacts) known.set(a.file, a.sha256);
  }
  if (noCoverage) {
    const file = 'docs/evals/2026-09-20-minisearch-pilot.manifest.json';
    const m = await read(file);
    manifestHashes[file] = await sha(file);
    assert.equal(m.output, previous.replaceAll('\\', '/'));
    for (const a of m.artifacts) known.set(a.file, a.sha256);
  }
  const bindings = {};
  async function bind(file, frozen = true) {
    const h = await sha(path.join(root, file));
    if (frozen) {
      assert.ok(known.has(file), 'Missing frozen binding ' + file);
      assert.equal(h, known.get(file), file);
    }
    bindings[file] = h;
  }
  const cohortFile = 'analysis/weight-pilot-10pct-2026-09-20-v1/freeze.json';
  const qasperFile = 'analysis/qasper-weight-pilot-2026-09-20-v1/freeze.json';
  await bind(cohortFile);
  await bind(qasperFile);
  const cohorts = (await read(path.join(root, cohortFile))).cohorts;
  const qasper = await read(path.join(root, qasperFile));
  cohorts.qasper = { population: 1005, sample: 101, ids: qasper.ids };
  for (const scope of ['langchain', 'godot', 'du']) {
    for (const f of [
      `fixed/${scope}.sqlite`,
      `fixed/${scope}-rrf10.jsonl`,
      `fixed/${scope}-index.json`,
    ])
      await bind(f);
    for (const kind of ['queries', 'corpus'])
      await bind(
        'data/' +
          (scope === 'du' ? 'du' : 'freshstack-' + scope) +
          '-' +
          kind +
          '.jsonl',
      );
    for (const mode of ['bm25', 'dense', 'rrf10'])
      await bind(
        `analysis/mode-contrast-2026-09-20-v1/${scope}-${mode}-per-question.json`,
      );
  }
  for (const f of [
    'data/du-qrels.jsonl',
    'data/qasper-dev.jsonl',
    'prepared/qasper-queries.jsonl',
    'prepared/qasper-docs.jsonl',
    'qasper/structure.sqlite',
    'qasper/p2-results.jsonl',
    'qasper/p2-summary.json',
    'qasper/p2.json',
    'embedding-plan.json',
    'reference/freshstack_metrics.py',
    'reference/qasper_evaluator.py',
  ])
    await bind(f);
  // Configuration/modules are captured completely, including all declared local resources.
  for (const dir of [
    'runtime/dist',
    'qasper/config',
    'qasper/chunkers',
    'qasper/tokenizers',
  ]) {
    for (const f of await fs.readdir(path.join(root, dir), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!f.isFile()) continue;
      const absolute = path.join(f.parentPath, f.name);
      await bind(path.relative(root, absolute).replaceAll('\\', '/'), false);
    }
  }
  for (const f of [
    'package.json',
    'package-lock.json',
    'node_modules/minisearch/package.json',
    'node_modules/minisearch/dist/cjs/index.cjs',
  ])
    await bind(dependency + '/' + f, false);
  const lock = await read(path.join(root, dependency, 'package-lock.json'));
  assert.equal(lock.packages['node_modules/minisearch'].version, '7.2.0');
  assert.equal(
    lock.packages['node_modules/minisearch'].integrity,
    'sha512-dqT2XBYUOZOiC5t2HRnwADjhNS2cecp9u+TJRiJ1Qp/f5qjkeT5APcGPjHw+bz89Ms8Jp+cG4AlE+QZ/QnDglg==',
  );
  const qdocs = new Map();
  for await (const d of jsonLines(
    path.join(root, 'prepared/qasper-docs.jsonl'),
  ))
    qdocs.set(d.id, d);
  for await (const q of jsonLines(
    path.join(root, 'prepared/qasper-queries.jsonl'),
  )) {
    if (!qasper.ids.includes(q.id)) continue;
    const d = qdocs.get(q.paper_id),
      file = path.relative(root, d.file).replaceAll('\\', '/');
    await bind(file, false);
    assert.equal(bindings[file], d.sha256);
  }
  if (noCoverage) {
    for (const name of ['freeze.json', 'summary.json'])
      await bind(previous + '/' + name);
    const prior = await read(path.join(root, previous, 'freeze.json'));
    assert.deepEqual(cohorts, prior.cohorts);
    for (const scope of Object.keys(cohorts)) {
      for (const name of [
        'candidates.jsonl',
        'receipt.json',
        'default-bm25.jsonl',
        'default-hybrid.jsonl',
        'default-bm25-per-question.json',
        'default-hybrid-per-question.json',
      ])
        await bind(previous + '/' + scope + '-' + name);
    }
  }
  const sources = await archiveSources(out, 'minisearch-pilot-pre-run', [
    'evals/run-minisearch-pilot.mjs',
    'evals/lib/minisearch-pilot.mjs',
    'evals/lib/lexical-pilot.mjs',
    'evals/lib/public-runtime.mjs',
    'evals/score-minisearch-pilot.py',
    'evals/lib/public_score_validation.py',
    'package-lock.json',
  ]);
  const plan = {
    created: new Date().toISOString(),
    variant: noCoverage ? 'without_coverage' : 'parameters',
    previous,
    arms: noCoverage
      ? { default: miniArms.default, without_coverage: miniArms.default }
      : miniArms,
    cohorts,
    baseline:
      'MiniSearch 7.2.0 library BM25+ defaults; old SQLite is a separate reference, not one of the three MiniSearch arms',
    changed_parameters: noCoverage
      ? {
          without_coverage:
            'Only remove native matched-query-term multiplier before candidate truncation; k/b/d unchanged',
        }
      : {
          k_minus30: 'k only, 1.2 -> 0.84 (-30%)',
          b_minus30: 'b only, 0.7 -> 0.49 (-30%)',
        },
    fixed: {
      tokenizer:
        'Exact frozen Echo ICU + expansions; reuse stored encoded document terms',
      title_weight: 2,
      body_weight: 1,
      bm25_weight: 0.5,
      dense_weight: 1,
      rrf_k: 10,
      candidates_per_lane: 60,
      min_dense_similarity: 0.3,
      query_term_cap: 128,
      prefix: false,
      fuzzy: false,
      combineWith: 'OR',
      storeFields: [],
      model: 'qwen3.7-text-embedding',
      dimensions: 1024,
    },
    qasper: {
      chunker: 'markdown-structure-v1@1.0.1',
      topk: 10,
      max_chunks_per_source: 3,
      cumulative_budget_utf16: 16000,
      known_target_paper: true,
      eligible: qasper.eligible,
      categories: qasper.categories,
    },
    fixed_unit_budget: null,
    fixed_unit_source_cap: null,
    engine_semantics: [
      ...(noCoverage
        ? [
            'without_coverage divides native score by the actual distinct matching queryTerms length, sorts all matches, then takes 60; one native search also verifies old control',
          ]
        : []),
      'BM25+ with log1p IDF',
      'Per-field length counts unique preprocessed input terms; term frequency retains repetitions',
      'Native search score multiplies summed field/term scores by matched query-term count',
      'No emulation of SQLite formula; comparison with SQLite changes engine semantics as a bundle',
    ],
    document_counts: { langchain: 49505, godot: 25477, du: 100001 },
    new_embedding_calls: 0,
    network_forbidden: true,
    environment: {
      node: process.version,
      icu: process.versions.icu,
      platform: process.platform,
      cpu: os.cpus()[0].model,
      total_memory_bytes: os.totalmem(),
    },
    references: manifestHashes,
    bindings,
    sources,
    limitations: [
      'Already-opened fixed samples, not held-out or blind',
      'Only lexical evaluation adapter is replaced; no production MCP switch',
      'Serial cold child per corpus; index built once and reused by all arms; no serialized index load benchmark',
      'No answer generation or new Agent decomposition',
    ],
  };
  if (noCoverage) {
    const prior = await read(path.join(root, previous, 'freeze.json'));
    assert.deepEqual(plan.fixed, prior.fixed);
    assert.deepEqual(plan.qasper, prior.qasper);
  }
  await write('freeze.json', plan);
  for (const scope of ['langchain', 'godot', 'du', 'qasper']) {
    await new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          '--expose-gc',
          '--max-old-space-size=6144',
          fileURLToPath(import.meta.url),
          root,
          out,
          '--worker',
          scope,
        ],
        { stdio: 'inherit', windowsHide: true },
      );
      p.on('error', reject);
      p.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(scope + ' worker exit ' + code)),
      );
    });
  }
  await finish();
}

async function finish() {
  const { cohorts, bindings, sources } = await read(
    path.join(out, 'freeze.json'),
  );
  const receipts = {};
  for (const scope of Object.keys(cohorts))
    receipts[scope] = await read(path.join(out, scope + '-receipt.json'));
  for (const [file, expected] of Object.entries(bindings))
    assert.equal(
      await sha(path.join(root, file)),
      expected,
      'Input changed ' + file,
    );
  await write('run-receipt.json', {
    created: new Date().toISOString(),
    receipts,
    bindings,
    sources,
    unchanged_inputs: true,
    new_embedding_calls: 0,
  });
}

async function worker(scope) {
  assert.ok(globalThis.gc, 'Run child with --expose-gc');
  const plan = await read(path.join(out, 'freeze.json'));
  const noCoverage = plan.variant === 'without_coverage';
  assert.deepEqual(
    plan.arms,
    noCoverage
      ? { default: miniArms.default, without_coverage: miniArms.default }
      : miniArms,
  );
  const armNames = Object.keys(plan.arms);
  const previousPools = new Map();
  if (noCoverage)
    for await (const row of jsonLines(
      path.join(root, plan.previous, scope + '-candidates.jsonl'),
    ))
      previousPools.set(row.id, row);
  assert.equal(
    await sha(miniFile),
    plan.bindings[dependency + '/node_modules/minisearch/dist/cjs/index.cjs'],
  );
  const ctx = await runtimeContext(root),
    cfg =
      scope === 'qasper'
        ? await ctx.loadConfig(path.join(root, 'qasper/p2.json'))
        : null;
  const dbFile = path.join(
    root,
    scope === 'qasper' ? 'qasper/structure.sqlite' : `fixed/${scope}.sqlite`,
  );
  const db = ctx.openDatabase(dbFile, { readOnly: true });
  const indexName =
    scope === 'qasper'
      ? (await ctx.load('profile-store')).profileTables(cfg, ctx.provider)
      : { chunks: 'chunks', fts: 'chunk_fts', sources: 'sources' };
  const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
  const chunks = quote(indexName.chunks),
    fts = quote(indexName.fts),
    sources = quote(indexName.sources);
  const ids = plan.cohorts[scope].ids;
  const memory = [],
    mark = (stage) =>
      memory.push({
        stage,
        ...process.memoryUsage(),
        max_rss_kib: process.resourceUsage().maxRSS,
      });
  const fileHandles = new Map();
  async function emit(label, row) {
    if (!fileHandles.has(label))
      fileHandles.set(
        label,
        await fs.open(path.join(out, scope + '-' + label + '.jsonl'), 'wx'),
      );
    await fileHandles.get(label).write(JSON.stringify(row) + '\n');
  }
  try {
    globalThis.gc();
    mark('before_index');
    const mini = new MiniSearch(miniOptions());
    const started = performance.now();
    let n = 0,
      chars = 0,
      termCount = 0;
    const allowed = new Map();
    const docTermsHash = createHash('sha256');
    for (const row of db
      .prepare(
        `SELECT c.chunk_id id,c.source_id,length(c.text) chars,f.title,f.body FROM ${chunks} c JOIN ${fts} f ON f.rowid=c.rowid ORDER BY c.rowid`,
      )
      .iterate()) {
      mini.add({ id: row.id, title: row.title, body: row.body });
      if (scope === 'qasper') {
        if (!allowed.has(row.source_id)) allowed.set(row.source_id, new Set());
        allowed.get(row.source_id).add(row.id);
      }
      chars += row.chars;
      termCount += splitTerms(row.title).length + splitTerms(row.body).length;
      docTermsHash.update(JSON.stringify([row.id, row.title, row.body]) + '\n');
      if (++n % 10000 === 0) {
        mark('build_' + n);
        console.log(
          JSON.stringify({
            scope,
            indexed: n,
            rss_mib: Math.round(process.memoryUsage().rss / 1048576),
          }),
        );
      }
    }
    const buildMs = performance.now() - started;
    assert.equal(n, db.prepare(`SELECT count(*) n FROM ${chunks}`).get().n);
    if (scope !== 'qasper') assert.equal(n, plan.document_counts[scope]);
    assert.equal(mini.documentCount, n);
    globalThis.gc();
    mark('after_index_gc');
    const metrics = {
      index_build_ms: buildMs,
      query_ms: {},
      documents: n,
      original_sqlite_text_characters: chars,
      document_terms: termCount,
      exact_index_input_sha256: docTermsHash.digest('hex'),
    };
    const timed = (arm, terms, filter) => {
      const t = performance.now();
      const result = miniRank(mini, terms, arm, filter);
      (metrics.query_ms[arm] ??= []).push(performance.now() - t);
      mark('query_' + arm);
      return result;
    };
    const compareDefault = (pools, terms, filter) => {
      const start = performance.now();
      const compared = miniRankWithoutCoverage(mini, terms, filter);
      (metrics.query_ms.default_and_without_coverage ??= []).push(
        performance.now() - start,
      );
      mark('query_without_coverage');
      const prior = previousPools.get(pools.id);
      assert.ok(prior);
      assert.deepEqual(terms, prior.query_terms);
      assert.deepEqual(
        compared.native,
        prior.default,
        'Original MiniSearch default control',
      );
      assert.deepEqual(pools.dense, prior.dense);
      assert.deepEqual(pools.sqlite, prior.sqlite);
      pools.default = compared.native;
      pools.without_coverage = compared.without_coverage;
      pools.matching_documents = compared.matching_documents;
    };
    if (noCoverage) {
      const prior = await read(
        path.join(root, plan.previous, scope + '-receipt.json'),
      );
      assert.equal(
        metrics.exact_index_input_sha256,
        prior.exact_index_input_sha256,
      );
      assert.equal(metrics.documents, prior.documents);
      metrics.original_minisearch_default_equal = true;
      metrics.new_minisearch_calls = ids.length;
    }
    const tokenize = (text) =>
      ctx.tokenize(text, { locale: 'zh-CN', dictionary: [] });
    if (scope !== 'qasper') {
      const queries = new Map();
      for await (const q of jsonLines(
        path.join(
          root,
          'data/' +
            (scope === 'du' ? 'du' : 'freshstack-' + scope) +
            '-queries.jsonl',
        ),
      ))
        queries.set(
          q.query_id ?? q.id,
          scope === 'du'
            ? q.text.trim()
            : (q.query_title + ' ' + q.query_text).trim(),
        );
      const old = new Map();
      for await (const r of jsonLines(
        path.join(root, `fixed/${scope}-rrf10.jsonl`),
      ))
        if (ids.includes(r.id)) old.set(r.id, r);
      assert.equal(old.size, ids.length);
      for (const [i, id] of ids.entries()) {
        const original = old.get(id),
          dense = denseLane(original),
          terms = queryTerms(tokenize, queries.get(id));
        const sqlite = original.rankings
          .filter((r) => r.bm25_rank !== null)
          .sort((a, b) => a.bm25_rank - b.bm25_rank);
        const native = terms.length
          ? db
              .prepare(
                `SELECT c.chunk_id id FROM ${fts} JOIN ${chunks} c ON c.rowid=${fts}.rowid WHERE ${fts} MATCH ? ORDER BY bm25(${fts},2,1),c.chunk_id LIMIT 60`,
              )
              .all(terms.map((t) => JSON.stringify(t)).join(' OR '))
          : [];
        assert.deepEqual(
          native.map((r) => r.id),
          sqlite.map((r) => r.id),
          'Frozen SQLite candidates',
        );
        const pools = { id, query_terms: terms, dense, sqlite };
        if (noCoverage) compareDefault(pools, terms);
        else {
          const ordering = [
            ...armNames.slice(i % 3),
            ...armNames.slice(0, i % 3),
          ];
          for (const arm of ordering) pools[arm] = timed(arm, terms);
        }
        await emit('candidates', pools);
        for (const arm of ['sqlite', ...armNames]) {
          for (const mode of ['bm25', 'hybrid'])
            await emit(arm + '-' + mode, {
              id,
              condition: arm + '-' + mode,
              rrf_k: 10,
              rankings:
                mode === 'bm25'
                  ? laneExport(pools[arm])
                  : hybridExport(pools[arm], dense),
            });
        }
        await emit('dense', {
          id,
          condition: 'dense',
          rrf_k: 10,
          rankings: dense.map((r, i) => ({
            ...r,
            bm25_rank: null,
            rank: i + 1,
            rank_score: dense.length - i,
            rrf_score: 1 / (10 + i + 1),
          })),
        });
      }
    } else {
      assert.equal(cfg.retrieval.rrf_k, 10);
      for (const [key, value] of Object.entries({
        topk: 10,
        max_chunks_per_source: 3,
        bm25_candidates: 60,
        dense_candidates: 60,
        bm25_weight: 0.5,
        dense_weight: 1,
        title_weight: 2,
        min_dense_similarity: 0.3,
        max_context_chars: 16000,
      }))
        assert.equal(cfg.retrieval[key], value, key);
      const { profileTokenizer } = await ctx.load('profiles');
      const { corpusState, checkProfiles } = await ctx.load('profile-store');
      const { retrievalOptions } = await ctx.load('config');
      checkProfiles(db, cfg, indexName, 'hybrid');
      const retrievalIndex = {
        ...indexName,
        tokenize: await profileTokenizer(cfg.profile.tokenizer),
      };
      const selection = {
        ...cfg.profile.active,
        revision: cfg.profile.revision,
        source_snapshot: corpusState(db),
      };
      const docs = new Map(),
        queries = new Map(),
        original = new Map();
      for await (const d of jsonLines(
        path.join(root, 'prepared/qasper-docs.jsonl'),
      ))
        docs.set(d.id, d);
      for await (const q of jsonLines(
        path.join(root, 'prepared/qasper-queries.jsonl'),
      ))
        if (ids.includes(q.id)) queries.set(q.id, q);
      for await (const r of jsonLines(
        path.join(root, 'qasper/p2-results.jsonl'),
      ))
        if (ids.includes(r.id)) original.set(r.id, r);
      const evidence = db.prepare(
        `SELECT c.chunk_id,c.text,c.heading_path,c.start_line,c.end_line,c.section_start_line,c.section_end_line,s.source_id,s.collection_id,s.path,s.relative_path,s.source_version FROM ${chunks} c JOIN ${sources} s USING(source_id) WHERE c.chunk_id=?`,
      );
      const projection = (r) =>
        r.results.map((x) => [
          x.chunk_id,
          x.source_id,
          x.start_line,
          x.end_line,
          x.text,
        ]);
      const addRanks = (bm, den) =>
        hybridExport(bm, den).map((r) => {
          const row = evidence.get(r.id);
          assert.ok(row);
          return {
            evidence: {
              ...row,
              heading_path: JSON.parse(row.heading_path),
              matched_query_ids: ['q0'],
            },
            score: r.rrf_score,
            ...(r.bm25_rank === null ? {} : { bm25_rank: r.bm25_rank }),
            ...(r.dense_rank === null
              ? {}
              : { dense_rank: r.dense_rank, similarity: r.similarity }),
          };
        });
      for (const [i, id] of ids.entries()) {
        const q = queries.get(id),
          d = docs.get(q.paper_id),
          markdown = await fs.readFile(d.file, 'utf8');
        const request = boundedRequest(q.text, q.source_id, 16000, {
          mode: 'hybrid',
          rrf_k: 10,
          bm25_weight: 0.5,
        });
        const options = retrievalOptions(cfg.retrieval, request.overrides);
        const normalizedRequest = ctx.searchSchema.parse(request);
        const reference = await ctx.retrieveQuery(
          db,
          cfg,
          'q0',
          normalizedRequest.query,
          request.filters,
          options,
          ctx.provider,
          undefined,
          undefined,
          retrievalIndex,
        );
        assert.ok(!reference.error);
        const dense = reference.candidates
          .filter((c) => c.dense_rank !== undefined)
          .sort((a, b) => a.dense_rank - b.dense_rank)
          .map((c) => ({ id: c.evidence.chunk_id, similarity: c.similarity }));
        const sqlite = reference.candidates
          .filter((c) => c.bm25_rank !== undefined)
          .sort((a, b) => a.bm25_rank - b.bm25_rank)
          .map((c) => ({ id: c.evidence.chunk_id }));
        const control = ctx.packResults([reference], options, selection);
        assert.deepEqual(
          projection(control),
          projection(original.get(id).result),
        );
        assert.deepEqual(
          qasperScore(q, d, control, markdown),
          original.get(id).score,
        );
        const terms = queryTerms(tokenize, normalizedRequest.query),
          pools = {
            id,
            source_id: q.source_id,
            query_terms: terms,
            dense,
            sqlite,
          };
        if (noCoverage) compareDefault(pools, terms, allowed.get(q.source_id));
        else {
          const ordering = [
            ...armNames.slice(i % 3),
            ...armNames.slice(0, i % 3),
          ];
          for (const arm of ordering)
            pools[arm] = timed(arm, terms, allowed.get(q.source_id));
        }
        await emit('candidates', pools);
        for (const label of [
          'dense',
          ...['sqlite', ...armNames].flatMap((a) => [
            a + '-bm25',
            a + '-hybrid',
          ]),
        ]) {
          const mode =
            label === 'dense'
              ? 'dense'
              : label.endsWith('-bm25')
                ? 'bm25'
                : 'hybrid';
          const arm = label.replace(/-(bm25|hybrid)$/, '');
          const req = boundedRequest(q.text, q.source_id, 16000, {
            mode,
            rrf_k: 10,
            bm25_weight: 0.5,
          });
          const opts = retrievalOptions(cfg.retrieval, req.overrides);
          const bm = mode === 'dense' ? [] : pools[arm],
            den = mode === 'bm25' ? [] : dense;
          const candidates = addRanks(bm, den);
          if (mode === 'bm25') for (const c of candidates) c.score *= 2;
          const qc = {
            query_id: 'q0',
            status: candidates.length ? 'ok' : 'empty',
            candidates,
            counts: {
              bm25: bm.length,
              dense: den.length,
              fused: candidates.length,
            },
          };
          const result = ctx.packResults([qc], opts, selection);
          if (label === 'sqlite-hybrid') assert.deepEqual(result, control);
          const requestChars = JSON.stringify(req).length,
            responseChars = JSON.stringify(result).length;
          assert.ok(
            requestChars + responseChars <= 16000 && result.results.length <= 3,
          );
          await emit(label, {
            id,
            paper_id: q.paper_id,
            condition: label,
            request: req,
            result,
            request_chars: requestChars,
            response_chars: responseChars,
            score: qasperScore(q, d, result, markdown),
          });
        }
      }
      metrics.original_p2_evidence_and_scores_equal = true;
    }
    globalThis.gc();
    mark('after_queries_gc');
    await write(scope + '-receipt.json', {
      scope,
      questions: ids.length,
      ...metrics,
      memory,
      max_rss_kib: process.resourceUsage().maxRSS,
      source_database_sha256: await sha(dbFile),
      new_embedding_calls: 0,
    });
    console.log(
      JSON.stringify({
        scope,
        complete: ids.length,
        documents: n,
        build_seconds: buildMs / 1000,
        after_index_mib:
          memory.find((m) => m.stage === 'after_index_gc').rss / 1048576,
        max_rss_mib: process.resourceUsage().maxRSS / 1024,
      }),
    );
  } finally {
    for (const handle of fileHandles.values()) await handle.close();
    db.close();
    ctx.cache.close();
  }
}
if (process.argv[4] === '--worker') await worker(process.argv[5]);
else if (process.argv[4] === '--finish') await finish();
else await prepare();
