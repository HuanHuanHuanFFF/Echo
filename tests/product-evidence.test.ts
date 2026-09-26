import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { mapReturnedText, spansCover, sourceLineSpans, packProductEvidence } =
  await import(pathToFileURL(resolve('evals/lib/product-evidence.mjs')).href);

it('maps repeated native ancestry to its actual ancestor and unique body', () => {
  const source = {
    text: '# Main\n\nOther text\n\n## Section\nA real answer.\n',
    original_first_line: 4,
  };
  const mapped = mapReturnedText('# Main\n## Section\nA real answer.', source);
  expect(mapped.status).toBe('mapped');
  const required = sourceLineSpans(source, 8, 9);
  expect(
    required.every(([a, b]: [number, number]) =>
      spansCover(mapped.spans, a, b),
    ),
  ).toBe(true);
});

it('refuses ambiguous repeats and fabricated prefix evidence', () => {
  const source = {
    text: '# Main\nRepeated.\n\nRepeated.\n',
    original_first_line: 1,
  };
  expect(mapReturnedText('Repeated.', source).status).toBe('ambiguous');
  expect(mapReturnedText('Fabricated fact.\n# Main', source).status).toBe(
    'unmapped',
  );
  expect(
    mapReturnedText('# Wrong\n# Main\nRepeated.\n\nRepeated.', source).status,
  ).not.toBe('mapped');
});

it('does not credit an entire source line when only a prefix was returned', () => {
  const source = { text: 'First fact; second fact.\n', original_first_line: 3 };
  const mapped = mapReturnedText('First fact', source);
  const [[a, b]] = sourceLineSpans(source, 3, 3);
  expect(spansCover(mapped.spans, a, b)).toBe(false);
});

it('shares one budget across subquestions, skips oversized evidence, and enforces both upper limits', () => {
  const item = (id: string, source: string, text = id) => ({
    id,
    source_id: source,
    path: source + '.md',
    text,
  });
  const question = {
    queries: [
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ],
  };
  const result = packProductEvidence(
    question,
    [
      {
        query_id: 'a',
        results: [
          item('large', 's1', 'x'.repeat(10000)),
          item('a', 's1'),
          item('duplicate', 's2'),
        ],
      },
      {
        query_id: 'b',
        results: [item('b', 's1'), item('duplicate', 's2'), item('c', 's3')],
      },
    ],
    { topk: 2, source_cap: 1, max_context_chars: 600 },
  );
  expect(result.response.results.map((x: { id: string }) => x.id)).toEqual([
    'b',
    'duplicate',
  ]);
  expect(result.response.results[1].matched_query_ids).toEqual(['a', 'b']);
  expect(result.excluded.budget).toBe(1);
  expect(result.excluded.source_cap).toBe(1);
  expect(result.request_chars + result.response_chars).toBeLessThanOrEqual(600);
});
