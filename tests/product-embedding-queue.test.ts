import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { createEmbeddingQueue } = await import(
  pathToFileURL(resolve('evals/lib/product-embedding-queue.mjs')).href
);
it('batches distinct concurrent texts, deduplicates them and preserves caller order', async () => {
  const cache = new Map<string, number[]>();
  const calls: string[][] = [];
  const embeddings = createEmbeddingQueue({
    cached: (text: string) => cache.get(text),
    batchSize: 2,
    delayMs: 1,
    remote: async (texts: string[]) => {
      calls.push(texts);
      for (const text of texts) cache.set(text, [text.charCodeAt(0)]);
    },
  });
  const output = await Promise.all([
    embeddings(['b', 'a', 'b']),
    embeddings(['a', 'c']),
  ]);
  expect(output).toEqual([
    [[98], [97], [98]],
    [[97], [99]],
  ]);
  expect(calls).toEqual([['b', 'a'], ['c']]);
  await embeddings(['a']);
  expect(calls).toHaveLength(2);
});
it('rejects a failed batch without poisoning later batches or retries', async () => {
  const cache = new Map<string, number[]>();
  let fail = true;
  const embeddings = createEmbeddingQueue({
    cached: (text: string) => cache.get(text),
    batchSize: 1,
    delayMs: 1,
    remote: async (texts: string[]) => {
      if (texts[0] === 'bad' && fail) throw new Error('upstream failure');
      for (const text of texts) cache.set(text, [1]);
    },
  });
  const results = await Promise.allSettled([
    embeddings(['bad']),
    embeddings(['good']),
  ]);
  expect(results.map((x) => x.status)).toEqual(['rejected', 'fulfilled']);
  fail = false;
  await expect(embeddings(['bad'])).resolves.toEqual([[1]]);
});
