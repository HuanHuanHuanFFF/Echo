import { describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openDatabase, databaseCapabilities } from '../src/database.js';
import { loadConfig, parseConfig, retrievalOptions } from '../src/config.js';

import { syncIndex } from '../src/sync.js';
import { searchIndex } from '../src/retrieval.js';

describe('foundation', () => {
  it('persists FTS5 and vec0 data and rolls both back atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'echo-foundation-'));
    const path = join(dir, 'index.sqlite');
    let db = openDatabase(path);
    try {
      expect(databaseCapabilities(db).vector).toMatch(/^v?0\.1\./);
      db.exec(
        'CREATE VIRTUAL TABLE words USING fts5(text); CREATE VIRTUAL TABLE vectors USING vec0(embedding float[3]);',
      );
      db.prepare('INSERT INTO words(rowid,text) VALUES (?,?)').run(
        1n,
        'SQLite evidence',
      );
      db.prepare('INSERT INTO vectors(rowid,embedding) VALUES (?,?)').run(
        1n,
        new Float32Array([1, 0, 0]),
      );
      expect(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO words(rowid,text) VALUES (?,?)').run(
            2n,
            'aborted',
          );
          db.prepare('INSERT INTO vectors(rowid,embedding) VALUES (?,?)').run(
            2n,
            new Float32Array([0, 1, 0]),
          );
          throw new Error('interrupted');
        })(),
      ).toThrow('interrupted');
      db.close();
      db = openDatabase(path);
      expect(
        db
          .prepare(
            "SELECT rowid FROM words WHERE words MATCH 'SQLite' ORDER BY bm25(words)",
          )
          .all(),
      ).toEqual([{ rowid: 1 }]);
      expect(
        db
          .prepare(
            'SELECT rowid FROM vectors WHERE embedding MATCH ? AND k = 2 ORDER BY distance',
          )
          .all(new Float32Array([1, 0, 0])),
      ).toEqual([{ rowid: 1 }]);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('inherits defaults, validates overrides and rejects unknown configuration', () => {
    const cfg = parseConfig({
      retrieval: { topk: 3 },
      chunker: { options: { custom: true } },
    });
    expect(cfg.retrieval.max_chunks_per_source).toBe(6);
    expect(cfg.retrieval.rrf_k).toBe(10);
    expect(cfg.retrieval.max_context_chars).toBe(20000);
    const explicit = parseConfig({
      retrieval: {
        rrf_k: 60,
        max_context_chars: 12000,
        max_chunks_per_source: 3,
      },
    });
    expect(explicit.retrieval.rrf_k).toBe(60);
    expect(explicit.retrieval.max_context_chars).toBe(12000);
    expect(explicit.retrieval.max_chunks_per_source).toBe(3);
    expect(
      retrievalOptions(cfg.retrieval, { rrf_k: 15, max_context_chars: 24000 }),
    ).toMatchObject({ rrf_k: 15, max_context_chars: 24000 });
    expect(cfg.chunker.options).toEqual({ custom: true });
    expect(retrievalOptions(cfg.retrieval, { dense_candidates: 90 }).topk).toBe(
      3,
    );
    expect(() => retrievalOptions(cfg.retrieval, { topk: 0 })).toThrow();
    expect(() => parseConfig({ typo: true })).toThrow();
    expect(() =>
      parseConfig({
        collections: [
          { id: 'a', root: '.' },
          { id: 'a', root: '..' },
        ],
      }),
    ).toThrow();
  });
  it('a real stdio MCP client discovers and calls the tool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'echo-unconfigured-'));
    const client = new Client({ name: 'echo-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        import.meta.resolve('tsx'),
        resolve('src/cli.ts'),
        'serve',
      ],
      cwd: dir,
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      expect(
        (await client.listTools()).tools.map((t) => t.name).sort(),
      ).toEqual(['echo_search', 'echo_status']);
      const result = await client.callTool({
        name: 'echo_status',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(
        JSON.parse((result.content as { text: string }[])[0]!.text),
      ).toMatchObject({ configured: false });
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('copied example configurations keep sibling checkout indexes independent', async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), 'echo-config-copy-')),
  );
  try {
    const example = JSON.parse(
      await readFile('examples/echo.config.example.json', 'utf8'),
    );
    // Exercise the documented copy workflow without contacting a model.
    example.retrieval.mode = 'bm25';
    const configs = [];
    for (const [name, text] of [
      ['checkout-a', 'alphaxylophone'],
      ['checkout-b', 'betazucchini'],
    ]) {
      const checkout = join(dir, name!);
      await mkdir(join(checkout, 'notes'), { recursive: true });
      const path = join(checkout, 'echo.config.json');
      await writeFile(path, JSON.stringify(example));
      await writeFile(join(checkout, 'notes', 'sample.md'), '# Note\n' + text);
      configs.push(await loadConfig(path));
    }
    for (const config of configs) await syncIndex(config);
    for (const [index, query] of ['alphaxylophone', 'betazucchini'].entries()) {
      const result = await searchIndex(configs[index]!, { query });
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.path).toBe(
        join(
          dir,
          index === 0 ? 'checkout-a' : 'checkout-b',
          'notes',
          'sample.md',
        ),
      );
    }
    expect(configs[0]!.database).toBe(
      join(dir, 'checkout-a', '.echo', 'index.sqlite'),
    );
    expect(configs[1]!.database).toBe(
      join(dir, 'checkout-b', '.echo', 'index.sqlite'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
