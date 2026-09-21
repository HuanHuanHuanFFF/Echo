import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { sampleIds, weightedRanks, parseWeights } = await import(
  pathToFileURL(resolve('evals/run-public-weight-pilot.mjs')).href
);
it('samples only by frozen identity and seed, independently of input order', () => {
  const ids = Array.from({ length: 100 }, (_, i) => 'q' + i);
  expect(sampleIds(ids, 'du', 10)).toEqual(
    sampleIds([...ids].reverse(), 'du', 10),
  );
  expect(new Set(sampleIds(ids, 'du', 10)).size).toBe(10);
  expect(() => sampleIds(['a', 'a'], 'du', 1)).toThrow();
});
it('removes zero-weight-only matches, applies weights, and uses production ID tie order', () => {
  const row = {
    candidates: { bm25: 1, dense: 1 },
    rankings: [
      { id: 'b', bm25_rank: null, dense_rank: 1 },
      { id: 'a', bm25_rank: 1, dense_rank: null },
    ],
  };
  expect(weightedRanks(row, 0).map((r: { id: string }) => r.id)).toEqual(['b']);
  expect(weightedRanks(row, 0.5).map((r: { id: string }) => r.id)).toEqual([
    'b',
    'a',
  ]);
  expect(weightedRanks(row, 1).map((r: { id: string }) => r.id)).toEqual([
    'a',
    'b',
  ]);
  expect(() => weightedRanks(row, -1)).toThrow();
  const broken = structuredClone(row);
  broken.rankings[0]!.dense_rank = 2;
  expect(() => weightedRanks(broken, 0.5)).toThrow();
});

it('accepts explicit new weights and rejects ambiguous or invalid batches', () => {
  expect(parseWeights()).toEqual([0, 0.1, 0.25, 0.5]);
  expect(parseWeights('[0.3,0.4]')).toEqual([0.3, 0.4]);
  for (const bad of ['[]', '[0.3,0.3]', '["0.3"]', '[-1]', '[11]'])
    expect(() => parseWeights(bad)).toThrow();
});
