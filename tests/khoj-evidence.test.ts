import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { mapKhojCompiled } = await import(
  pathToFileURL(resolve('evals/lib/khoj-evidence.mjs')).href
);
const { spansCover } = await import(
  pathToFileURL(resolve('evals/lib/product-evidence.mjs')).href
);

it('maps native filename decoration and shifted heading without crediting unreturned parent text', () => {
  const source = {
    relative_path: 'notes/a.md',
    text: '# Alpha\n\nFirst evidence.\n\nSecond evidence.',
  };
  const native = {
    file: source.relative_path,
    heading: '# notes/a.md\n## Alpha',
    entry: source.text,
  };
  const mapped = mapKhojCompiled(
    '# notes/a.md\n## Alpha\n\nFirst evidence.',
    source,
    native,
  );
  expect(mapped.status).toBe('mapped');
  expect(spansCover(mapped.spans, 0, 7)).toBe(true);
  const later = source.text.indexOf('Second');
  expect(spansCover(mapped.spans, later, source.text.length)).toBe(false);
});

it('maps a later child with repeated heading but does not credit preceding evidence', () => {
  const source = {
    relative_path: 'a.md',
    text: '# Alpha\n\nFirst evidence.\n\nSecond evidence.',
  };
  const native = {
    file: 'a.md',
    heading: '# a.md\n## Alpha',
    entry: source.text,
  };
  const mapped = mapKhojCompiled(
    '# a.md\n## Alpha\nSecond evidence.',
    source,
    native,
  );
  expect(mapped.status).toBe('mapped');
  const first = source.text.indexOf('First');
  expect(spansCover(mapped.spans, first, first + 5)).toBe(false);
  const second = source.text.indexOf('Second');
  expect(spansCover(mapped.spans, second, source.text.length)).toBe(true);
});

it('never credits a long word removed by the native parser', () => {
  const long = 'x'.repeat(501);
  const source = {
    relative_path: 'a.md',
    text: '# A\nBefore ' + long + '\nAfter.',
  };
  const native = { file: 'a.md', heading: '# a.md\n## A', entry: source.text };
  const mapped = mapKhojCompiled('# a.md\n## A\nBefore After.', source, native);
  expect(mapped.status).toBe('mapped');
  const start = source.text.indexOf(long);
  expect(spansCover(mapped.spans, start, start + long.length)).toBe(false);
});

it('rejects a mismatched source file and arbitrary injected text', () => {
  const source = { relative_path: 'a.md', text: '# A\nEvidence.' };
  expect(
    mapKhojCompiled('# b.md\n## A\nEvidence.', source, {
      file: 'b.md',
      entry: source.text,
    }).status,
  ).toBe('native-file-mismatch');
  expect(
    mapKhojCompiled('Invented. Evidence.', source, {
      file: 'a.md',
      entry: source.text,
    }).status,
  ).not.toBe('mapped');
});

it('uses Python code-point slicing for a repeated heading tail', () => {
  const source = {
    relative_path: 'a.md',
    text: '# ' + '😀'.repeat(110) + '\n\nFirst.\n\nSecond.',
  };
  const native = {
    file: 'a.md',
    heading: '# a.md\n## ' + '😀'.repeat(110),
    entry: source.text,
  };
  const mapped = mapKhojCompiled(
    '😀'.repeat(100) + '\nSecond.',
    source,
    native,
  );
  expect(mapped.status).toBe('mapped');
  const second = source.text.indexOf('Second.');
  expect(spansCover(mapped.spans, second, source.text.length)).toBe(true);
  expect(spansCover(mapped.spans, 2, 22)).toBe(false);
});

it('maps a heading that Khoj parses inside a fenced code block', () => {
  const filler = Array.from({ length: 260 }, (_, index) => 'word' + index).join(
    ' ',
  );
  const fence = String.fromCharCode(96).repeat(3);
  const source = {
    relative_path: 'a.md',
    text: [
      '# Large',
      filler,
      fence + 'markdown',
      '# In code',
      'Evidence inside fence.',
      fence,
    ].join('\n'),
  };
  const native = {
    file: source.relative_path,
    entry: '# In code\nEvidence inside fence.\n' + fence,
    heading: '# a.md\n## In code',
  };
  const mapped = mapKhojCompiled(
    '# a.md\n## In code\nEvidence inside fence.\n' + fence,
    source,
    native,
  );

  expect(mapped.status).toBe('mapped');
  const heading = source.text.indexOf('# In code');
  expect(spansCover(mapped.spans, heading, heading + '# In code'.length)).toBe(
    true,
  );
  const unreturnedParent = source.text.indexOf('word0');
  expect(
    spansCover(
      mapped.spans,
      unreturnedParent,
      unreturnedParent + 'word0'.length,
    ),
  ).toBe(false);
});

it('mirrors Khoj splitting every literal first-line occurrence', () => {
  const filler = Array.from({ length: 260 }, (_, index) => 'word' + index).join(
    ' ',
  );
  const source = {
    relative_path: 'a.md',
    text: [
      '# Large',
      filler,
      '# Repeated',
      'Evidence # Repeated elsewhere.',
    ].join('\n'),
  };
  const native = {
    file: source.relative_path,
    entry: '# Repeated\nEvidence \n elsewhere.',
    heading: '# a.md\n## Repeated',
  };
  const mapped = mapKhojCompiled(
    '# a.md\n## Repeated\nEvidence \n elsewhere.',
    source,
    native,
  );

  expect(mapped.status).toBe('mapped');
  const removedOccurrence = source.text.lastIndexOf('# Repeated');
  expect(
    spansCover(
      mapped.spans,
      removedOccurrence,
      removedOccurrence + '# Repeated'.length,
    ),
  ).toBe(false);
  const evidence = source.text.indexOf('Evidence');
  expect(spansCover(mapped.spans, evidence, evidence + 'Evidence'.length)).toBe(
    true,
  );
});

it('uses Khoj last-wins order for identical compiled entries', () => {
  const filler = Array.from({ length: 260 }, (_, index) => 'word' + index).join(
    ' ',
  );
  const source = {
    relative_path: 'a.md',
    text: [
      '# Large',
      filler,
      '# Duplicate',
      'Evidence once.',
      '# Duplicate',
      'Evidence once.',
    ].join('\n'),
  };
  const mapped = mapKhojCompiled(
    '# a.md\n## Duplicate\nEvidence once.',
    source,
    {
      file: source.relative_path,
      entry: '# Duplicate\nEvidence once.',
      heading: '# a.md\n## Duplicate',
    },
  );

  expect(mapped.status).toBe('mapped');
  const firstHeading = source.text.indexOf('# Duplicate');
  const lastHeading = source.text.lastIndexOf('# Duplicate');
  expect(
    spansCover(mapped.spans, firstHeading, firstHeading + '# Duplicate'.length),
  ).toBe(false);
  expect(
    spansCover(mapped.spans, lastHeading, lastHeading + '# Duplicate'.length),
  ).toBe(true);
  const firstEvidence = source.text.indexOf('Evidence once.');
  const lastEvidence = source.text.lastIndexOf('Evidence once.');
  expect(
    spansCover(mapped.spans, firstEvidence, firstEvidence + 'Evidence'.length),
  ).toBe(false);
  expect(
    spansCover(mapped.spans, lastEvidence, lastEvidence + 'Evidence'.length),
  ).toBe(true);
});
it('removes NUL from Khoj raw and compiled text without crediting it', () => {
  const source = {
    relative_path: 'a.md',
    text: '# A\nBefore\0After.',
  };
  const mapped = mapKhojCompiled('# a.md\n## A\nBeforeAfter.', source, {
    file: source.relative_path,
    entry: '# A\nBeforeAfter.',
    heading: '# a.md\n## A',
  });

  expect(mapped.status).toBe('mapped');
  const nul = source.text.indexOf('\0');
  expect(spansCover(mapped.spans, nul, nul + 1)).toBe(false);
  const before = source.text.indexOf('Before');
  const after = source.text.indexOf('After');
  expect(spansCover(mapped.spans, before, before + 6)).toBe(true);
  expect(spansCover(mapped.spans, after, after + 5)).toBe(true);
});

it('maps a snipped heading that starts inside the filename prefix', () => {
  const title = 'H'.repeat(91);
  const source = {
    relative_path: 'a.md',
    text: '# ' + title + '\n\nFirst evidence.\n\nSecond evidence.',
  };
  const native = {
    file: source.relative_path,
    entry: source.text,
    heading: '# a.md\n## ' + title,
  };
  const shortHeading = [...native.heading].slice(-100).join('');
  expect(shortHeading.startsWith(' ')).toBe(true);

  const mapped = mapKhojCompiled(
    shortHeading + '\nSecond evidence.',
    source,
    native,
  );

  expect(mapped.status).toBe('mapped');
  const first = source.text.indexOf('First evidence.');
  const second = source.text.indexOf('Second evidence.');
  expect(spansCover(mapped.spans, first, first + 'First'.length)).toBe(false);
  expect(spansCover(mapped.spans, second, second + 'Second'.length)).toBe(true);
});
