import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { mapDifyPartition } = await import(
  pathToFileURL(resolve('evals/lib/dify-evidence.mjs')).href
);
it('resolves repeated native segments only with a complete ordered partition', () => {
  const source = { text: 'Same.\n\nMiddle.\n\nSame.' };
  const segments = [
    { id: 'c', position: 3, content: 'Same.' },
    { id: 'a', position: 1, content: 'Same.' },
    { id: 'b', position: 2, content: 'Middle.' },
  ];
  const mapped = mapDifyPartition(segments, source);
  expect(mapped.partition_verified).toBe(true);
  expect(
    mapped.mappings.find((x: { id: string }) => x.id === 'a').mapping.spans,
  ).toEqual([[0, 5]]);
  expect(
    mapped.mappings.find((x: { id: string }) => x.id === 'c').mapping.spans,
  ).toEqual([[16, 21]]);
});
it('does not infer repeated text location from incomplete or unordered native data', () => {
  const source = { text: 'Same.\n\nMiddle.\n\nSame.' };
  const result = mapDifyPartition(
    [{ id: 'a', position: 1, content: 'Same.' }],
    source,
  );
  expect(result.partition_verified).toBe(false);
  expect(result.mappings[0].mapping.status).toBe('ambiguous');
  expect(
    mapDifyPartition(
      [
        { id: 'a', position: 1, content: 'Same.' },
        { id: 'b', position: 1, content: 'Middle.' },
      ],
      source,
    ).partition_verified,
  ).toBe(false);
});

it('maps native cleaner and splitter transformations without crediting removed characters', () => {
  const source = { text: 'Same.\n\nA B <|token|>.\n\nSame.' };
  const result = mapDifyPartition(
    [
      { id: 'a', position: 1, content: 'Same.' },
      { id: 'b', position: 2, content: 'A B <token>.' },
      { id: 'c', position: 3, content: 'Same.' },
    ],
    source,
  );
  expect(result.partition_verified).toBe(true);
  const spans = result.mappings[1].mapping.spans as [number, number][];
  const covered = (index: number) =>
    spans.some(([a, b]) => a <= index && index < b);
  expect(covered(source.text.indexOf('|'))).toBe(false);
  expect(covered(source.text.indexOf('token'))).toBe(true);
});
it('does not permit unexplained word deletion in an otherwise ordered partition', () => {
  const result = mapDifyPartition([{ id: 'a', position: 1, content: 'A B.' }], {
    text: 'A important B.',
  });
  expect(result.partition_verified).toBe(false);
  expect(result.mappings[0].mapping.status).toBe('unmapped');
});

it('permits space collapse only where the native overlong-block fallback reaches the space separator', () => {
  const source = { text: 'A' + ' '.repeat(1025) + 'B' };
  const mapped = mapDifyPartition(
    [{ id: 'a', position: 1, content: 'A B' }],
    source,
  );
  expect(mapped.partition_verified).toBe(true);
  expect(mapped.mappings[0].mapping.spans).toEqual([
    [0, 2],
    [1026, 1027],
  ]);
  expect(
    mapDifyPartition([{ id: 'a', position: 1, content: 'A B' }], {
      text: 'A   B',
    }).partition_verified,
  ).toBe(false);
  expect(
    mapDifyPartition(
      [
        { id: 'a', position: 1, content: 'x'.repeat(1024) },
        { id: 'b', position: 2, content: 'A B' },
      ],
      { text: 'x'.repeat(1024) + '。A   B' },
    ).partition_verified,
  ).toBe(false);
});
