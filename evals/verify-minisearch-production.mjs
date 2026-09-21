// Replays frozen lexical candidates through the production module; no network or writes to input data.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDatabase } from '../dist/database.js';
import { parseConfig } from '../dist/config.js';
import { prepareMiniIndex } from '../dist/minisearch.js';
import { runtimeContext } from './lib/public-runtime.mjs';
const [rootArg, outArg, scope] = process.argv.slice(2);
assert.ok(
  rootArg && outArg,
  'Usage: node evals/verify-minisearch-production.mjs DATA_ROOT NEW_RECEIPT',
);
const root = resolve(rootArg),
  out = resolve(outArg);
const prior = join(root, 'analysis/minisearch-without-coverage-2026-09-21-v1');
async function sha(file) {
  const h = createHash('sha256');
  for await (const part of createReadStream(file)) h.update(part);
  return h.digest('hex');
}
async function verify(name) {
  const database =
    name === 'qasper' ? 'qasper/structure.sqlite' : 'fixed/' + name + '.sqlite';
  const inputFile = join(prior, name + '-candidates.jsonl');
  const plan = JSON.parse(await readFile(join(prior, 'freeze.json'), 'utf8'));
  const bindings = {
    database: await sha(join(root, database)),
    candidates: await sha(inputFile),
  };
  assert.equal(bindings.database, plan.bindings[database]);
  const rows = (await readFile(inputFile, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(
    rows.map((r) => r.id),
    plan.cohorts[name].ids,
  );
  let ctx;
  let tables = { chunks: 'chunks', fts: 'chunk_fts' };
  if (name === 'qasper') {
    ctx = await runtimeContext(root);
    const cfg = await ctx.loadConfig(join(root, 'qasper/p2.json'));
    tables = (await ctx.load('profile-store')).profileTables(cfg, ctx.provider);
  }
  const db = openDatabase(join(root, database), { readOnly: true });
  try {
    db.exec('BEGIN');
    const started = performance.now();
    const index = await prepareMiniIndex(db, tables);
    let compared = 0;
    for (const row of rows) {
      const allowed = row.source_id
        ? new Set(
            db
              .prepare(
                'SELECT chunk_id FROM "' +
                  tables.chunks +
                  '" WHERE source_id=?',
              )
              .all(row.source_id)
              .map((r) => r.chunk_id),
          )
        : undefined;
      const actual = index.rank(
        row.query_terms,
        parseConfig({}).retrieval,
        allowed,
      );
      const expected = row.without_coverage.map(({ id, score }) => ({
        id,
        score,
      }));
      assert.deepEqual(
        actual,
        expected,
        'Production lexical ranking changed: ' + name + '/' + row.id,
      );
      compared += actual.length;
    }
    db.exec('ROLLBACK');
    assert.equal(await sha(join(root, database)), bindings.database);
    assert.equal(await sha(inputFile), bindings.candidates);
    return {
      scope: name,
      queries: rows.length,
      documents: index.documents,
      candidates_compared: compared,
      candidate_ids_and_scores_exact: true,
      input_unchanged: true,
      bindings,
      duration_ms: Math.round(performance.now() - started),
      new_embedding_calls: 0,
    };
  } finally {
    db.close();
    ctx?.cache.close();
  }
}
if (scope) {
  const result = await verify(scope);
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  const results = [];
  for (const name of ['langchain', 'godot', 'du', 'qasper']) {
    const row = await new Promise((resolveResult, reject) => {
      const p = spawn(
        process.execPath,
        [
          '--max-old-space-size=6144',
          fileURLToPath(import.meta.url),
          root,
          out,
          name,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let text = '';
      p.stdout.on('data', (b) => (text += b));
      p.on('error', reject);
      p.on('exit', (code) =>
        code === 0
          ? resolveResult(JSON.parse(text))
          : reject(new Error(name + ' exit ' + code)),
      );
    });
    results.push(row);
    console.log(name + ' ' + row.queries + ' queries matched');
  }
  const files = [
    'src/minisearch.ts',
    'dist/minisearch.js',
    'src/config.ts',
    'dist/config.js',
    'package-lock.json',
    'evals/verify-minisearch-production.mjs',
  ];
  const sources = Object.fromEntries(
    await Promise.all(files.map(async (f) => [f, await sha(f)])),
  );
  await writeFile(
    out,
    JSON.stringify(
      {
        date: '2026-09-21',
        status: 'passed',
        node: process.version,
        icu: process.versions.icu,
        scope:
          'production lexical candidate parity only; not a new relevance evaluation or end-to-end hybrid score',
        previous: 'analysis/minisearch-without-coverage-2026-09-21-v1',
        parameters: parseConfig({}).retrieval,
        results,
        queries: results.reduce((n, r) => n + r.queries, 0),
        new_embedding_calls: 0,
        sources,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
}
