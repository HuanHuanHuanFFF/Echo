import { expect, it } from 'vitest';
import {
  retrievalOptions,
  retrievalOverridesSchema,
  retrievalSchema,
} from '../src/config.js';
import {
  packResults,
  type Candidate,
  type QueryCandidates,
} from '../src/retrieval.js';
import { previewRange } from '../src/preview.js';

function query(texts: string[], queryId = 'q'): QueryCandidates {
  return {
    query_id: queryId,
    status: 'ok',
    counts: { bm25: texts.length, dense: 0, fused: texts.length },
    candidates: texts.map((text, i): Candidate => ({
      score: 1 / (i + 1),
      evidence: {
        chunk_id: `chunk-${i}`,
        source_id: `source-${i}`,
        collection_id: 'notes',
        path: `/notes/${i}.md`,
        relative_path: `${i}.md`,
        source_version: 'a'.repeat(64),
        heading_path: ['Test'],
        start_line: 10,
        end_line: 10 + text.split('\n').length - 1,
        section_start_line: 8,
        section_end_line: 80,
        matched_query_ids: [],
        text,
      },
    })),
  };
}
function pack(texts: string[], budget = 20000, diagnostics = false) {
  return packResults(
    [query(texts)],
    retrievalSchema.parse({
      topk: texts.length,
      max_context_chars: budget,
    }),
    undefined,
    diagnostics,
  );
}

it('keeps topk at 10 under a configured-only default cap of 20', () => {
  const base = retrievalSchema.parse({});
  expect(base).toMatchObject({ topk: 10, max_results: 20 });
  expect(retrievalOptions(base, { topk: 20 }).topk).toBe(20);
  expect(() => retrievalOptions(base, { topk: 21 })).toThrow('max_results');
  expect(() => retrievalOverridesSchema.parse({ max_results: 30 })).toThrow();
  expect(
    retrievalOptions(retrievalSchema.parse({ max_results: 30 }), { topk: 25 })
      .topk,
  ).toBe(25);
});

it('retains all 20 selected locators and divides text space instead of dropping hits', () => {
  const texts = Array.from({ length: 20 }, () => 'x'.repeat(9000));
  const q = query(texts);
  const result = packResults(
    [q],
    retrievalSchema.parse({ topk: 20 }),
    undefined,
    false,
  );
  expect(result.results).toHaveLength(20);
  expect(result.queries[0]!.returned).toBe(20);
  expect(result.limits).toContain('budget');
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(20000);
  const lengths = result.results.map((e) => e.text.length);
  expect(Math.min(...lengths)).toBeGreaterThan(0);
  expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
  for (const [i, e] of result.results.entries()) {
    expect(e).toMatchObject({
      chunk_id: `chunk-${i}`,
      path: `/notes/${i}.md`,
      source_version: 'a'.repeat(64),
      start_line: 10,
      end_line: 10,
      heading_path: ['Test'],
      matched_query_ids: ['q'],
      text_truncated: true,
    });
    expect(q.candidates[i]!.evidence.text).toBe(texts[i]);
  }
});

it('redistributes short-block surplus without rank-weighting the remaining previews', () => {
  const equal = pack(
    ['x'.repeat(9000), 'x'.repeat(9000), 'x'.repeat(9000)],
    3000,
  );
  const short = pack(['short', 'x'.repeat(9000), 'x'.repeat(9000)], 3000);
  expect(short.results[0]).toMatchObject({
    text: 'short',
    text_truncated: false,
  });
  expect(short.results[1]!.text.length).toBeGreaterThan(
    equal.results[1]!.text.length,
  );
  expect(
    Math.abs(short.results[1]!.text.length - short.results[2]!.text.length),
  ).toBeLessThanOrEqual(1);
});

it('preserves complete text when it fits and locates multiline/partial-line prefixes precisely', () => {
  const text = 'first\n第二行😀' + 'long paragraph '.repeat(1000);
  const full = pack([text], 100000).results[0]!;
  expect(full).toMatchObject({
    text,
    text_truncated: false,
    preview_range: previewRange(10, text),
  });
  const preview = pack([text], 1000).results[0]!;
  expect(preview.text.length).toBeGreaterThan('first\n第二行😀'.length);
  expect(text.startsWith(preview.text)).toBe(true);
  expect(preview).toMatchObject({
    start_line: 10,
    end_line: 11,
    text_truncated: true,
  });
  expect(preview.preview_range).toEqual({
    start_line: 10,
    start_column: 1,
    end_line: 11,
    end_column: preview.text.split('\n')[1]!.length + 1,
  });
});

it('can return metadata-only hits and errors rather than losing hits when metadata does not fit', () => {
  const texts = ['x'.repeat(9000), 'y'.repeat(9000)];
  const empty = pack(texts, 20000);
  empty.results = empty.results.map((e) => ({
    ...e,
    text: '',
    text_truncated: true,
    preview_range: previewRange(e.start_line, ''),
  }));
  empty.limits = ['budget'];
  const budget = JSON.stringify(empty).length;
  const actual = pack(texts, budget);
  expect(actual.results).toHaveLength(2);
  expect(actual.results.every((e) => e.text === '' && e.text_truncated)).toBe(
    true,
  );
  expect(JSON.stringify(actual).length).toBeLessThanOrEqual(budget);
  expect(() => pack(texts, budget - 1)).toThrow(
    'complete selected-hit metadata',
  );
});

it.each([false, true])(
  'counts JSON escaping and never splits emoji, diagnostics=%s',
  (diagnostics) => {
    const text = '\\"\t\n\u0001😀中文'.repeat(1000);
    for (let budget = 2200; budget <= 2500; budget += 7) {
      const result = pack([text, text], budget, diagnostics);
      expect(result.results).toHaveLength(2);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(budget);
      for (const e of result.results) {
        expect(text.startsWith(e.text)).toBe(true);
        expect(e.text).not.toMatch(/[\uD800-\uDBFF]$/);
        expect(e.preview_range).toEqual(previewRange(e.start_line, e.text));
      }
    }
  },
);

it('keeps query association, round-robin selection and source caps before text allocation', () => {
  const a = query(['A'.repeat(4000), 'B'.repeat(4000)], 'a');
  const b = query(['A'.repeat(4000), 'C'.repeat(4000)], 'b');
  b.candidates[1]!.evidence.chunk_id = 'chunk-c';
  b.candidates[1]!.evidence.source_id = 'source-0';
  const result = packResults(
    [a, b],
    retrievalSchema.parse({
      topk: 3,
      max_chunks_per_source: 1,
      max_context_chars: 1500,
    }),
    undefined,
    false,
  );
  expect(result.results.map((e) => e.chunk_id)).toEqual(['chunk-0', 'chunk-1']);
  expect(result.results[0]!.matched_query_ids).toEqual(['a', 'b']);
  expect(result.limits).toContain('source_limit');
  expect(result.results.every((e) => e.text_truncated)).toBe(true);
});

it('exposes a read-more locator when a decisive negation is outside the preview', () => {
  const text =
    'Feature enabled. ' +
    'context '.repeat(1000) +
    '\nNOT enabled in version 2.';
  const full = pack([text], 100000).results[0]!;
  const preview = pack([text], 1000).results[0]!;
  expect(full.text).toContain('NOT enabled');
  expect(preview.text).not.toContain('NOT enabled');
  expect(preview.text_truncated).toBe(true);
  expect(preview.end_line).toBe(11);
  expect(preview.preview_range.end_line).toBe(10);
  expect(preview.source_version).toBe(full.source_version);
});
