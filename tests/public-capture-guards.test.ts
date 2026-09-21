import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
const { acquireCaptureLock, validateReturnedModel } = await import(
  pathToFileURL(resolve('evals/lib/public-capture-guards.mjs')).href
);

function fixture(test: (db: Database.Database, file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'echo-capture-guard-'));
  const db = new Database(':memory:');
  db.exec('CREATE TABLE info(key TEXT PRIMARY KEY,value TEXT)');
  try {
    test(db, join(dir, 'capture.lock'));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
it('refuses an active legacy lock without touching it', () => {
  fixture((db, file) => {
    const original = JSON.stringify({ pid: process.pid, nonce: 'legacy' });
    writeFileSync(file, original);
    expect(() => acquireCaptureLock(db, file)).toThrow(
      'Capture lock is still active',
    );
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(db.prepare('SELECT * FROM info').all()).toEqual([]);
  });
});
it('recovers a dead owner while archiving its lock and preserves exclusive ownership', () => {
  fixture((db, file) => {
    const original = JSON.stringify({ pid: 12345, nonce: 'dead' });
    writeFileSync(file, original);
    db.prepare('INSERT INTO info VALUES (?,?)').run('capture_owner', original);
    const release = acquireCaptureLock(
      db,
      file,
      (pid: number) => pid === process.pid,
    );
    expect(
      readdirSync(join(file, '..')).filter((x) => x.includes('.stale-')),
    ).toHaveLength(1);
    expect(() => acquireCaptureLock(db, file)).toThrow('still active');
    release();
    expect(existsSync(file)).toBe(false);
    expect(db.prepare('SELECT * FROM info').all()).toEqual([]);
  });
});
it('does not remove a replaced lock during release', () => {
  fixture((db, file) => {
    const release = acquireCaptureLock(db, file);
    const replacement = JSON.stringify({
      pid: process.pid,
      nonce: 'replacement',
    });
    writeFileSync(file, replacement);
    expect(release).toThrow('Capture lock changed');
    expect(readFileSync(file, 'utf8')).toBe(replacement);
    expect(db.prepare('SELECT * FROM info').all()).toHaveLength(1);
  });
});
it('rejects wrong or missing model identities in successful responses', () => {
  expect(() =>
    validateReturnedModel(
      { model: 'qwen3.7-text-embedding' },
      'qwen3.7-text-embedding',
    ),
  ).not.toThrow();
  expect(() =>
    validateReturnedModel({ model: 'other' }, 'qwen3.7-text-embedding'),
  ).toThrow('Embedding response model mismatch');
  expect(() => validateReturnedModel({}, 'qwen3.7-text-embedding')).toThrow(
    'Embedding response model mismatch',
  );
});

it('register and capture reject an active writer before changing plans or policy history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-capture-entry-'));
  mkdirSync(join(dir, 'runtime/dist'), { recursive: true });
  writeFileSync(
    join(dir, 'runtime/package.json'),
    JSON.stringify({ type: 'module' }),
  );
  const driver = pathToFileURL(
    resolve('node_modules/better-sqlite3/lib/index.js'),
  ).href;
  writeFileSync(
    join(dir, 'runtime/dist/database.js'),
    'import Database from ' +
      JSON.stringify(driver) +
      ';export const openDatabase=(p)=>new Database(p);',
  );
  writeFileSync(
    join(dir, 'runtime/dist/embedding.js'),
    'export const embeddingFingerprint=()=>"fixture";export const validateVectors=x=>x;',
  );
  const db = new Database(join(dir, 'vectors.sqlite'));
  db.exec('CREATE TABLE info(key TEXT PRIMARY KEY,value TEXT);');
  db.prepare('INSERT INTO info VALUES (?,?)').run('fingerprint', 'fixture');
  const lock = JSON.stringify({ pid: process.pid, nonce: 'active-test' });
  writeFileSync(join(dir, 'capture.lock'), lock);
  const plan = JSON.stringify({ fingerprint: 'fixture', sentinel: true });
  writeFileSync(join(dir, 'embedding-plan.json'), plan);
  try {
    for (const phase of ['register', 'capture']) {
      const p = spawnSync(
        process.execPath,
        [resolve('evals/capture-public-vectors.mjs'), dir, phase, 'qasper'],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(p.status).not.toBe(0);
      expect(p.stderr).toContain('Capture lock is still active');
      expect(readFileSync(join(dir, 'embedding-plan.json'), 'utf8')).toBe(plan);
      expect(existsSync(join(dir, 'capture-policy-history.jsonl'))).toBe(false);
      expect(existsSync(join(dir, 'repro'))).toBe(false);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses a live database owner even when its file is missing', () => {
  fixture((db, file) => {
    db.prepare('INSERT INTO info VALUES (?,?)').run(
      'capture_owner',
      JSON.stringify({ pid: process.pid, nonce: 'database-owner' }),
    );
    expect(() => acquireCaptureLock(db, file)).toThrow(
      'Capture owner is still active',
    );
    expect(existsSync(file)).toBe(false);
  });
});
