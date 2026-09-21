import assert from 'node:assert/strict';

// Evaluation-only: retain Echo's expansion and stopword policy; replace just the first word segmentation pass.
const stopwords = new Set([
  '的',
  '了',
  '和',
  '与',
  '是',
  '在',
  '如何',
  '什么',
  '为什么',
  '怎么',
  '一个',
  '哪些',
  '及',
]);
export function createPilotTokenizer(segmentWords) {
  return (text) => {
    const normalized = text.normalize('NFKC'),
      terms = [];
    const add = (word) => {
      const term = word.toLowerCase();
      if (term && !stopwords.has(term))
        terms.push('t' + Buffer.from(term, 'utf8').toString('hex'));
    };
    for (const word of segmentWords(normalized)) add(word);
    for (const match of normalized.matchAll(/[A-Za-z][A-Za-z0-9_.$-]*/g)) {
      add(match[0]);
      for (const part of match[0]
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/))
        add(part);
    }
    for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
      const chars = [...match[0]];
      for (let i = 0; i + 1 < chars.length; i++) add(chars[i] + chars[i + 1]);
    }
    return terms;
  };
}
export function queryTerms(tokenize, text) {
  return [...new Set(tokenize(text))].slice(0, 128);
}
export function idf(documents, documentFrequency, variant) {
  assert.ok(Number.isInteger(documents) && documents > 0);
  assert.ok(
    Number.isInteger(documentFrequency) &&
      documentFrequency > 0 &&
      documentFrequency <= documents,
  );
  const ratio =
    (documents - documentFrequency + 0.5) / (documentFrequency + 0.5);
  if (variant === 'sqlite') return Math.max(Math.log(ratio), 1e-6);
  assert.equal(variant, 'lucene');
  return Math.log(1 + ratio);
}
export function rankFromPostings(
  terms,
  getPostings,
  documents,
  averageLength,
  metadata,
  variant,
) {
  assert.ok(averageLength > 0);
  const scores = new Map();
  for (const term of terms) {
    const postings = getPostings(term);
    if (!postings.length) continue;
    const weight = idf(documents, postings.length, variant);
    for (const p of postings) {
      const doc = metadata.get(p.doc);
      assert.ok(doc && p.tf > 0 && p.tf <= doc.length);
      const norm = 1.2 * (1 - 0.75 + (0.75 * doc.length) / averageLength);
      scores.set(
        p.doc,
        (scores.get(p.doc) ?? 0) +
          weight * ((p.tf * (1.2 + 1)) / (p.tf + norm)),
      );
    }
  }
  return [...scores]
    .map(([rowid, score]) => ({ id: metadata.get(rowid).id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 60);
}
export function laneExport(ids) {
  return ids.map((row, i) => ({
    id: row.id,
    rank: i + 1,
    rank_score: ids.length - i,
    rrf_score: 1 / (10 + i + 1),
    bm25_rank: i + 1,
    dense_rank: null,
    similarity: null,
    ...(row.score === undefined ? {} : { bm25_score: row.score }),
  }));
}
export function hybridExport(bm25, dense) {
  const map = new Map();
  bm25.forEach((row, i) =>
    map.set(row.id, {
      id: row.id,
      bm25_rank: i + 1,
      dense_rank: null,
      similarity: null,
    }),
  );
  dense.forEach((row, i) => {
    const r = map.get(row.id) ?? {
      id: row.id,
      bm25_rank: null,
      dense_rank: null,
      similarity: null,
    };
    r.dense_rank = i + 1;
    r.similarity = row.similarity;
    map.set(row.id, r);
  });
  return [...map.values()]
    .map((r) => ({
      ...r,
      rrf_score:
        (r.bm25_rank === null ? 0 : 0.5 / (10 + r.bm25_rank)) +
        (r.dense_rank === null ? 0 : 1 / (10 + r.dense_rank)),
    }))
    .sort((a, b) => b.rrf_score - a.rrf_score || a.id.localeCompare(b.id))
    .map((r, i, all) => ({ ...r, rank: i + 1, rank_score: all.length - i }));
}
