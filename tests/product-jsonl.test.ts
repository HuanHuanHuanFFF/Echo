import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const { readJsonl } = await import(
  pathToFileURL(path.resolve('evals/lib/product-jsonl.mjs')).href
);
it('preserves Unicode separators inside JSON strings and accepts CRLF and final unterminated record', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-jsonl-'));
  try {
    const expected = [
      { id: 'one', text: 'before\u2028middle\u2029after' },
      { id: 'two', text: 'line\r\nnext' },
    ];
    const file = path.join(dir, 'input.jsonl');
    await fs.writeFile(
      file,
      expected.map((value) => JSON.stringify(value)).join('\r\n'),
    );
    const actual = [];
    for await (const row of readJsonl(file)) actual.push(row);
    expect(actual).toEqual(expected);
  } finally {
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it('reports malformed record position without echoing source text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-jsonl-'));
  try {
    const file = path.join(dir, 'input.jsonl');
    await fs.writeFile(file, '{}\nsecret-invalid-body\n');
    const collect = async () => {
      for await (const _row of readJsonl(file)) {
        /* consume */
      }
    };
    await expect(collect()).rejects.toThrow('invalid JSONL at ' + file + ':2');
    await expect(collect()).rejects.not.toThrow('secret-invalid-body');
  } finally {
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
