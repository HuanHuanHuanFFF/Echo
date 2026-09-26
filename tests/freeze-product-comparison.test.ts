import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

const { inspectIndexReceipts, writeFreezeOnce } = await import(
  pathToFileURL(path.resolve('evals/freeze-product-comparison.mjs')).href
);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('product comparison freeze builder', () => {
  it('keeps missing scope receipts pending but blocks an existing invalid receipt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comparison-freeze-'));
    roots.push(root);
    const difyReceipt = path.join(
      root,
      'indexes',
      'dify',
      'a',
      'query-index-receipt.json',
    );
    const invalidKhojReceipt = path.join(
      root,
      'indexes',
      'khoj',
      'b',
      'query-index-receipt.json',
    );
    await fs.mkdir(path.dirname(difyReceipt), { recursive: true });
    await fs.mkdir(path.dirname(invalidKhojReceipt), { recursive: true });
    await fs.writeFile(difyReceipt, '{}');
    await fs.writeFile(invalidKhojReceipt, '{}');

    const readiness = await inspectIndexReceipts({
      root,
      manifest: { scopes: { a: {}, b: {} } },
      modelFingerprint: 'model-fingerprint',
      validator: async ({
        product,
        scope,
        path: file,
      }: {
        product: string;
        scope: string;
        path: string;
      }) => {
        if (product === 'khoj' && scope === 'b')
          throw new Error('stale receipt');
        return { path: file, sha256: 'a'.repeat(64) };
      },
    });

    expect(readiness).toMatchObject({
      expected: 4,
      valid: [{ product: 'dify', scope: 'a' }],
      pending: [
        { product: 'dify', scope: 'b' },
        { product: 'khoj', scope: 'a' },
      ],
      invalid: [{ product: 'khoj', scope: 'b' }],
    });
  });

  it('creates a freeze file exclusively and refuses to overwrite an existing one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comparison-freeze-'));
    roots.push(root);
    const file = path.join(root, 'freeze.json');
    await writeFreezeOnce(file, '{"status":"frozen"}\n');

    await expect(
      writeFreezeOnce(file, '{"status":"changed"}\n'),
    ).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(
      '{"status":"frozen"}\n',
    );
  });
});
