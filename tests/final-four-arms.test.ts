import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { retrievalSchema } from '../src/config.js';
const { finalRetrieval, reusableDevelopmentScope, verifyPairedQuestions } =
  await import(pathToFileURL(resolve('evals/run-final-four-arms.mjs')).href);
it('never reuses the ABC development index for the ABCD final or paired scopes', () => {
  expect(reusableDevelopmentScope('A-test')).toBe('A-development');
  expect(reusableDevelopmentScope('B-test')).toBe('B-development');
  expect(reusableDevelopmentScope('C-test')).toBe('C-development');
  for (const scope of ['D-test', 'mixed-test', 'paired-test'])
    expect(reusableDevelopmentScope(scope)).toBeNull();
});
it('separates a profile id from parsed retrieval options without changing numeric settings', () => {
  const values = {
    ...retrievalSchema.parse({ rrf_k: 10, max_context_chars: 16000 }),
    id: 'final-fixed',
  };
  const original = createHash('sha256')
    .update(JSON.stringify(values))
    .digest('hex');
  expect(finalRetrieval({ retrieval: values }, 'hybrid')).toEqual(
    retrievalSchema.parse({ rrf_k: 10, max_context_chars: 16000 }),
  );
  expect(finalRetrieval({ retrieval: values }, 'dense').mode).toBe('dense');
  expect(finalRetrieval({ retrieval: values }, 'bm25').mode).toBe('bm25');
  expect(
    createHash('sha256').update(JSON.stringify(values)).digest('hex'),
  ).toBe(original);
  expect(() => finalRetrieval({ retrieval: values }, 'unfrozen')).toThrow();
});
it('requires paired rows to keep original questions and facts, not become new samples', () => {
  const questions = Array.from({ length: 200 }, (_, i) => ({
    id: 'q' + i,
    query: 'fixture ' + i,
    required_facts: ['f' + i],
  }));
  const facts = questions.map((q, i) => ({
    id: 'f' + i,
    evidence: [{ quote: 'evidence ' + q.id }],
  }));
  const primary = [{ scenario: { kind: 'separate' }, questions, facts }];
  const paired = {
    questions: structuredClone(questions.slice(0, 40)),
    facts: structuredClone(facts.slice(0, 40)),
  };
  expect(() => verifyPairedQuestions(primary, paired)).not.toThrow();
  const drift = structuredClone(paired);
  drift.questions[0]!.query = 'changed';
  expect(() => verifyPairedQuestions(primary, drift)).toThrow();
  const factDrift = structuredClone(paired);
  factDrift.facts[0]!.evidence[0]!.quote = 'changed';
  expect(() => verifyPairedQuestions(primary, factDrift)).toThrow();
  expect(() =>
    verifyPairedQuestions(primary, {
      ...paired,
      questions: paired.questions.slice(1),
    }),
  ).toThrow();
});
