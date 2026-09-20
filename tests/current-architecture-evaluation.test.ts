import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { retrievalSchema } from '../src/config.js';
const { reviseLabels } = await import(
  pathToFileURL(resolve('evals/rescore-development-labels.mjs')).href
);
const { currentRetrieval } = await import(
  pathToFileURL(resolve('evals/run-current-architecture-comparison.mjs')).href
);
const { score } = await import(
  pathToFileURL(resolve('evals/lib/evidence-metrics.mjs')).href
);
it('adds alternative evidence without altering old labels, questions, or old scores', () => {
  const anchor = {
    collection_id: 'c',
    path: 'note.md',
    start_line: 1,
    end_line: 1,
    quote: 'original',
  };
  const fact = { id: 'f', evidence: [anchor] };
  const q = {
    id: 'q',
    query: 'question',
    required_facts: ['f'],
    no_answer: false,
  };
  const data = {
    split: 'development',
    facts: [fact],
    questions: [q],
    corpus: [],
  };
  const amendment = {
    fact_id: 'f',
    original_fact_sha256: createHash('sha256')
      .update(JSON.stringify(fact))
      .digest('hex'),
    additional_evidence: [
      { ...anchor, start_line: 3, end_line: 3, quote: 'equivalent' },
    ],
  };
  const revision = { amendments: [amendment] };
  const next = reviseLabels(data, revision);
  const pieces = [
    {
      collection_id: 'c',
      relative_path: 'note.md',
      start_line: 3,
      end_line: 3,
      text: 'equivalent',
    },
  ];
  expect(score(q, data.facts, pieces).k[10].complete).toBe(false);
  expect(score(q, next.facts, pieces).k[10].complete).toBe(true);
  expect(data.facts[0]?.evidence).toHaveLength(1);
  expect(next.questions).toEqual(data.questions);
  expect(() => reviseLabels({ ...data, split: 'final' }, revision)).toThrow(
    'Final labels',
  );
  expect(() =>
    reviseLabels({ ...data, facts: [{ ...fact, evidence: [] }] }, revision),
  ).toThrow('drift');
  expect(() => reviseLabels(next, revision)).toThrow('drift');
});
it('rejects accidental parameter drift while producing separate fixed-mode arms', () => {
  const original = retrievalSchema.parse({
    rrf_k: 60,
    max_context_chars: 12000,
  });
  const fixed = currentRetrieval(original, 'hybrid');
  expect(fixed).toEqual({ ...original, rrf_k: 10, max_context_chars: 16000 });
  expect(currentRetrieval(original, 'dense')).toEqual({
    ...fixed,
    mode: 'dense',
  });
  expect(currentRetrieval(original, 'bm25')).toEqual({
    ...fixed,
    mode: 'bm25',
  });
  for (const patch of [
    { topk: 8 },
    { max_chunks_per_source: 4 },
    { bm25_weight: 0.3 },
    { dense_candidates: 100 },
  ])
    expect(() =>
      currentRetrieval({ ...original, ...patch }, 'hybrid'),
    ).toThrow();
  expect(original.rrf_k).toBe(60);
  expect(retrievalSchema.parse({}).rrf_k).toBe(10);
});
