import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadChunker, runChunker } from '../src/chunker.js';
import { loadConfig } from '../src/config.js';
import { initializeWorkspace, useProfiles } from '../src/profile-manager.js';
import { syncIndex } from '../src/sync.js';
import { searchIndex } from '../src/retrieval.js';

const modulePath = resolve(
  'examples/profiles/chunkers/markdown-structure-v1.mjs',
);
const sourceId = '123e4567-e89b-42d3-a456-426614174000';
const { chunker } = await loadChunker({
  module: modulePath,
  version: '1',
  options: {},
});
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function split(text: string) {
  const lines = text.split('\n').map((text, i) => ({ text, number: i + 10 }));
  const chunks = await runChunker(chunker, {
    sourceId,
    path: 'fixture.md',
    lines,
    options: {},
  });
  for (const line of lines.filter((l) => l.text.trim())) {
    expect(
      chunks.some(
        (c) => c.startLine <= line.number && c.endLine >= line.number,
      ),
    ).toBe(true);
  }
  expect(new Set(chunks.map((c) => c.startLine + ':' + c.endLine)).size).toBe(
    chunks.length,
  );
  for (const c of chunks) {
    expect(c.text).toBe(
      lines
        .filter((l) => l.number >= c.startLine && l.number <= c.endLine)
        .map((l) => l.text)
        .join('\n'),
    );
    if (c.text.length > 1500) expect(c.startLine).toBe(c.endLine);
  }
  return chunks;
}
it('packs complete code with preceding prose when the combined size fits the soft allowance', async () => {
  const code = '~~~js\n' + 'x'.repeat(590) + '\n~~~';
  const chunks = await split('# Topic\n' + '前'.repeat(700) + '\n\n' + code);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.text).toContain(code);
  expect(chunks[0]!.text.length).toBeGreaterThan(1000);
});
it('moves a fitting code block intact when preceding prose leaves too little space', async () => {
  const code = '\x60\x60\x60js\n' + 'x'.repeat(800) + '\n\x60\x60\x60';
  const chunks = await split('# Topic\n' + '前'.repeat(900) + '\n\n' + code);
  expect(chunks).toHaveLength(2);
  expect(chunks[1]!.text).toBe(code);
  expect(chunks[1]!.startLine).toBeGreaterThan(chunks[0]!.endLine);
});
it('protects headings and blank lines inside both fence styles and keeps unclosed fences', async () => {
  for (const fence of ['\x60\x60\x60', '~~~~']) {
    const code = fence + 'md\n# fake\n\n## also fake\n' + fence;
    const chunks = await split('# Real\n' + code + '\n## Next\ntext');
    expect(chunks.some((c) => c.text.includes(code))).toBe(true);
    expect(chunks.flatMap((c) => c.headingPath)).not.toContain('fake');
  }
  const unclosed = await split('# Real\n~~~md\n## stays code\nlast');
  expect(unclosed).toHaveLength(1);
  expect(unclosed[0]!.headingPath).toEqual(['Real']);
});
it('supports setext headings while retaining their exact original lines', async () => {
  const chunks = await split('Title\n=====\n\nSub\n---\ncontent');
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.headingPath).toEqual(['Title', 'Sub']);
  expect(chunks[0]!.text).toContain('Sub\n---');
});
it('merges adjacent short leaf sections only under the same explicit parent', async () => {
  const chunks = await split(
    '# Root\n## Benefits\n' + 'a'.repeat(80) + '\n## Costs\n' + 'b'.repeat(80),
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.headingPath).toEqual(['Root']);
  expect(chunks[0]!.text).toContain('## Benefits');
  expect(chunks[0]!.text).toContain('## Costs');
  const separate = await split('# Root A\nshort\n# Root B\nshort');
  expect(separate).toHaveLength(2);
});
it('keeps substantial sibling sections separate and attaches empty ancestor titles', async () => {
  const chunks = await split(
    '# Root\n## A\n' + 'a'.repeat(300) + '\n## B\n' + 'b'.repeat(300),
  );
  expect(chunks).toHaveLength(2);
  const child = await split('# Root\n## Parent\n### Child\nbody');
  expect(child).toHaveLength(1);
  expect(child[0]!.text).toBe('# Root\n## Parent\n### Child\nbody');
  expect(child[0]!.sectionStartLine).toBe(10);
});
it('preserves an intact table or list instead of cutting it to fill the previous chunk', async () => {
  const table =
    '| key | value |\n| --- | --- |\n' +
    Array.from(
      { length: 5 },
      (_, i) => '| ' + i + ' | ' + 'x'.repeat(145) + ' |',
    ).join('\n');
  const tableChunks = await split(
    '# Table\n' + '前'.repeat(900) + '\n\n' + table,
  );
  expect(tableChunks.some((c) => c.text.includes(table))).toBe(true);
  const list = Array.from(
    { length: 6 },
    (_, i) => '- item ' + i + ' ' + 'x'.repeat(120),
  ).join('\n');
  const listChunks = await split('# List\n' + '前'.repeat(900) + '\n\n' + list);
  expect(listChunks.some((c) => c.text.includes(list))).toBe(true);
});
it('uses original-line overlap only when an individual unit is oversized', async () => {
  const code =
    '~~~js\n' +
    Array.from(
      { length: 35 },
      (_, i) => 'line' + i + ' ' + 'x'.repeat(85),
    ).join('\n') +
    '\n~~~';
  const chunks = await split('# Code\n' + code);
  expect(chunks.length).toBeGreaterThan(2);
  expect(
    chunks.some((c, i) => i > 0 && c.startLine <= chunks[i - 1]!.endLine),
  ).toBe(true);
  expect(chunks.filter((c) => c.text.includes('~~~js'))).toHaveLength(1);
});
it('preserves oversized single lines, isolated titles and empty input without looping', async () => {
  const line = '😀'.repeat(1100);
  const chunks = await split('# Large\n' + line);
  expect(chunks.some((c) => c.text === line)).toBe(true);
  expect(await split('# Only title')).toHaveLength(1);
  expect(await split('')).toEqual([]);
});
it('retains all nonblank source lines across deterministic mixed-structure cases', async () => {
  let state = 71;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0);
  for (let n = 0; n < 80; n++) {
    const parts = ['# Root'];
    for (let k = 0; k < 12; k++) {
      const length = (next() % 2100) + 1;
      const body = '文'.repeat(length);
      switch (next() % 5) {
        case 0:
          parts.push('## Section ' + k, body);
          break;
        case 1:
          parts.push('~~~txt', body, '', '# still code', '~~~');
          break;
        case 2:
          parts.push('- first', '  continuation', '- ' + body);
          break;
        case 3:
          parts.push('> ' + body);
          break;
        default:
          parts.push(body);
      }
      parts.push('');
    }
    await split(parts.join('\n'));
  }
});
it('loads as a v2 strategy, indexes locally and returns exact source evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-structure-strategy-'));
  dirs.push(dir);
  const configPath = join(dir, 'echo.config.json');
  await initializeWorkspace(configPath);
  await copyFile(modulePath, join(dir, 'chunkers/markdown-structure-v1.mjs'));
  await mkdir(join(dir, 'notes'));
  const raw =
    '---\necho_id: ' +
    sourceId +
    '\n---\n# Database\n## Rollback\nrollback transaction failure\n## Resume\nresume from checkpoint\n';
  const note = join(dir, 'notes/note.md');
  await writeFile(note, raw);
  await writeFile(
    join(dir, 'config/sources.json'),
    JSON.stringify({ collections: [{ id: 'test', root: 'notes' }] }),
  );
  await useProfiles(configPath, {
    chunker: 'markdown-structure-v1',
    retrieval: 'bm25',
  });
  const config = await loadConfig(configPath);
  await syncIndex(config);
  const result = await searchIndex(config, { query: 'rollback' });
  expect(result.status).toBe('ok');
  expect(result.results).toHaveLength(1);
  expect(result.results[0]!.source_id).toBe(sourceId);
  expect(result.results[0]!.text).toBe(
    raw
      .split('\n')
      .slice(result.results[0]!.start_line - 1, result.results[0]!.end_line)
      .join('\n'),
  );
  expect(await readFile(note, 'utf8')).toBe(raw);
});

it('retains a long heading in original evidence while bounding its display metadata safely', async () => {
  const title = '😀'.repeat(1100);
  const chunks = await split('# ' + title + '\nbody');
  expect(chunks.some((c) => c.text === '# ' + title)).toBe(true);
  for (const c of chunks)
    for (const heading of c.headingPath) {
      expect(heading.length).toBeLessThanOrEqual(2000);
      expect(heading.endsWith('…')).toBe(true);
      expect(heading).not.toMatch(/[\ud800-\udbff]…$/);
    }
});

it('recognizes indented pipe text as code before testing table syntax', async () => {
  const code = [
    '    a | b ' + 'x'.repeat(390),
    '    --- | ---',
    '    c | d ' + 'y'.repeat(390),
    '    tail ' + 'z'.repeat(390),
  ].join('\n');
  const chunks = await split('# R\n' + 'p'.repeat(600) + '\n\n' + code);
  expect(chunks.some((c) => c.text === code)).toBe(true);
  const oversized = await split(
    '# R\n' + code + '\n    more ' + 'q'.repeat(390),
  );
  expect(
    oversized.some((c, i) => i > 0 && c.startLine <= oversized[i - 1]!.endLine),
  ).toBe(true);
});
