import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { parentOnly } = await import(
  pathToFileURL(resolve('evals/run-decomposition-comparison.mjs')).href
);
const { score, summarize } = await import(
  pathToFileURL(resolve('evals/lib/evidence-metrics.mjs')).href
);
const anchor = (text: string, start = 1) => ({
  collection_id: 'fixture',
  path: 'note.md',
  start_line: start,
  end_line: start + text.split('\n').length - 1,
  quote: text,
});
const piece = (text: string, start = 1) => ({
  collection_id: 'fixture',
  relative_path: 'note.md',
  start_line: start,
  end_line: start + text.split('\n').length - 1,
  text,
});

describe('fixed decomposition ablation', () => {
  it('removes only subquestions while preserving parent wording, labels and controls', () => {
    const source = {
      corpus: [{ path: 'note.md', sha256: 'frozen' }],
      facts: [{ id: 'f', evidence: [anchor('answer')] }],
      questions: [
        {
          id: 'split',
          query: 'Compare A and B under condition C',
          no_answer: false,
          required_facts: ['f'],
          subquestions: [{ id: 's', text: 'A under C', required_facts: ['f'] }],
        },
        {
          id: 'control',
          query: 'unchanged',
          no_answer: false,
          required_facts: ['f'],
        },
      ],
    };
    const before = structuredClone(source);
    const result = parentOnly(source);
    const expected = structuredClone(source);
    delete expected.questions[0]!.subquestions;
    expect(result).toEqual(expected);
    expect(source).toEqual(before);
    result.facts[0].evidence[0].quote = 'local edit';
    expect(source).toEqual(before);
  });

  it('distinguishes prefix assembly from a single relevant chunk', () => {
    const facts = [{ id: 'f', evidence: [anchor('one\n\ntwo')] }];
    const q = { required_facts: ['f'], no_answer: false };
    const result = score(q, facts, [piece('one'), piece('two', 3)]);
    expect(result.k[1].factCovered).toBe(0);
    expect(result.k[3].factCovered).toBe(1);
    expect(result.k[3].prefixFirstFactRR).toBe(0.5);
    expect(result.k[10].singleChunkHit).toBe(false);
    expect(result.k[10].singleChunkRR).toBe(0);
  });

  it('keeps parent macro/micro denominators and excludes no-answer questions', () => {
    const facts = ['a', 'b', 'c'].map((id, index) => ({
      id,
      evidence: [anchor(id, index + 1)],
    }));
    const one = score({ required_facts: ['a'], no_answer: false }, facts, [
      piece('a'),
    ]);
    const three = score(
      { required_facts: ['a', 'b', 'c'], no_answer: false },
      facts,
      [piece('a')],
    );
    const noAnswer = score({ required_facts: [], no_answer: true }, facts, [
      piece('a'),
    ]);
    const result = summarize([one, three, noAnswer]);
    expect(result.answerable).toBe(2);
    expect(result.expectedFacts).toBe(4);
    expect(result.noAnswer).toEqual({ total: 1, nonempty: 1 });
    expect(result.k[10].factRecallMacro).toBeCloseTo(2 / 3);
    expect(result.k[10].factRecallMicro).toBe(0.5);
    expect(result.k[10].completeEvidence.count).toBe(1);
  });

  it('requires matching text and uses delivered chunk rank for MRR', () => {
    const facts = [{ id: 'f', evidence: [anchor('answer', 3)] }];
    const q = { required_facts: ['f'], no_answer: false };
    const result = score(q, facts, [
      piece('irrelevant'),
      piece('incorrect', 3),
      piece('answer', 3),
    ]);
    expect(result.k[1].sourceRR).toBe(1);
    expect(result.k[1].singleChunkRR).toBe(0);
    expect(result.k[3].singleChunkRR).toBe(1 / 3);
    expect(result.k[10].factCovered).toBe(1);
    expect(score(q, facts, []).k[10].singleChunkRR).toBe(0);
  });
});
