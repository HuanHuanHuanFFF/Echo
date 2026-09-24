import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateVectors } from '../../dist/embedding.js';
import { fileSha256 } from './product-freeze.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
export async function loadFrozenPrivateVectors(binding, expected) {
  for (const item of [binding.report, binding.plan])
    assert.equal(
      await fileSha256(item.path),
      item.sha256,
      'Private model evidence binding changed',
    );
  const report = JSON.parse(await fs.readFile(binding.report.path, 'utf8'));
  const plan = JSON.parse(await fs.readFile(binding.plan.path, 'utf8'));
  assert.equal(report.status, 'complete');
  assert.equal(report.plan_sha256, binding.plan.sha256);
  assert.equal(plan.model, expected.model);
  assert.equal(plan.dimensions, expected.dimensions);
  assert.equal(plan.endpoint, expected.endpoint);
  const directory = path.join(path.dirname(binding.report.path), 'responses');
  assert.deepEqual(
    (await fs.readdir(directory))
      .filter((file) => file.endsWith('.json'))
      .sort(),
    report.response_hashes.map((item) => item.file).sort(),
    'Private cache files differ from captured manifest',
  );
  const cache = new Map();
  for (const item of report.response_hashes) {
    assert.equal(path.basename(item.file), item.file);
    const file = path.join(directory, item.file);
    assert.equal(
      await fileSha256(file),
      item.sha256,
      'Private query response changed',
    );
    const row = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(row.request.model, expected.model);
    assert.equal(row.request.dimensions, expected.dimensions);
    assert.equal(row.request.encoding_format, 'float');
    assert.ok(
      Array.isArray(row.request.input) && row.request.input.length === 1,
    );
    assert.equal(typeof row.request.input[0], 'string');
    assert.equal(row.response.model, expected.model);
    assert.equal(row.response.data.length, 1);
    assert.equal(row.response.data[0].index, 0);
    assert.ok(Number.isInteger(row.response.usage?.total_tokens));
    assert.equal(
      row.key,
      hash(expected.endpoint + '\n' + JSON.stringify(row.request)),
    );
    assert.equal(item.file, row.key + '.json');
    const raw = row.response.data[0].embedding;
    if (row.vector_sha256)
      assert.equal(hash(JSON.stringify(row.response.data)), row.vector_sha256);
    validateVectors([raw], 1, expected.dimensions);
    const text = row.request.input[0];
    if (cache.has(text))
      assert.deepEqual(
        cache.get(text),
        raw,
        'Conflicting vectors for one frozen query',
      );
    cache.set(text, raw);
  }
  assert.equal(report.network.texts, report.response_hashes.length);
  return cache;
}
