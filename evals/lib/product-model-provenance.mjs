import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { fileSha256 } from './product-freeze.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
export function cacheRecordDigest(database, fingerprint) {
  const digest = createHash('sha256');
  let count = 0;
  for (const row of database
    .prepare(
      'SELECT key,input,vector,vector_sha,origin FROM vectors ORDER BY key',
    )
    .iterate()) {
    assert.equal(
      row.key,
      hash(JSON.stringify([fingerprint, row.input])),
      'Model cache input changed',
    );
    assert.equal(
      hash(row.vector),
      row.vector_sha,
      'Model cache vector changed',
    );
    digest.update(JSON.stringify([row.key, row.vector_sha, row.origin]) + '\n');
    count++;
  }
  return { count, sha256: digest.digest('hex') };
}
export async function verifyFinalModelProvenance(rootArg) {
  const root = path.resolve(rootArg);
  const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
  const freeze = await read(path.join(root, 'freeze.json'));
  const pointer = await read(path.join(root, 'model-provenance/final.json'));
  assert.equal(pointer.status, 'verified');
  assert.equal(
    pointer.freeze_sha256,
    await fileSha256(path.join(root, 'freeze.json')),
  );
  const file = path.resolve(pointer.report.path);
  assert.ok(
    file.startsWith(path.join(root, 'model-provenance') + path.sep),
    'Model provenance outside experiment',
  );
  assert.equal(await fileSha256(file), pointer.report.sha256);
  const report = await read(file);
  assert.equal(report.status, 'verified');
  assert.deepEqual(report.model, freeze.model);
  assert.equal(report.fingerprint, freeze.model.fingerprint);
  assert.equal(report.new_api_calls, 0);
  assert.equal(
    report.counts.total,
    report.counts.api + report.counts.public + report.counts.private,
  );
  assert.ok(report.counts.total > 0 && report.api_responses > 0);
  const bound = new Map();
  for (const item of report.artifacts) {
    const target = path.resolve(item.path);
    assert.ok(!bound.has(target));
    assert.equal(
      await fileSha256(target),
      item.sha256,
      'Model provenance artifact changed',
    );
    bound.set(target, item.sha256);
  }
  const required = [
    path.join(path.dirname(file), 'cache.sqlite'),
    fileURLToPath(
      new URL('../audit-product-model-provenance.mjs', import.meta.url),
    ),
    fileURLToPath(new URL('../product-embedding-gateway.mjs', import.meta.url)),
    fileURLToPath(new URL('../run-final-four-arms.mjs', import.meta.url)),
    fileURLToPath(new URL('./frozen-query-fetch.mjs', import.meta.url)),
    freeze.echo.vector_cache.path,
    freeze.echo.embedding_plan.path,
    freeze.echo.private_query_cache.report.path,
    freeze.echo.private_query_cache.plan.path,
  ];
  for (const target of required)
    assert.ok(
      bound.has(path.resolve(target)),
      'Required model provenance artifact absent',
    );
  const database = new Database(
    path.join(root, 'embedding-gateway/vectors.sqlite'),
    { readonly: true, fileMustExist: true },
  );
  try {
    const live = cacheRecordDigest(database, report.fingerprint);
    assert.equal(
      live.count,
      report.counts.total,
      'Final model provenance is stale',
    );
    assert.equal(
      live.sha256,
      report.cache_records_sha256,
      'Final model provenance is stale',
    );
  } finally {
    database.close();
  }
  return pointer;
}
