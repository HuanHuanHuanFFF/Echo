import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { jsonLines } from './prepare-public-benchmarks.mjs';
import { archiveSources } from './lib/public-provenance.mjs';
import {
  createPilotTokenizer,
  queryTerms,
  rankFromPostings,
  laneExport,
  hybridExport,
} from './lib/lexical-pilot.mjs';

assert.ok(process.argv[2] && process.argv[3], 'Usage: ROOT NEW_OUT');
const root = path.resolve(process.argv[2]),
  out = path.resolve(process.argv[3]);
const rel = path.relative(root, out);
assert.ok(
  rel &&
    !path.isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith('..' + path.sep),
);
globalThis.fetch = async () => {
  throw new Error('Network forbidden in lexical pilot');
};
const sha = async (p) => {
  const h = createHash('sha256');
  for await (const b of createReadStream(p)) h.update(b);
  return h.digest('hex');
};
const read = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const write = async (name, value) =>
  fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
const known = new Map(),
  referenceManifests = {};
for (const name of [
  '2026-09-20-public-full-results',
  '2026-09-20-public-mode-contrast',
  '2026-09-20-bm25-weight-pilot',
]) {
  const p = 'docs/evals/' + name + '.manifest.json',
    m = await read(p);
  referenceManifests[p] = await sha(p);
  for (const f of m.artifacts) known.set(f.file, f.sha256);
}
const bindings = {};
async function bind(file, frozen = true) {
  const digest = await sha(path.join(root, file));
  if (frozen) {
    assert.ok(known.has(file), 'No frozen SHA: ' + file);
    assert.equal(digest, known.get(file), file);
  }
  bindings[file] = digest;
  return path.join(root, file);
}
for (const file of [
  'data/du-corpus.jsonl',
  'data/du-queries.jsonl',
  'data/du-qrels.jsonl',
  'fixed/du.sqlite',
  'fixed/du-index.json',
  'fixed/du-rrf10.jsonl',
  'runtime/dist/lexical.js',
  'runtime/dist/identity.js',
  'runtime/package-lock.json',
  'analysis/weight-pilot-10pct-2026-09-20-v1/freeze.json',
  'analysis/mode-contrast-2026-09-20-v1/du-bm25-per-question.json',
  'analysis/mode-contrast-2026-09-20-v1/du-dense-per-question.json',
  'analysis/mode-contrast-2026-09-20-v1/du-rrf10-per-question.json',
])
  await bind(file);
const deps = 'tooling/jieba-wasm-2.4.0';
for (const file of [
  'package.json',
  'package-lock.json',
  'node_modules/jieba-wasm/package.json',
  'node_modules/jieba-wasm/pkg/nodejs/jieba_rs_wasm.js',
  'node_modules/jieba-wasm/pkg/nodejs/jieba_rs_wasm_bg.wasm',
])
  await bind(deps + '/' + file, false);
const lock = await read(path.join(root, deps, 'package-lock.json'));
assert.equal(lock.packages['node_modules/jieba-wasm'].version, '2.4.0');
assert.equal(
  lock.packages['node_modules/jieba-wasm'].integrity,
  'sha512-ZvQdS+FGifrFXZIXSgOyOgEz+1wdy1P4vSvwe37FVtku9ycSdHTZbHqF5i9tMN1JucoAmeiLBeI6/YaqcGD+KA==',
);
const jieba = createRequire(path.join(root, deps, 'package.json'))(
  'jieba-wasm',
);
const Database = createRequire(path.join(root, 'runtime/package.json'))(
  'better-sqlite3',
);
const { tokenize: originalTokenize } = await import(
  pathToFileURL(path.join(root, 'runtime/dist/lexical.js')).href
);
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const icu = createPilotTokenizer((text) =>
  [...segmenter.segment(text)]
    .filter((p) => p.isWordLike)
    .map((p) => p.segment),
);
const jiebaSearch = createPilotTokenizer((text) =>
  jieba.cut_for_search(text, true).filter((word) => /[\p{L}\p{N}]/u.test(word)),
);
const cohort = (
  await read(
    path.join(root, 'analysis/weight-pilot-10pct-2026-09-20-v1/freeze.json'),
  )
).cohorts.du;
assert.equal(cohort.population, 2000);
assert.equal(cohort.ids.length, 200);
const ids = cohort.ids;
assert.equal(new Set(ids).size, 200);
const queries = new Map();
for await (const q of jsonLines(path.join(root, 'data/du-queries.jsonl')))
  queries.set(q.id, q.text.trim());
assert.equal(queries.size, 2000);
assert.ok(ids.every((id) => queries.has(id)));
const old = new Map();
for await (const row of jsonLines(path.join(root, 'fixed/du-rrf10.jsonl')))
  if (ids.includes(row.id)) old.set(row.id, row);
assert.equal(old.size, 200);
const lane = (row, kind) => {
  const items = row.rankings
    .filter((r) => r[kind + '_rank'] !== null)
    .sort((a, b) => a[kind + '_rank'] - b[kind + '_rank']);
  assert.equal(items.length, row.candidates[kind]);
  assert.deepEqual(
    items.map((r) => r[kind + '_rank']),
    items.map((_, i) => i + 1),
  );
  return items;
};
const original = new Database(path.join(root, 'fixed/du.sqlite'), {
  readonly: true,
  fileMustExist: true,
});
const n = original.prepare('SELECT count(*) n FROM chunks').get().n;
assert.equal(n, 100001);
await fs.mkdir(out);
const plan = {
  created: new Date().toISOString(),
  scope: 'DuRetrieval 200 frozen queries, full 100001 official units',
  ids,
  sampling: cohort,
  documents: n,
  arms: ['icu_sqlite', 'jieba_search', 'lucene_idf'],
  modes: ['bm25', 'hybrid'],
  dense_control: true,
  changes: {
    icu_sqlite: 'Exact existing ICU + expansions, native SQLite FTS5 BM25',
    jieba_search:
      'Only first word pass replaced by jieba-wasm 2.4.0 cut_for_search HMM=true; same common expansions, stopwords, no custom dictionary',
    lucene_idf:
      'Same ICU tokens and exact length/TF normalization; only IDF log(1+ratio) replacing SQLite clipped log(ratio); not a full Lucene engine',
  },
  k1: 1.2,
  b: 0.75,
  rrf_k: 10,
  bm25_weight: 0.5,
  dense_weight: 1,
  candidates_per_lane: 60,
  query_term_limit: 128,
  title_weight: 2,
  title_field: 'empty',
  min_dense_similarity: 0.3,
  model: 'qwen3.7-text-embedding',
  dimensions: 1024,
  source_cap: null,
  context_budget: null,
  retrieval_unit:
    'Original official fixed units; no Echo rechunking or MCP packing',
  dictionary:
    'Jieba bundled dictionary pinned by package lock and WASM SHA; no user dictionary',
  corpus_duplicate_policy: 'Existing frozen index: last input row wins',
  baseline_required:
    'All 100001 ICU document terms identical; all 200 old BM25 and hybrid10 orders identical',
  formula_control:
    'Manual SQLite formula must match native FTS5 scores/order before IDF variant accepted',
  new_embedding_calls: 0,
  network_forbidden: true,
  reference_manifests: referenceManifests,
  bindings,
  environment: {
    node: process.version,
    icu: process.versions.icu,
    sqlite: original.prepare('SELECT sqlite_version() v').get().v,
  },
  implementation_sha256: await sha(new URL(import.meta.url)),
  limitations: [
    'Already-opened exploratory subset, not blind evaluation',
    'No whole-document term deduplication or simultaneous dictionary/weight changes',
    'Only Chinese Du; not a general claim about English or personal notes',
  ],
};
await write('freeze.json', plan);
const db = new Database(path.join(out, 'lexical.sqlite'));
const times = { icu_tokenize_ms: 0, jieba_tokenize_ms: 0, build_ms: 0 },
  totals = { icu: 0, jieba: 0, characters: 0 };
const metadata = new Map();
let count = 0;
try {
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = NORMAL');
  db.exec(
    "CREATE TABLE documents(rowid INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,icu_length INTEGER NOT NULL,jieba_length INTEGER NOT NULL); CREATE VIRTUAL TABLE fts_icu USING fts5(title,body,content=''); CREATE VIRTUAL TABLE fts_jieba USING fts5(title,body,content=''); CREATE VIRTUAL TABLE vocab_icu USING fts5vocab(fts_icu,'instance')",
  );
  const putDoc = db.prepare('INSERT INTO documents VALUES(?,?,?,?)'),
    putA = db.prepare('INSERT INTO fts_icu(rowid,title,body) VALUES(?,?,?)'),
    putB = db.prepare('INSERT INTO fts_jieba(rowid,title,body) VALUES(?,?,?)');
  const started = performance.now();
  db.exec('BEGIN');
  try {
    for (const row of original
      .prepare(
        'SELECT c.rowid rowid,c.chunk_id id,c.text,f.title,f.body FROM chunks c JOIN chunk_fts f ON f.rowid=c.rowid ORDER BY c.rowid',
      )
      .iterate()) {
      let t = performance.now();
      const a = icu(row.text);
      times.icu_tokenize_ms += performance.now() - t;
      assert.equal(a.join(' '), row.body, 'Frozen ICU terms ' + row.id);
      assert.equal(row.title, '');
      t = performance.now();
      const b = jiebaSearch(row.text);
      times.jieba_tokenize_ms += performance.now() - t;
      putDoc.run(row.rowid, row.id, a.length, b.length);
      putA.run(row.rowid, '', row.body);
      putB.run(row.rowid, '', b.join(' '));
      metadata.set(row.rowid, { id: row.id, length: a.length });
      totals.icu += a.length;
      totals.jieba += b.length;
      totals.characters += row.text.length;
      count++;
      if (count % 10000 === 0)
        console.log(
          JSON.stringify({
            indexed: count,
            total: n,
            elapsed_seconds: Math.round((performance.now() - started) / 1000),
          }),
        );
    }
    assert.equal(count, n);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  times.build_ms = performance.now() - started;
  db.exec(
    "INSERT INTO fts_icu(fts_icu) VALUES('optimize'); INSERT INTO fts_jieba(fts_jieba) VALUES('optimize')",
  );
  const searchStmt = (table) =>
    db.prepare(
      'SELECT d.id,bm25(' +
        table +
        ',2,1) value FROM ' +
        table +
        ' JOIN documents d ON d.rowid=' +
        table +
        '.rowid WHERE ' +
        table +
        ' MATCH ? ORDER BY value,d.id LIMIT 60',
    );
  const aQuery = searchStmt('fts_icu'),
    bQuery = searchStmt('fts_jieba');
  const postings = db.prepare(
    "SELECT doc,count(*) tf FROM vocab_icu WHERE term=? AND col='body' GROUP BY doc",
  );
  const output = new Map(),
    pool = [],
    timings = [];
  for (const arm of plan.arms)
    for (const mode of plan.modes) output.set(arm + '-' + mode, []);
  output.set('dense', []);
  const rankedRow = (id, condition, rankings) => ({
    id,
    condition,
    rrf_k: 10,
    rankings,
  });
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i],
      query = queries.get(id),
      prior = old.get(id);
    assert.equal(query.length, prior.query_chars);
    assert.deepEqual(
      icu(query),
      originalTokenize(query, { locale: 'zh-CN', dictionary: [] }),
    );
    const aTerms = queryTerms(icu, query),
      bTerms = queryTerms(jiebaSearch, query);
    const native = (stmt, terms) =>
      terms.length
        ? stmt
            .all(terms.map((t) => JSON.stringify(t)).join(' OR '))
            .map((r) => ({ id: r.id, score: -r.value }))
        : [];
    let t = performance.now();
    const a = native(aQuery, aTerms),
      aMs = performance.now() - t;
    t = performance.now();
    const b = native(bQuery, bTerms),
      bMs = performance.now() - t;
    const pMap = new Map(aTerms.map((term) => [term, postings.all(term)]));
    const control = rankFromPostings(
      aTerms,
      (term) => pMap.get(term),
      n,
      totals.icu / n,
      metadata,
      'sqlite',
    );
    assert.deepEqual(
      control.map((r) => r.id),
      a.map((r) => r.id),
      'Manual SQLite order ' + id,
    );
    for (let k = 0; k < a.length; k++)
      assert.ok(
        Math.abs(a[k].score - control[k].score) <
          1e-10 * Math.max(1, a[k].score),
        'Manual SQLite score ' + id,
      );
    t = performance.now();
    const c = rankFromPostings(
        aTerms,
        (term) => pMap.get(term),
        n,
        totals.icu / n,
        metadata,
        'lucene',
      ),
      cMs = performance.now() - t;
    const dense = lane(prior, 'dense');
    assert.deepEqual(
      a.map((r) => r.id),
      lane(prior, 'bm25').map((r) => r.id),
      'Native ICU baseline ' + id,
    );
    assert.deepEqual(
      hybridExport(a, dense).map((r) => r.id),
      prior.rankings.map((r) => r.id),
      'Hybrid baseline ' + id,
    );
    for (const [arm, items] of [
      ['icu_sqlite', a],
      ['jieba_search', b],
      ['lucene_idf', c],
    ]) {
      output
        .get(arm + '-bm25')
        .push(rankedRow(id, arm + '-bm25', laneExport(items)));
      output
        .get(arm + '-hybrid')
        .push(rankedRow(id, arm + '-hybrid', hybridExport(items, dense)));
    }
    const dr = dense.map((r, k) => ({
      ...r,
      bm25_rank: null,
      rrf_score: 1 / (10 + k + 1),
      rank: k + 1,
      rank_score: dense.length - k,
    }));
    output.get('dense').push(rankedRow(id, 'dense', dr));
    pool.push({
      id,
      icu_query_terms: aTerms,
      jieba_query_terms: bTerms,
      dense,
      icu_sqlite: a,
      jieba_search: b,
      lucene_idf: c,
      manual_sqlite: control,
    });
    timings.push({
      id,
      native_icu_query_ms: aMs,
      native_jieba_query_ms: bMs,
      lucene_scoring_only_ms: cMs,
    });
    if ((i + 1) % 25 === 0)
      console.log(JSON.stringify({ queried: i + 1, total: ids.length }));
  }
  for (const [label, rows] of output)
    await fs.writeFile(
      path.join(out, label + '.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      { flag: 'wx' },
    );
  await fs.writeFile(
    path.join(out, 'candidates.jsonl'),
    pool.map((r) => JSON.stringify(r)).join('\n') + '\n',
    { flag: 'wx' },
  );
  await write('timings.json', {
    times,
    totals,
    queries: timings,
    limitations:
      'One warm run; Lucene scoring-only excludes postings collection and is not a latency comparison',
  });
} finally {
  db.close();
  original.close();
}
assert.equal(
  await sha(path.join(root, 'fixed/du.sqlite')),
  bindings['fixed/du.sqlite'],
  'Original index changed',
);
const sources = await archiveSources(out, 'lexical-pilot', [
  'evals/run-lexical-pilot.mjs',
  'evals/lib/lexical-pilot.mjs',
  'evals/score-lexical-pilot.py',
  'evals/lib/public_score_validation.py',
]);
await write('run-receipt.json', {
  created: new Date().toISOString(),
  scope: plan.scope,
  documents: count,
  queries: ids.length,
  native_bm25_query_calls: 400,
  manual_formula_controls: 200,
  idf_variant_rankings: 200,
  baseline_document_terms_equal: true,
  baseline_200_bm25_and_hybrid_orders_equal: true,
  manual_sqlite_control_equal: true,
  original_index_sha256_before: bindings['fixed/du.sqlite'],
  original_index_sha256_after: await sha(path.join(root, 'fixed/du.sqlite')),
  new_lexical_index_sha256: await sha(path.join(out, 'lexical.sqlite')),
  new_lexical_index_bytes: (await fs.stat(path.join(out, 'lexical.sqlite')))
    .size,
  new_embedding_calls: 0,
  network_forbidden: true,
  bindings,
  sources,
  reference_manifests: referenceManifests,
});
console.log(
  JSON.stringify({
    completed: true,
    documents: count,
    queries: ids.length,
    new_embedding_calls: 0,
    times,
    totals,
  }),
);
