import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { prepareSource, parseSource, uuidV4 } from '../src/identity.js';
import { defaultChunker, runChunker, loadChunker } from '../src/chunker.js';
import { syncIndex } from '../src/sync.js';
import { openDatabase } from '../src/database.js';

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'echo-import-'));
  dirs.push(dir);
  const root = join(dir, 'notes');
  await mkdir(root);
  return {
    dir,
    root,
    config: parseConfig({
      database: join(dir, 'index.sqlite'),
      retrieval: { mode: 'bm25' },
      collections: [{ id: 'test', root }],
    }),
  };
}
function rows(database: string) {
  const db = openDatabase(database);
  try {
    return db
      .prepare(
        'SELECT s.*,c.text,c.chunk_id,c.start_line,c.end_line,c.heading_path FROM sources s JOIN chunks c USING(source_id) ORDER BY c.rowid',
      )
      .all() as {
      source_id: string;
      source_version: string;
      path: string;
      text: string;
      chunk_id: string;
      start_line: number;
      end_line: number;
      heading_path: string;
    }[];
  } finally {
    db.close();
  }
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe('identity and chunks', () => {
  it.each([
    '# Title\n正文\n',
    '\uFEFF---\r\ntitle: 中文 # keep\r\ntags: [a, b]\r\n---\r\n# 标题\r\n内容\r\n',
    '---\n{title: 中文, tags: [a,b]}\n---\n# T\n正文',
    '---\n{}\n---\n正文',
  ])('preserves metadata/body and reuses UUID: %s', async (text) => {
    const { root } = await fixture();
    const path = join(root, 'note.md');
    await writeFile(path, text);
    const source = await prepareSource(path);
    expect(source.wroteId).toBe(true);
    expect(source.sourceId).toMatch(uuidV4);
    const second = await prepareSource(path);
    expect(second.wroteId).toBe(false);
    expect(second.raw).toBe(source.raw);
    const chunks = await runChunker(defaultChunker, {
      sourceId: source.sourceId,
      path,
      lines: source.lines,
      options: {},
    });
    expect(
      chunks.every(
        (c) => !c.text.includes('echo_id') && !c.text.includes(source.sourceId),
      ),
    ).toBe(true);
    for (const chunk of chunks)
      expect(
        parseSource(source.raw)
          .lines.slice(chunk.startLine - 1, chunk.endLine)
          .join('\n'),
      ).toBe(chunk.text);
    if (text.includes('title: 中文 # keep'))
      expect(source.raw).toContain('title: 中文 # keep\r\ntags: [a, b]');
  });
  it('rejects malformed, non-v4, duplicate-key frontmatter before writing', async () => {
    const { root } = await fixture();
    const path = join(root, 'bad.md');
    for (const text of [
      '---\ntitle: x',
      '---\necho_id: invalid\n---\nbody',
      '---\necho_id: a\necho_id: b\n---\nbody',
      '---\n- a\n---\nbody',
    ]) {
      await writeFile(path, text);
      await expect(prepareSource(path)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(text);
    }
  });
  it('tracks heading nesting, fenced headings, and exact long-line ranges', async () => {
    const text =
      '# A\nintro\n## B\n~~~md\n# not heading\n~~~\n' +
      '长'.repeat(90) +
      '\n## C\n尾巴';
    const lines = text.split('\n').map((text, i) => ({ number: i + 1, text }));
    const chunks = await runChunker(defaultChunker, {
      sourceId: 'id',
      path: '',
      lines,
      options: { max_chars: 64 },
    });
    expect(
      chunks.find((c) => c.text.includes('not heading'))!.headingPath,
    ).toEqual(['A', 'B']);
    expect(chunks.at(-1)!.headingPath).toEqual(['A', 'C']);
    for (const c of chunks)
      expect(
        lines
          .slice(c.startLine - 1, c.endLine)
          .map((l) => l.text)
          .join('\n'),
      ).toBe(c.text);
  });
  it('loads a complete custom chunker and rejects fabricated positions', async () => {
    const { dir } = await fixture();
    const module = join(dir, 'chunker.mjs');
    await writeFile(
      module,
      "export default {id:'custom',version:'1',chunk: input=>[{startLine:input.lines[0].number,endLine:input.lines[0].number,headingPath:['custom']}]};",
    );
    const custom = await loadChunker({ module, version: '1', options: {} });
    const input = {
      sourceId: 'id',
      path: '',
      lines: [{ number: 5, text: 'body' }],
      options: {},
    };
    expect((await runChunker(custom.chunker, input))[0]!.text).toBe('body');
    await expect(
      runChunker(
        {
          id: 'bad',
          version: '1',
          chunk: () => [{ startLine: 1, endLine: 5, headingPath: [] }],
        },
        input,
      ),
    ).rejects.toThrow();
  });
});
describe('incremental snapshots', () => {
  it('adds, is idempotent, renames, updates exact ranges, deletes, and rebuilds on configuration change', async () => {
    const { root, config } = await fixture();
    const a = join(root, 'a.md'),
      b = join(root, 'b.md');
    await writeFile(a, '# A\nfirst\n## B\nsecond');
    expect(await syncIndex(config)).toMatchObject({ added: 1, wrote_ids: 1 });
    const first = rows(config.database);
    const id = first[0]!.source_id;
    expect(await syncIndex(config)).toMatchObject({
      unchanged: 1,
      added: 0,
      updated: 0,
    });
    await rename(a, b);
    expect(await syncIndex(config)).toMatchObject({ updated: 1 });
    expect(rows(config.database)[0]).toMatchObject({
      path: await realpath(b),
      source_id: id,
      chunk_id: first[0]!.chunk_id,
    });
    await writeFile(
      b,
      (await readFile(b, 'utf8')).replace('first', 'changed\nline'),
    );
    await syncIndex(config);
    for (const c of rows(config.database))
      expect(
        (await readFile(b, 'utf8'))
          .split('\n')
          .slice(c.start_line - 1, c.end_line)
          .join('\n'),
      ).toBe(c.text);
    config.chunker.version = '2';
    expect(await syncIndex(config)).toMatchObject({ updated: 1, unchanged: 0 });
    await rm(b);
    expect(await syncIndex(config)).toMatchObject({ removed: 1, chunks: 0 });
    expect(rows(config.database)).toEqual([]);
  });
  it('duplicate IDs and failed chunking roll back the whole index; written IDs survive retry', async () => {
    const { root, dir, config } = await fixture();
    const a = join(root, 'a.md'),
      b = join(root, 'b.md');
    await writeFile(a, '# A\nold');
    await syncIndex(config);
    const before = rows(config.database);
    await writeFile(b, await readFile(a, 'utf8'));
    await expect(syncIndex(config)).rejects.toThrow('Duplicate echo_id');
    expect(rows(config.database)).toEqual(before);
    await writeFile(b, '# B\nnew');
    const module = join(dir, 'fail.mjs');
    await writeFile(
      module,
      "export default {id:'fail',version:'1',chunk:()=>{throw new Error('injected failure')}};",
    );
    config.chunker.module = module;
    await expect(syncIndex(config)).rejects.toThrow('injected failure');
    expect(rows(config.database)).toEqual(before);
    delete config.chunker.module;
    expect(await syncIndex(config)).toMatchObject({ added: 1 });
    const stable = await readFile(b, 'utf8');
    await syncIndex(config);
    expect(await readFile(b, 'utf8')).toBe(stable);
  });
  it('aborted sync preserves previous data and missing roots do not mean deletion', async () => {
    const { root, config } = await fixture();
    await writeFile(join(root, 'a.md'), '# A\nold');
    await syncIndex(config);
    const before = rows(config.database);
    const controller = new AbortController();
    controller.abort();
    await expect(syncIndex(config, controller.signal)).rejects.toThrow();
    expect(rows(config.database)).toEqual(before);
    config.collections[0]!.root = join(root, 'missing');
    await expect(syncIndex(config)).rejects.toThrow();
    expect(rows(config.database)).toEqual(before);
  });
});

it('survives abrupt process exit after UUID write-back and retries without changing identity', async () => {
  const { root, dir, config } = await fixture();
  await writeFile(join(root, 'old.md'), '# old\ncommitted');
  await syncIndex(config);
  const before = rows(config.database);
  const fresh = join(root, '0-new.md');
  await writeFile(fresh, '# new\nuncommitted');
  const module = join(dir, 'exit.mjs');
  await writeFile(
    module,
    "export default {id:'exit',version:'1',chunk:()=>process.exit(17)}",
  );
  const configPath = join(dir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({ ...config, chunker: { ...config.chunker, module } }),
  );
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await expect(
    promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'sync',
      '--config',
      configPath,
    ]),
  ).rejects.toMatchObject({ code: 17 });
  expect(rows(config.database)).toEqual(before);
  const persistedId = parseSource(await readFile(fresh, 'utf8')).sourceId;
  expect(persistedId).toMatch(uuidV4);
  await syncIndex(config);
  expect(rows(config.database).some((r) => r.source_id === persistedId)).toBe(
    true,
  );
});

it('indexes a custom module and rebuilds when its source changes', async () => {
  const { root, dir, config } = await fixture();
  const path = join(root, 'custom.md');
  await writeFile(path, '# title\nfirst paragraph\n\nlast paragraph');
  const module = join(dir, 'custom.mjs');
  await writeFile(
    module,
    "export default {id:'custom',version:'1',chunk:({lines})=>[{startLine:lines[1].number,endLine:lines[1].number,headingPath:[]}]}",
  );
  config.chunker.module = module;
  expect(await syncIndex(config)).toMatchObject({ added: 1, chunks: 1 });
  expect(rows(config.database)[0]!.text).toBe('first paragraph');
  await writeFile(
    module,
    "export default {id:'custom',version:'1',chunk:({lines})=>[{startLine:lines.at(-1).number,endLine:lines.at(-1).number,headingPath:[]}]}",
  );
  expect(await syncIndex(config)).toMatchObject({ updated: 1 });
  expect(rows(config.database)[0]!.text).toBe('last paragraph');
});

it('does not allow a custom chunker to change the quoted source text', async () => {
  const input = {
    sourceId: 'uuid',
    path: '',
    lines: [{ number: 1, text: 'original' }],
    options: {},
  };
  const chunker = {
    id: 'mutating',
    version: '1',
    chunk() {
      input.lines[0]!.text = 'fabricated';
      return [{ startLine: 1, endLine: 1, headingPath: [] }];
    },
  };
  expect((await runChunker(chunker, input))[0]!.text).toBe('original');
});

it('rejects invalid UTF-8 without rewriting file bytes or replacing the index', async () => {
  const { root, config } = await fixture();
  const path = join(root, 'bad.md');
  await writeFile(path, '# Valid\nold');
  await syncIndex(config);
  const before = rows(config.database);
  const bytes = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
  await writeFile(path, bytes);
  await expect(syncIndex(config)).rejects.toThrow();
  expect(await readFile(path)).toEqual(bytes);
  expect(rows(config.database)).toEqual(before);
});

it('refreshes relative_path when the same collection changes its root', async () => {
  const { dir, root, config } = await fixture();
  await writeFile(join(root, 'a.md'), '# A\nbody');
  await syncIndex(config);
  config.collections[0]!.root = dir;
  await syncIndex(config);
  const db = openDatabase(config.database);
  try {
    expect(db.prepare('SELECT relative_path FROM sources').get()).toEqual({
      relative_path: 'notes/a.md',
    });
  } finally {
    db.close();
  }
});
it('indexes ordinary body headings mentioning echo_id', async () => {
  const { root, config } = await fixture();
  await writeFile(
    join(root, 'identity.md'),
    '# echo_id handling\nUUID documentation',
  );
  await expect(syncIndex(config)).resolves.toMatchObject({ added: 1 });
  expect(rows(config.database)[0]!.text).toContain('# echo_id handling');
});

it.each([
  '  title: A\n',
  '!!map\ntitle: A\n',
  '&root\ntitle: A\n',
  '!!map\n  title: A\n',
])(
  'preserves valid block mapping prefixes and indentation: %s',
  async (yaml) => {
    const { root } = await fixture();
    const path = join(root, 'yaml.md');
    const original = '---\n' + yaml + '---\n# Body\ncontent';
    await writeFile(path, original);
    const prepared = await prepareSource(path);
    expect(prepared.sourceId).toMatch(uuidV4);
    expect(prepared.raw).toContain(yaml);
    expect(prepared.raw.endsWith('---\n# Body\ncontent')).toBe(true);
  },
);

it.skipIf(process.platform === 'win32')(
  'preserves note permissions when UUID insertion runs under a restrictive umask',
  async () => {
    const { root } = await fixture();
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    // A child process owns its umask; changing it in a Vitest worker is unsupported.
    const child = `
      import { prepareSource } from ${JSON.stringify(import.meta.resolve('../src/identity.ts'))};
      process.umask(0o077);
      const prepared = await prepareSource(process.argv[1]);
      console.log(JSON.stringify({ wroteId: prepared.wroteId, sourceId: prepared.sourceId }));
    `;
    for (const mode of [0o666, 0o640, 0o600]) {
      const path = join(root, 'mode-' + mode.toString(8) + '.md');
      await writeFile(path, '# Note\noriginal text\n');
      await chmod(path, mode);
      const run = () =>
        promisify(execFile)(process.execPath, [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          child,
          path,
        ]);
      const first = JSON.parse((await run()).stdout);
      expect(first.wroteId).toBe(true);
      expect(first.sourceId).toMatch(uuidV4);
      expect((await lstat(path)).mode & 0o777).toBe(mode);
      const raw = await readFile(path, 'utf8');
      expect(raw).toContain('# Note\noriginal text\n');
      const second = JSON.parse((await run()).stdout);
      expect(second).toEqual({ wroteId: false, sourceId: first.sourceId });
      expect((await lstat(path)).mode & 0o777).toBe(mode);
      expect(await readFile(path, 'utf8')).toBe(raw);
    }
  },
);

it('applies declared scan policies through the legacy compatibility entrypoint too', async () => {
  const { root, config } = await fixture();
  await mkdir(join(root, 'private'));
  const excluded = join(root, 'private/skip.md');
  await writeFile(excluded, 'private unchanged');
  await writeFile(join(root, 'keep.md'), '# Public\napple');
  config.collections[0]!.exclude = ['private/**'];
  config.collections[0]!.max_file_bytes = 1000;
  expect(await syncIndex(config)).toMatchObject({ added: 1 });
  expect(await readFile(excluded, 'utf8')).toBe('private unchanged');
  await writeFile(join(root, 'large.md'), 'x'.repeat(1001));
  await expect(syncIndex(config)).rejects.toThrow('max_file_bytes');
});
