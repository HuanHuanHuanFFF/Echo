import assert from 'node:assert/strict';

export const miniArms = Object.freeze({
  default: Object.freeze({ k: 1.2, b: 0.7, d: 0.5 }),
  k_minus30: Object.freeze({ k: 0.84, b: 0.7, d: 0.5 }),
  b_minus30: Object.freeze({ k: 1.2, b: 0.49, d: 0.5 }),
});

// Input is Echo's already-normalized, encoded term stream, not raw Markdown.
export const splitTerms = (text) => text.split(' ').filter(Boolean);
export function miniOptions() {
  return {
    fields: ['title', 'body'],
    storeFields: [],
    tokenize: splitTerms,
    processTerm: (term) => term,
    searchOptions: {
      prefix: false,
      fuzzy: false,
      combineWith: 'OR',
      boost: { title: 2, body: 1 },
      bm25: { ...miniArms.default },
    },
  };
}

export function miniRank(index, terms, arm, allowedIds) {
  assert.ok(Object.hasOwn(miniArms, arm), 'Unknown frozen arm');
  assert.ok(terms.length <= 128 && new Set(terms).size === terms.length);
  const all = index.search(terms.join(' '), {
    bm25: { ...miniArms[arm] },
    ...(allowedIds ? { filter: (r) => allowedIds.has(r.id) } : {}),
  });
  return all
    .map(({ id, score }) => {
      assert.ok(Number.isFinite(score) && score >= 0);
      return { id, score };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 60);
}

export function denseLane(row) {
  const found = row.rankings
    .filter((r) => r.dense_rank !== null)
    .sort((a, b) => a.dense_rank - b.dense_rank);
  assert.equal(found.length, row.candidates.dense);
  assert.deepEqual(
    found.map((r) => r.dense_rank),
    found.map((_, i) => i + 1),
  );
  return found;
}
