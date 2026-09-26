import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { cacheRecordDigest } = await import(
  pathToFileURL(path.resolve('evals/lib/product-model-provenance.mjs')).href
);
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
function fixture() {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE vectors(key TEXT PRIMARY KEY,input TEXT,vector BLOB,vector_sha TEXT,origin TEXT)',
  );
  const vector = Buffer.from(new Float32Array([1, 0]).buffer);
  db.prepare('INSERT INTO vectors VALUES (?,?,?,?,?)').run(
    hash(JSON.stringify(['fp', 'query'])),
    'query',
    vector,
    hash(vector),
    'api-response:test',
  );
  return db;
}
it('detects cache additions and origin changes after the final provenance snapshot', () => {
  const db = fixture();
  try {
    const before = cacheRecordDigest(db, 'fp');
    db.prepare('UPDATE vectors SET origin=?').run('api-response:changed');
    expect(cacheRecordDigest(db, 'fp').sha256).not.toBe(before.sha256);
    const vector = Buffer.from(new Float32Array([0, 1]).buffer);
    db.prepare('INSERT INTO vectors VALUES (?,?,?,?,?)').run(
      hash(JSON.stringify(['fp', 'later'])),
      'later',
      vector,
      hash(vector),
      'api-response:later',
    );
    expect(cacheRecordDigest(db, 'fp').count).toBe(2);
  } finally {
    db.close();
  }
});
it('rejects a vector whose bytes no longer match its captured hash', () => {
  const db = fixture();
  try {
    db.prepare('UPDATE vectors SET vector=?').run(
      Buffer.from(new Float32Array([0, 1]).buffer),
    );
    expect(() => cacheRecordDigest(db, 'fp')).toThrow(
      'Model cache vector changed',
    );
  } finally {
    db.close();
  }
});
it('rejects changed query text hidden behind the original input key', () => {
  const db = fixture();
  try {
    db.prepare('UPDATE vectors SET input=?').run('changed');
    expect(() => cacheRecordDigest(db, 'fp')).toThrow(
      'Model cache input changed',
    );
  } finally {
    db.close();
  }
});
