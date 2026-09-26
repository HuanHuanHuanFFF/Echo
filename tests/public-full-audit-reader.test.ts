import { it, expect } from 'vitest';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { rows } = await import(
  pathToFileURL(resolve('evals/audit-public-full-cap6.mjs')).href
);

it('preserves Unicode separators inside JSON strings when reading CRLF JSONL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-full-audit-'));
  const file = join(dir, 'corpus.jsonl');
  const expected = [
    { id: 'one', text: 'left\u2028middle\u2029right' },
    { id: 'two', text: 'escaped\nline\rreturn' },
  ];
  await writeFile(
    file,
    expected.map((row) => JSON.stringify(row)).join('\r\n'),
  );
  try {
    await expect(rows(file)).resolves.toEqual(expected);
  } finally {
    await unlink(file);
    await rmdir(dir);
  }
});
