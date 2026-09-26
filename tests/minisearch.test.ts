import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import MiniSearch from 'minisearch';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseConfig, retrievalOptions } from '../src/config.js';
import {
  prepareMiniIndex,
  clearMiniCache,
  miniCacheDiagnostics,
} from '../src/minisearch.js';
import { searchIndex } from '../src/retrieval.js';
import { syncIndex } from '../src/sync.js';
import { openDatabase } from '../src/database.js';
const { miniOptions, miniRankWithoutCoverage } = await import(
  pathToFileURL(resolve('evals/lib/minisearch-pilot.mjs')).href
);
const dirs: string[] = [];
afterEach(async () => {
  clearMiniCache();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'echo-mini-')));
  dirs.push(dir);
  const root = join(dir, 'notes');
  await mkdir(root);
  await writeFile(join(root, 'a.md'), '# Fruit\napple green');
  await writeFile(join(root, 'b.md'), '# Fruit\nbanana yellow');
  const config = parseConfig({
    database: join(dir, 'index.sqlite'),
    collections: [{ id: 'notes', root }],
    retrieval: { mode: 'bm25' },
  });
  await syncIndex(config);
  return { dir, root, config };
}
function termDb(docs: { id: string; title: string; body: string }[]) {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE chunks(chunk_id TEXT); CREATE VIRTUAL TABLE chunk_fts USING fts5(title,body)',
  );
  for (const row of docs) {
    const record = db.prepare('INSERT INTO chunks VALUES (?)').run(row.id);
    db.prepare('INSERT INTO chunk_fts(rowid,title,body) VALUES (?,?,?)').run(
      record.lastInsertRowid,
      row.title,
      row.body,
    );
  }
  return db;
}
it('freezes MiniSearch defaults and validates partial per-query overrides', () => {
  const config = parseConfig({});
  expect(config.retrieval).toMatchObject({
    lexical_engine: 'minisearch',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    rrf_k: 10,
    bm25_weight: 0.5,
  });
  expect(
    retrievalOptions(config.retrieval, { minisearch_b: 0.49 }),
  ).toMatchObject({
    minisearch_k: 1.2,
    minisearch_b: 0.49,
    lexical_engine: 'minisearch',
  });
  for (const overrides of [
    { minisearch_k: 0 },
    { minisearch_b: 1.1 },
    { minisearch_d: -1 },
    { lexical_engine: 'other' },
  ])
    expect(() => retrievalOptions(config.retrieval, overrides)).toThrow();
});
it('matches the frozen evaluation scorer and recovers native rank 61 before the cap', async () => {
  const docs = [
    ...Array.from({ length: 60 }, (_, i) => ({
      id: 'n' + i,
      title: '',
      body: 'alpha beta',
    })),
    { id: 'target', title: '', body: Array(200).fill('gamma').join(' ') },
    ...Array.from({ length: 39 }, (_, i) => ({
      id: 'f' + i,
      title: '',
      body:
        'gamma ' + Array.from({ length: 40 }, (_, j) => 'extra' + j).join(' '),
    })),
  ];
  const db = termDb(docs);
  try {
    const native = new MiniSearch(miniOptions());
    native.addAll(docs);
    const expected = miniRankWithoutCoverage(native, [
      'alpha',
      'beta',
      'gamma',
    ]);
    expect(expected.native.some((r: { id: string }) => r.id === 'target')).toBe(
      false,
    );
    const index = await prepareMiniIndex(db, {
      chunks: 'chunks',
      fts: 'chunk_fts',
    });
    const options = parseConfig({}).retrieval;
    expect(index.rank(['alpha', 'beta', 'gamma'], options)).toEqual(
      expected.without_coverage.map((r: { id: string; score: number }) => ({
        id: r.id,
        score: r.score,
      })),
    );
    expect(index.rank(['alpha', 'beta', 'gamma'], options)[0]!.id).toBe(
      'target',
    );
    expect(index.rank(['alpha'], options, new Set(['n59']))).toHaveLength(1);
    expect(index.rank(['alpha'], options, new Set())).toEqual([]);
    expect(index.rank(['alp'], options)).toEqual([]);
  } finally {
    db.close();
  }
});
it('excludes title-only matches at zero title boost', async () => {
  const db = termDb([
    { id: 'title', title: 'apple', body: 'banana' },
    { id: 'body', title: '', body: 'apple' },
  ]);
  try {
    const index = await prepareMiniIndex(db, {
      chunks: 'chunks',
      fts: 'chunk_fts',
    });
    expect(
      index
        .rank(['apple'], { ...parseConfig({}).retrieval, title_weight: 0 })
        .map((x) => x.id),
    ).toEqual(['body']);
  } finally {
    db.close();
  }
});
it('does not publish an aborted partial build', async () => {
  const db = termDb(
    Array.from({ length: 600 }, (_, i) => ({
      id: String(i),
      title: '',
      body: 'apple',
    })),
  );
  const controller = new AbortController(),
    before = miniCacheDiagnostics().builds;
  try {
    const building = prepareMiniIndex(
      db,
      { chunks: 'chunks', fts: 'chunk_fts' },
      controller.signal,
    );
    controller.abort();
    await expect(building).rejects.toThrow();
    expect(miniCacheDiagnostics().builds).toBe(before);
    expect(
      (await prepareMiniIndex(db, { chunks: 'chunks', fts: 'chunk_fts' }))
        .documents,
    ).toBe(600);
  } finally {
    db.close();
  }
});
it('reuses a snapshot, filters before cap, and refreshes content/path/deletion only after sync', async () => {
  const { config, root } = await fixture();
  const first = await searchIndex(config, { query: 'apple banana' });
  const builds = miniCacheDiagnostics().builds;
  await searchIndex(config, {
    query: 'banana',
    overrides: { minisearch_b: 0.49 },
  });
  expect(miniCacheDiagnostics().builds).toBe(builds);
  const filtered = await searchIndex(config, {
    query: 'apple banana',
    filters: { path_prefix: 'b' },
    overrides: { bm25_candidates: 1 },
  });
  expect(filtered.results.map((x) => x.path.split(/[\\/]/).at(-1))).toEqual([
    'b.md',
  ]);
  const source = filtered.results[0]!.source_id;
  expect(
    (
      await searchIndex(config, {
        query: 'apple banana',
        filters: { source_ids: [source] },
        overrides: { bm25_candidates: 1 },
      })
    ).results[0]!.source_id,
  ).toBe(source);
  await rename(join(root, 'b.md'), join(root, 'c.md'));
  await writeFile(
    join(root, 'c.md'),
    (await readFile(join(root, 'c.md'), 'utf8')).replace('banana', 'cherry'),
  );
  await rm(join(root, 'a.md'));
  await syncIndex(config);
  expect(
    (await searchIndex(config, { query: 'apple banana' })).results,
  ).toEqual([]);
  const updated = await searchIndex(config, { query: 'cherry' });
  expect(updated.results[0]).toMatchObject({
    source_id: source,
    path: join(root, 'c.md'),
  });
  expect(updated.results[0]!.text).toContain('cherry');
  expect(miniCacheDiagnostics().builds).toBe(builds + 1);
  const sqlite = await searchIndex(config, {
    query: 'cherry',
    overrides: { lexical_engine: 'sqlite' },
  });
  expect(sqlite.results).toEqual(updated.results);
  expect(first.results).toHaveLength(2);
});
it('keeps unversioned indexes readable and enables reuse after a zero-change sync', async () => {
  const { config } = await fixture();
  const db = openDatabase(config.database);
  db.prepare("DELETE FROM meta WHERE key='index_revision'").run();
  db.close();
  const before = miniCacheDiagnostics().builds;
  await searchIndex(config, { query: 'apple' });
  await searchIndex(config, { query: 'apple' });
  expect(miniCacheDiagnostics().builds).toBe(before + 2);
  expect(await syncIndex(config)).toMatchObject({ unchanged: 2 });
  await searchIndex(config, { query: 'apple' });
  const after = miniCacheDiagnostics().builds;
  await searchIndex(config, { query: 'apple' });
  expect(miniCacheDiagnostics().builds).toBe(after);
});
it('reuses a real worker, isolates cancellation, refreshes after sync and releases workers on close', async () => {
  const { config, root, dir } = await fixture();
  const moduleUrl = pathToFileURL(resolve('src/search-pool.ts')).href;
  const syncUrl = pathToFileURL(resolve('src/sync.ts')).href;
  const program = `
    import assert from 'node:assert/strict';
    import { readFile, writeFile } from 'node:fs/promises';
    import { SearchWorkerPool } from ${JSON.stringify(moduleUrl)};
    import { syncIndex } from ${JSON.stringify(syncUrl)};
    const pool=new SearchWorkerPool(), config=${JSON.stringify(config)};
    try {
      await pool.run(config,{query:'apple'});
      await pool.run(config,{query:'banana'});
      assert.equal(pool.diagnostics().created,1);
      const controller=new AbortController();
      const cancelled=pool.run(config,{query:'apple'},controller.signal);
      const caught=assert.rejects(cancelled,/cancelled/);
      const other=pool.run(config,{query:'banana'});
      controller.abort(); await caught;
      assert.equal((await other).results.length,1);
      assert.equal(pool.diagnostics().created,2);
      const note=${JSON.stringify(join(root, 'b.md'))};
      await writeFile(note,(await readFile(note,'utf8')).replace('banana','cherry'));
      await syncIndex(config);
      assert.equal((await pool.run(config,{query:'cherry'})).results.length,1);
      assert.equal((await pool.run(config,{query:'banana'})).results.length,0);
      const cold=new SearchWorkerPool();
      try { await assert.rejects(cold.run({...config,runtime:{...config.runtime,search_timeout_ms:1}},{query:'apple'}),/timed out/); }
      finally {await cold.close();}
      assert.equal(cold.diagnostics().workers,0);
    } finally {await pool.close();}
    assert.equal(pool.diagnostics().workers,0);
    await assert.rejects(pool.run(config,{query:'apple'}),/closed/);
    console.log('passed');
  `;
  const script = join(dir, 'pool-check.mjs');
  await writeFile(script, program);
  const result = await promisify(execFile)(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), script],
    { windowsHide: true, timeout: 12000 },
  );
  expect(result.stdout.trim()).toBe('passed');
});
