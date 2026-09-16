import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeWorkspace, useProfiles } from '../src/profile-manager.js';
import { loadConfig, parseConfig, type EchoConfig } from '../src/config.js';
import { syncIndex } from '../src/sync.js';
import { searchIndex } from '../src/retrieval.js';
import { embeddingFingerprint } from '../src/embedding.js';
import { profileTables, sqlName } from '../src/profile-store.js';
import { openDatabase } from '../src/database.js';
import type { EmbeddingProvider } from '../src/contracts.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), 'echo-profile-index-')),
  );
  dirs.push(dir);
  const path = join(dir, 'echo.config.json');
  await initializeWorkspace(path);
  const notes = join(dir, 'notes');
  await mkdir(notes);
  await writeFile(
    join(dir, 'config/sources.json'),
    JSON.stringify({ collections: [{ id: 'notes', root: 'notes' }] }),
  );
  await writeFile(
    join(dir, 'config/embedding/default.json'),
    JSON.stringify({
      id: 'default',
      model: 'model-one',
      dimensions: 2,
      base_url: 'http://127.0.0.1:12345/v1',
      api_key_env: 'ECHO_PROFILE_TEST_MISSING',
    }),
  );
  await writeFile(join(notes, 'a.md'), '# Alpha\napple HTTPServer');
  return { dir, path, notes, config: await loadConfig(path) };
}
function model(config: EchoConfig) {
  const calls: { purpose: string; texts: string[] }[] = [];
  const provider: EmbeddingProvider = {
    fingerprint: embeddingFingerprint(config.embedding),
    dimensions: config.embedding.dimensions!,
    async embed(texts, purpose) {
      calls.push({ purpose, texts });
      return texts.map(() => [
        1,
        ...Array<number>(config.embedding.dimensions! - 1).fill(0),
      ]);
    },
  };
  return { provider, calls };
}
function rows(config: EchoConfig, table: string) {
  const db = openDatabase(config.database, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM ' + sqlName(table)).all();
  } finally {
    db.close();
  }
}
it('changes tokenizer with zero embedding calls and unchanged chunk/vector records', async () => {
  const { dir, path, config } = await fixture(),
    first = model(config);
  await syncIndex(config, undefined, first.provider);
  const tables = profileTables(config),
    beforeChunks = rows(config, tables.chunks),
    beforeVectors = rows(config, tables.vectors!);
  await writeFile(
    join(dir, 'tokenizers/words.mjs'),
    "export default {id:'words',version:'1',tokenize(text){return text.toLowerCase().split(/[^a-z]+/).filter(Boolean)}}",
  );
  await useProfiles(path, { tokenizer: 'words' });
  const next = await loadConfig(path),
    nextModel = model(next),
    nextTables = profileTables(next);
  expect(nextTables.chunks).toBe(tables.chunks);
  expect(nextTables.vectors).toBe(tables.vectors);
  expect(nextTables.fts).not.toBe(tables.fts);
  await expect(
    searchIndex(next, { query: 'apple' }, undefined, nextModel.provider),
  ).rejects.toMatchObject({ code: 'INDEX_REQUIRED' });
  await syncIndex(next, undefined, nextModel.provider);
  expect(nextModel.calls).toEqual([]);
  expect(rows(next, tables.chunks)).toEqual(beforeChunks);
  expect(rows(next, tables.vectors!)).toEqual(beforeVectors);
  expect(
    (await searchIndex(next, { query: 'apple' }, undefined, nextModel.provider))
      .results,
  ).toHaveLength(1);
  await useProfiles(path, { retrieval: 'bm25' });
  const lexical = await loadConfig(path);
  expect(profileTables(lexical)).toEqual(nextTables);
  expect((await searchIndex(lexical, { query: 'apple' })).results).toHaveLength(
    1,
  );
  // Reusing existing vectors does not require a key or contact the configured URL.
  await useProfiles(path, { retrieval: 'balanced' });
  expect(await syncIndex(await loadConfig(path))).toMatchObject({
    unchanged: 1,
  });
});
it('keeps multiple model dimensions and fixed chunk strategies independently reusable', async () => {
  const { dir, path, config } = await fixture(),
    first = model(config);
  await syncIndex(config, undefined, first.provider);
  const old = profileTables(config),
    chunks = rows(config, old.chunks),
    vectors = rows(config, old.vectors!);
  await writeFile(
    join(dir, 'config/embedding/second.json'),
    JSON.stringify({
      id: 'second',
      model: 'model-two',
      dimensions: 3,
      base_url: config.embedding.base_url,
    }),
  );
  await useProfiles(path, { embedding: 'second' });
  const second = await loadConfig(path),
    secondModel = model(second);
  await syncIndex(second, undefined, secondModel.provider);
  expect(secondModel.calls.flatMap((c) => c.texts)).toHaveLength(1);
  const newer = profileTables(second);
  expect(newer.chunks).toBe(old.chunks);
  expect(newer.fts).toBe(old.fts);
  expect(newer.vectors).not.toBe(old.vectors);
  expect(rows(config, old.chunks)).toEqual(chunks);
  expect(rows(config, old.vectors!)).toEqual(vectors);
  expect(
    (rows(second, newer.vectors!)[0] as { embedding: Buffer }).embedding.length,
  ).toBe(12);
  await useProfiles(path, { chunker: 'heading-500' });
  const smaller = await loadConfig(path),
    smallModel = model(smaller);
  await syncIndex(smaller, undefined, smallModel.provider);
  expect(profileTables(smaller).chunks).not.toBe(old.chunks);
  await useProfiles(path, { chunker: 'heading-1000', embedding: 'default' });
  const back = await loadConfig(path);
  expect(await syncIndex(back)).toMatchObject({ unchanged: 1 });
  expect(rows(back, old.vectors!)).toEqual(vectors);
});
it('invalidates inactive snapshots after edits, rename and delete without mixing old locations', async () => {
  const { path, notes, config } = await fixture();
  await syncIndex(config, undefined, model(config).provider);
  await useProfiles(path, { chunker: 'heading-500' });
  const second = await loadConfig(path);
  await syncIndex(second, undefined, model(second).provider);
  const original = await readFile(join(notes, 'a.md'), 'utf8');
  await writeFile(
    join(notes, 'a.md'),
    original.replace('apple HTTPServer', 'banana URLParser'),
  );
  await rename(join(notes, 'a.md'), join(notes, 'renamed.md'));
  await syncIndex(second, undefined, model(second).provider);
  await expect(
    searchIndex(config, { query: 'apple' }, undefined, model(config).provider),
  ).rejects.toMatchObject({ code: 'INDEX_STALE' });
  await syncIndex(config, undefined, model(config).provider);
  const result = await searchIndex(
    config,
    { query: 'banana' },
    undefined,
    model(config).provider,
  );
  expect(result.results[0]!.path).toBe(join(notes, 'renamed.md'));
  expect(
    (await readFile(result.results[0]!.path, 'utf8'))
      .split(/\r?\n/)
      .slice(result.results[0]!.start_line - 1, result.results[0]!.end_line)
      .join('\n'),
  ).toBe(result.results[0]!.text);
  await rm(join(notes, 'renamed.md'));
  await syncIndex(config, undefined, model(config).provider);
  expect(
    (
      await searchIndex(
        config,
        { query: 'banana' },
        undefined,
        model(config).provider,
      )
    ).results,
  ).toEqual([]);
  await expect(
    searchIndex(second, { query: 'banana' }, undefined, model(second).provider),
  ).rejects.toMatchObject({ code: 'INDEX_STALE' });
});
it('rolls back a failed model update and publishes it only after a successful retry', async () => {
  const { notes, config } = await fixture(),
    good = model(config);
  await syncIndex(config, undefined, good.provider);
  const before = await searchIndex(
    config,
    { query: 'apple' },
    undefined,
    good.provider,
  );
  const original = await readFile(join(notes, 'a.md'), 'utf8');
  await writeFile(join(notes, 'a.md'), original.replace('apple', 'banana'));
  const failing = {
    ...good.provider,
    async embed() {
      throw new Error('injected model failure');
    },
  };
  await expect(syncIndex(config, undefined, failing)).rejects.toThrow(
    'injected',
  );
  expect(
    await searchIndex(config, { query: 'apple' }, undefined, good.provider),
  ).toEqual(before);
  await syncIndex(config, undefined, good.provider);
  expect(
    (await searchIndex(config, { query: 'banana' }, undefined, good.provider))
      .results[0]!.text,
  ).toContain('banana');
});
it('honors scan patterns and size limits without writing excluded notes', async () => {
  const { dir, path, notes } = await fixture();
  await mkdir(join(notes, 'private'));
  const excluded = join(notes, 'private/skip.md');
  await writeFile(excluded, 'private untouched');
  await writeFile(
    join(dir, 'config/sources.json'),
    JSON.stringify({
      collections: [
        {
          id: 'notes',
          root: 'notes',
          include: ['**/*.md'],
          exclude: ['private/**'],
          max_file_bytes: 1000,
        },
      ],
    }),
  );
  await useProfiles(path, { retrieval: 'bm25' });
  const config = await loadConfig(path);
  expect(await syncIndex(config)).toMatchObject({ added: 1 });
  expect(await readFile(excluded, 'utf8')).toBe('private untouched');
  await writeFile(join(notes, 'large.md'), 'x'.repeat(1001));
  await expect(syncIndex(config)).rejects.toThrow('max_file_bytes');
  expect((await searchIndex(config, { query: 'apple' })).results).toHaveLength(
    1,
  );
});
it('reuses verified legacy chunks and vectors during profile adoption', async () => {
  const { config } = await fixture(),
    provider = model(config);
  const legacy = parseConfig({
    database: config.database,
    collections: config.collections,
    embedding: config.embedding,
    retrieval: config.retrieval,
  });
  await syncIndex(legacy, undefined, provider.provider);
  expect(provider.calls.length).toBeGreaterThan(0);
  provider.calls.length = 0;
  const original = await searchIndex(
    legacy,
    { query: 'apple' },
    undefined,
    provider.provider,
  );
  provider.calls.length = 0;
  await syncIndex(config, undefined, provider.provider);
  expect(provider.calls).toEqual([]);
  const migrated = await searchIndex(
    config,
    { query: 'apple' },
    undefined,
    provider.provider,
  );
  expect(migrated.results).toEqual(original.results);
  await expect(
    syncIndex(legacy, undefined, provider.provider),
  ).rejects.toMatchObject({ code: 'LEGACY_CONFIG' });
});

it.each(['edit', 'delete', 'exclude'])(
  'does not revive incomplete inactive FTS/vectors when source state returns: %s',
  async (change) => {
    const { dir, path, notes, config } = await fixture(),
      first = model(config);
    await syncIndex(config, undefined, first.provider);
    const original = await readFile(join(notes, 'a.md'), 'utf8');
    await writeFile(
      join(dir, 'tokenizers/words.mjs'),
      "export default {id:'words',version:'1',tokenize(text){return text.toLowerCase().split(/[^a-z]+/).filter(Boolean)}}",
    );
    await writeFile(
      join(dir, 'config/embedding/second.json'),
      JSON.stringify({
        id: 'second',
        model: 'other',
        dimensions: 3,
        base_url: config.embedding.base_url,
      }),
    );
    await useProfiles(path, { tokenizer: 'words', embedding: 'second' });
    const second = await loadConfig(path),
      other = model(second);
    await syncIndex(second, undefined, other.provider);
    let changed = second;
    if (change === 'edit')
      await writeFile(join(notes, 'a.md'), original.replace('apple', 'banana'));
    else if (change === 'delete') await rm(join(notes, 'a.md'));
    else
      changed = {
        ...second,
        collections: second.collections.map((c) => ({ ...c, exclude: ['**'] })),
      };
    await syncIndex(changed, undefined, other.provider);
    await writeFile(join(notes, 'a.md'), original);
    await syncIndex(second, undefined, other.provider);
    for (const mode of ['bm25', 'dense'] as const)
      await expect(
        searchIndex(
          config,
          { query: 'apple', overrides: { mode } },
          undefined,
          first.provider,
        ),
      ).rejects.toMatchObject({ code: 'INDEX_STALE' });
    first.calls.length = 0;
    await syncIndex(config, undefined, first.provider);
    expect(first.calls.flatMap((c) => c.texts)).toHaveLength(1);
    expect(
      (await searchIndex(config, { query: 'apple' }, undefined, first.provider))
        .results,
    ).toHaveLength(1);
    other.calls.length = 0;
    await syncIndex(second, undefined, other.provider);
    expect(other.calls).toEqual([]);
  },
);
