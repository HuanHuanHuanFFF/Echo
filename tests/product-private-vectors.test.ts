import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { loadFrozenPrivateVectors } = await import(
  pathToFileURL(path.resolve('evals/lib/product-private-vectors.mjs')).href
);
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
it('binds the consumed private model response to endpoint, model and immutable response bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-private-cache-'));
  try {
    await fs.mkdir(path.join(dir, 'responses'));
    const expected = {
      model: 'test-embedding',
      dimensions: 2,
      endpoint: 'https://example.invalid/embeddings',
    };
    const request = {
      model: expected.model,
      dimensions: 2,
      encoding_format: 'float',
      input: ['query'],
    };
    const response = {
      model: expected.model,
      data: [{ index: 0, embedding: [1, 0] }],
      usage: { total_tokens: 1 },
    };
    const key = hash(expected.endpoint + '\n' + JSON.stringify(request));
    const row = {
      key,
      request,
      response,
      vector_sha256: hash(JSON.stringify(response.data)),
    };
    const responseFile = path.join(dir, 'responses', key + '.json');
    const bytes = JSON.stringify(row);
    await fs.writeFile(responseFile, bytes);
    const planText = JSON.stringify(expected);
    const plan = { path: path.join(dir, 'plan.json'), sha256: hash(planText) };
    await fs.writeFile(plan.path, planText);
    const reportText = JSON.stringify({
      status: 'complete',
      plan_sha256: plan.sha256,
      network: { texts: 1 },
      response_hashes: [{ file: key + '.json', sha256: hash(bytes) }],
    });
    const report = {
      path: path.join(dir, 'report.json'),
      sha256: hash(reportText),
    };
    await fs.writeFile(report.path, reportText);
    const loaded = await loadFrozenPrivateVectors({ plan, report }, expected);
    expect(loaded.get('query')).toEqual([1, 0]);
    await expect(
      loadFrozenPrivateVectors(
        { plan, report },
        { ...expected, model: 'another-model' },
      ),
    ).rejects.toThrow();
    await fs.writeFile(responseFile, bytes.replace('[1,0]', '[0,1]'));
    await expect(
      loadFrozenPrivateVectors({ plan, report }, expected),
    ).rejects.toThrow('response changed');
  } finally {
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
