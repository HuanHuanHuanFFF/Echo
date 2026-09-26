import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  realpath,
  stat,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initializeWorkspace, useProfiles } from '../src/profile-manager.js';
import {
  loadConfig,
  parseConfig,
  retrievalOptions,
  retrievalOverridesSchema,
} from '../src/config.js';
import { readStatus } from '../src/status.js';
import { searchIndex } from '../src/retrieval.js';
import { syncIndex } from '../src/sync.js';
import { installOptionalProfiles } from './helpers/optional-profiles.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'echo-agent-')));
  dirs.push(dir);
  const configPath = join(dir, 'echo.config.json'),
    root = join(dir, 'notes');
  await mkdir(root);
  await initializeWorkspace(configPath);
  await writeFile(
    join(dir, 'config/sources.json'),
    JSON.stringify({
      collections: [
        {
          id: 'notes',
          root: 'notes',
          include: ['**/*.md'],
          exclude: ['ignored/**'],
        },
      ],
    }),
  );
  await writeFile(
    join(dir, 'config/retrieval/balanced.json'),
    JSON.stringify({ id: 'balanced', mode: 'bm25', topk: 7, rrf_k: 13 }),
  );
  await writeFile(
    join(root, 'a.md'),
    '# Apples\nApple storage uses a cool room.\n\n## Safety\nApple handling requires clean hands.\n',
  );
  await writeFile(
    join(root, 'b.md'),
    '# Bananas\nBanana storage uses a dry room.\n',
  );
  const config = await loadConfig(configPath);
  await syncIndex(config);
  return { dir, configPath, root, config };
}
it('reports an unchecked queryable index, then compares real source hashes without writes or API calls', async () => {
  const { config, root } = await fixture();
  const original = await readFile(join(root, 'a.md'), 'utf8');
  const dbBefore = await readFile(config.database);
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('No network allowed'));
  const quick = await readStatus(config);
  expect(quick).toMatchObject({
    ready: true,
    needs_sync: null,
    freshness: { state: 'unchecked' },
    collections: [{ id: 'notes', indexed_sources: 2 }],
  });
  expect(quick.last_sync).toMatch(/^\d{4}-/);
  const checked = await readStatus(config, { check_sources: true });
  expect(checked).toMatchObject({
    ready: true,
    needs_sync: false,
    freshness: {
      state: 'unchanged',
      files_checked: 2,
      changes: { added: 0, modified: 0, removed: 0 },
    },
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(original);
  expect(await readFile(config.database)).toEqual(dbBefore);
});
it('detects same-size edits with restored mtime and reports source freshness separately from ready', async () => {
  const { config, root } = await fixture();
  const path = join(root, 'a.md'),
    before = await stat(path);
  const raw = await readFile(path, 'utf8');
  await writeFile(path, raw.replace('cool', 'warm'));
  await utimes(path, before.atime, before.mtime);
  expect(await readStatus(config, { check_sources: true })).toMatchObject({
    ready: true,
    needs_sync: true,
    freshness: { state: 'changed', changes: { modified: 1 } },
  });
  await syncIndex(config);
  expect(await readStatus(config, { check_sources: true })).toMatchObject({
    needs_sync: false,
    freshness: { state: 'unchanged' },
  });
});
it('detects additions, removals and path moves, respects scan policy, and never inserts UUIDs', async () => {
  const { config, root } = await fixture();
  await rename(join(root, 'a.md'), join(root, 'moved.md'));
  await rm(join(root, 'b.md'));
  const fresh = '# Fresh\nA new unsynchronized note.\n';
  await writeFile(join(root, 'new.md'), fresh);
  await mkdir(join(root, 'ignored'));
  await writeFile(join(root, 'ignored/noise.md'), '# Ignore this');
  expect(await readStatus(config, { check_sources: true })).toMatchObject({
    needs_sync: true,
    freshness: {
      state: 'changed',
      files_checked: 2,
      changes: { added: 2, modified: 0, removed: 2 },
    },
  });
  expect(await readFile(join(root, 'new.md'), 'utf8')).toBe(fresh);
});
it('cannot claim unchanged when a root is unavailable, a file is oversized or UTF-8 is invalid', async () => {
  const { config, root } = await fixture();
  const limit = {
    ...config,
    collections: config.collections.map((c) => ({ ...c, max_file_bytes: 1 })),
  };
  expect(
    (await readStatus(limit, { check_sources: true })).freshness.state,
  ).toBe('unknown');
  await writeFile(join(root, 'a.md'), Buffer.from([0xff, 0xfe]));
  expect(await readStatus(config, { check_sources: true })).toMatchObject({
    needs_sync: null,
    freshness: { state: 'unknown' },
  });
  await rename(root, root + '-offline');
  expect(await readStatus(config, { check_sources: true })).toMatchObject({
    ready: true,
    needs_sync: null,
    freshness: { state: 'unknown' },
  });
});
it('reports missing selected indexes and missing databases without building them', async () => {
  const { dir, configPath, config } = await fixture();
  await installOptionalProfiles(dir);
  await useProfiles(configPath, { chunker: 'heading-500' });
  expect(
    await readStatus(await loadConfig(configPath), { check_sources: true }),
  ).toMatchObject({
    ready: false,
    needs_sync: true,
    freshness: { state: 'unknown' },
  });
  const database = join(dir, 'never-created.sqlite');
  expect(
    await readStatus({ ...config, database }, { check_sources: true }),
  ).toMatchObject({ ready: false, needs_sync: true });
  await expect(stat(database)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    readStatus(config, { check_sources: true }, AbortSignal.abort()),
  ).rejects.toThrow();
});
it('keeps configured override values and removes metadata before packing the visible budget', async () => {
  const { config } = await fixture();
  expect(retrievalOverridesSchema.parse({ topk: 2 })).toEqual({ topk: 2 });
  expect(retrievalOptions(config.retrieval, { topk: 2 })).toMatchObject({
    topk: 2,
    rrf_k: 13,
  });
  const query = 'apple banana';
  const compact = await searchIndex(config, { query });
  const debug = await searchIndex(config, { query, diagnostics: true });
  expect(compact.results.map((e) => e.chunk_id)).toEqual(
    debug.results.map((e) => e.chunk_id),
  );
  for (const key of ['applied', 'selection', 'excluded'])
    expect(compact).not.toHaveProperty(key);
  expect(compact.results[0]).not.toHaveProperty('relative_path');
  expect(compact.results[0]).not.toHaveProperty('rankings');
  expect(compact.queries[0]).not.toHaveProperty('candidates');
  expect(debug).toHaveProperty('applied.rrf_k', 13);
  expect(debug.results[0]).toHaveProperty('rankings');
  const budget = JSON.stringify(compact).length;
  const bounded = await searchIndex(config, {
    query,
    overrides: { max_context_chars: budget },
  });
  const boundedDebug = await searchIndex(config, {
    query,
    diagnostics: true,
    overrides: { max_context_chars: budget },
  });
  expect(bounded.results).toHaveLength(compact.results.length);
  expect(boundedDebug.results.length).toBeLessThan(bounded.results.length);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(budget);
  expect(JSON.stringify(boundedDebug).length).toBeLessThanOrEqual(budget);
});
it('explains budget-empty and no-candidate results without pretending to judge answerability', async () => {
  const { config } = await fixture();
  const small = await searchIndex(config, {
    query: 'apple',
    overrides: { max_context_chars: 256 },
  });
  expect(small).toMatchObject({
    status: 'ok',
    results: [],
    queries: [{ status: 'ok', returned: 0, empty_reason: 'budget' }],
    limits: ['budget'],
  });
  expect(JSON.stringify(small).length).toBeLessThanOrEqual(256);
  const none = await searchIndex(config, { query: 'xyzznomatch' });
  expect(none.queries[0]).toMatchObject({
    status: 'empty',
    returned: 0,
    empty_reason: 'no_candidates',
  });
  expect(none).not.toHaveProperty('limits');
  const variants = await searchIndex(config, {
    queries: [
      { query_id: 'fruit', text: 'apple', variants: ['apple storage'] },
    ],
  });
  expect(variants.queries[0]).not.toHaveProperty('variants');
});
it('rejects unknown collections and absolute/traversing path prefixes while preserving empty scopes', async () => {
  const { config } = await fixture();
  await expect(
    searchIndex(config, {
      query: 'apple',
      filters: { collections: ['notes', 'typo'] },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_COLLECTION' });
  for (const prefix of [
    'C:\\notes\\a',
    '/notes/a',
    '../notes',
    '\\\\server\\share',
  ])
    await expect(
      searchIndex(config, { query: 'apple', filters: { path_prefix: prefix } }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH_PREFIX' });
  expect(
    (
      await searchIndex(config, {
        query: 'apple',
        filters: { collections: [] },
      })
    ).results,
  ).toEqual([]);
  expect(
    (
      await searchIndex(config, {
        query: 'apple',
        filters: { path_prefix: 'a.md' },
      })
    ).results.length,
  ).toBeGreaterThan(0);
});
it('exposes typed tools and runs source checks, compact search and diagnostics through MCP and CLI', async () => {
  const { configPath } = await fixture();
  // Index and MCP both use the built runtime's strategy fingerprint.
  execFileSync(process.execPath, [
    'dist/cli.js',
    'sync',
    '--config',
    configPath,
  ]);
  const client = new Client({ name: 'agent-acceptance', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'serve', '--config', configPath],
      stderr: 'pipe',
    }),
  );
  const decode = (r: unknown) =>
    JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
  try {
    const tools = (await client.listTools()).tools;
    const schema = tools.find((t) => t.name === 'echo_search')!.inputSchema as {
      properties: Record<string, any>;
    };
    expect(schema.properties.overrides.properties.topk).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    });
    expect(schema.properties.overrides.properties.topk).not.toHaveProperty(
      'default',
    );
    expect(schema.properties.overrides.additionalProperties).toBe(false);
    expect(
      schema.properties.filters.properties.path_prefix.description,
    ).toContain('relative');
    const status = decode(
      await client.callTool({
        name: 'echo_status',
        arguments: { check_sources: true },
      }),
    );
    expect(status.ready, JSON.stringify(status)).toBe(true);
    expect(status).toMatchObject({
      needs_sync: false,
      freshness: { state: 'unchanged' },
      collections: [{ id: 'notes' }],
    });
    const request = {
      query: 'apple',
      filters: { collections: ['notes'], path_prefix: 'a.md' },
    };
    const search = decode(
      await client.callTool({ name: 'echo_search', arguments: request }),
    );
    expect(search).not.toHaveProperty('applied');
    const debug = decode(
      await client.callTool({
        name: 'echo_search',
        arguments: { ...request, diagnostics: true },
      }),
    );
    expect(debug.applied).toMatchObject({ topk: 7, rrf_k: 13 });
    for (const e of search.results) {
      const lines = (await readFile(e.path, 'utf8')).split(/\r\n|\n|\r/);
      expect(lines.slice(e.start_line - 1, e.end_line).join('\n')).toBe(e.text);
    }
    const bad = await client.callTool({
      name: 'echo_search',
      arguments: { query: 'apple', filters: { collections: ['typo'] } },
    });
    expect(bad.isError).toBe(true);
    expect(decode(bad).code).toBe('INVALID_COLLECTION');
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        ['dist/cli.js', 'status', '--check-sources', '--config', configPath],
        { encoding: 'utf8' },
      ),
    );
    expect(cli.freshness.state).toBe('unchanged');
    const cliSearch = JSON.parse(
      execFileSync(
        process.execPath,
        [
          'dist/cli.js',
          'search',
          '--query',
          'apple',
          '--diagnostics',
          '--config',
          configPath,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(cliSearch.applied.rrf_k).toBe(13);
  } finally {
    await client.close();
  }
});

it('legacy readiness checks lexical/model identity instead of only the last sync time', async () => {
  const { dir, root } = await fixture();
  const config = parseConfig({
    database: join(dir, 'legacy.sqlite'),
    collections: [{ id: 'notes', root }],
    retrieval: { mode: 'bm25' },
  });
  await syncIndex(config);
  const changed = {
    ...config,
    lexical: { ...config.lexical, dictionary: ['apple'] },
  };
  expect(await readStatus(changed, { check_sources: true })).toMatchObject({
    ready: false,
    needs_sync: true,
    reason: { code: 'INDEX_STALE' },
    freshness: { state: 'unchanged' },
  });
  await expect(searchIndex(changed, { query: 'apple' })).rejects.toThrow(
    'Lexical configuration differs',
  );
  const hybrid = {
    ...config,
    retrieval: { ...config.retrieval, mode: 'hybrid' as const },
  };
  expect(await readStatus(hybrid)).toMatchObject({
    ready: false,
    reason: { code: 'MODEL_CONFIG' },
  });
});
