import { expect, it } from 'vitest';
import MiniSearch from 'minisearch';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { miniArms, miniOptions, miniRank, miniRankWithoutCoverage } =
  await import(pathToFileURL(resolve('evals/lib/minisearch-pilot.mjs')).href);

it('matches native MiniSearch BM25+ including repeated terms, unique field length and query coverage multiplier', () => {
  const docs = [
    { id: 'a', title: '', body: 'apple apple banana' },
    { id: 'b', title: '', body: 'apple other more words' },
    { id: 'c', title: '', body: 'banana third' },
    { id: 'd', title: '', body: '' },
  ];
  const index = new MiniSearch(miniOptions());
  index.addAll(docs);
  for (const [arm, params] of Object.entries(miniArms)) {
    const { k, b, d } = params as { k: number; b: number; d: number };
    const expected = docs
      .map((doc) => {
        const terms = doc.body.split(' ').filter(Boolean);
        let score = 0,
          matches = 0;
        for (const term of ['apple', 'banana']) {
          const tf = terms.filter((x) => x === term).length;
          if (!tf) continue;
          matches++;
          const df = docs.filter((x) =>
            x.body.split(' ').includes(term),
          ).length;
          const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
          const averageUniqueLength = 8 / 4;
          score +=
            idf *
            (d +
              (tf * (k + 1)) /
                (tf +
                  k *
                    (1 - b + (b * new Set(terms).size) / averageUniqueLength)));
        }
        return { id: doc.id, score: score * matches };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const actual = miniRank(index, ['apple', 'banana'], arm);
    expect(actual.map((x: { id: string }) => x.id)).toEqual(
      expected.map((x) => x.id),
    );
    actual.forEach((x: { score: number }, i: number) =>
      expect(x.score).toBeCloseTo(expected[i]!.score, 12),
    );
  }
  const baseline = index.search('apple banana');
  expect(
    miniRank(index, ['apple', 'banana'], 'default').map(
      (r: { score: number }) => r.score,
    ),
  ).toEqual(baseline.map((r) => r.score));
});

it('filters before the candidate cap, uses exact OR matching and retains stable IDs on ties', () => {
  const index = new MiniSearch(miniOptions());
  index.addAll(
    Array.from({ length: 70 }, (_, i) => ({
      id: String(i).padStart(3, '0'),
      title: '',
      body: 'apple',
    })),
  );
  index.add({
    id: 'allowed',
    title: '',
    body: 'apple many unrelated words for a longer field',
  });
  expect(miniRank(index, ['apple'], 'default', new Set(['allowed']))).toEqual([
    expect.objectContaining({ id: 'allowed' }),
  ]);
  expect(miniRank(index, ['apple'], 'default')).toHaveLength(60);
  expect(miniRank(index, ['app'], 'default')).toEqual([]);
  expect(miniRank(index, [], 'default')).toEqual([]);
  expect(() => miniRank(index, ['apple', 'apple'], 'default')).toThrow();
  expect(() => miniRank(index, ['apple'], 'unknown')).toThrow();
  const snapshot = MiniSearch.loadJSON(JSON.stringify(index), miniOptions());
  expect(miniRank(snapshot, ['apple'], 'default')).toEqual(
    miniRank(index, ['apple'], 'default'),
  );
});

it('freezes exactly two independent 30 percent changes and keeps shared options immutable', () => {
  expect(miniArms.k_minus30).toEqual({ ...miniArms.default, k: 0.84 });
  expect(miniArms.b_minus30).toEqual({ ...miniArms.default, b: 0.49 });
  const index = new MiniSearch(miniOptions());
  index.addAll([
    { id: 'a', title: 'apple', body: 'banana' },
    { id: 'b', title: '', body: 'apple' },
  ]);
  const first = miniRank(index, ['apple'], 'default');
  miniRank(index, ['apple'], 'b_minus30');
  expect(miniRank(index, ['apple'], 'default')).toEqual(first);
  expect(first[0].id).toBe('a');
});

it('removes the matched-term multiplier before truncation and recovers a native rank beyond sixty', () => {
  const index = new MiniSearch(miniOptions());
  index.addAll([
    ...Array.from({ length: 60 }, (_, i) => ({
      id: 'd' + i,
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
  ]);
  const result = miniRankWithoutCoverage(index, ['alpha', 'beta', 'gamma']);
  expect(result.native).toEqual(
    miniRank(index, ['alpha', 'beta', 'gamma'], 'default'),
  );
  expect(result.native.some((r: { id: string }) => r.id === 'target')).toBe(
    false,
  );
  expect(result.without_coverage[0]).toMatchObject({
    id: 'target',
    matched_terms: 1,
    native_rank: 61,
  });
  expect(result.without_coverage).toHaveLength(60);
  expect(result.matching_documents).toBe(100);
  const filtered = miniRankWithoutCoverage(
    index,
    ['alpha', 'beta', 'gamma'],
    new Set(['target']),
  );
  expect(filtered.without_coverage).toHaveLength(1);
  expect(filtered.without_coverage[0].id).toBe('target');
  expect(miniRankWithoutCoverage(index, []).without_coverage).toEqual([]);
  const raw = index.search('alpha beta gamma');
  for (const row of result.without_coverage) {
    const hit = raw.find((r) => r.id === row.id)!;
    expect(row.score).toBeCloseTo(hit.score / hit.queryTerms.length, 12);
  }
});
