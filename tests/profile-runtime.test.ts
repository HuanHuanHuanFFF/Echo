import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  initializeWorkspace,
  migrateConfiguration,
  useProfiles,
} from '../src/profile-manager.js';
import { loadConfig, parseConfig } from '../src/config.js';
import { syncIndex } from '../src/sync.js';
import { configurationRuntime } from '../src/config-runtime.js';
import { createLogger } from '../src/logging.js';
import { runEvaluation } from '../src/evaluation.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const cli = resolve('src/cli.ts'),
  tsx = import.meta.resolve('tsx');
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'echo-profile-runtime-'));
  dirs.push(dir);
  const path = join(dir, 'echo.config.json');
  await initializeWorkspace(path);
  await mkdir(join(dir, 'notes'));
  await writeFile(
    join(dir, 'notes/a.md'),
    '# Apple\napple first\n## Storage\napple second\n## More\napple third',
  );
  await writeFile(
    join(dir, 'config/sources.json'),
    JSON.stringify({ collections: [{ id: 'notes', root: 'notes' }] }),
  );
  await useProfiles(path, { retrieval: 'bm25' });
  await syncIndex(await loadConfig(path));
  const run = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      ['--import', tsx, cli, ...args, '--config', path],
      { cwd: dir },
    );
  return { dir, path, run };
}
const decode = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
it('CLI initializes, discovers, switches and shows profiles without exposing key values', async () => {
  const { dir, path, run } = await fixture();
  expect(JSON.parse((await run('init')).stdout).created).toEqual([]);
  expect(
    JSON.parse((await run('config', 'list')).stdout).active.retrieval,
  ).toBe('bm25');
  const used = JSON.parse(
    (await run('config', 'use', '--chunker', 'heading-500')).stdout,
  );
  expect(used.active.chunker).toBe('heading-500');
  expect(used.index.ready).toBe(false);
  await run('sync');
  const show = JSON.parse((await run('config', 'show')).stdout);
  expect(show.index.ready).toBe(true);
  expect(show.files.embedding).toBe(join(dir, 'config/embedding/default.json'));
  expect(show.embedding.api_key_env).toBe('ECHO_EMBEDDING_API_KEY');
  expect(show.retrieval.mode).toBe('bm25');
  expect(show.retrieval.rrf_k).toBe(10);
  expect(show.retrieval.max_context_chars).toBe(16000);
  expect(show).not.toHaveProperty('api_key');
  expect(
    JSON.parse((await run('search', '--query', 'apple')).stdout).results.length,
  ).toBeGreaterThan(0);
  expect((await loadConfig(path)).profile!.active.chunker).toBe('heading-500');
});
it('real MCP uses profile changes on the next call and reports invalid/restart settings clearly', async () => {
  const { dir, path, run } = await fixture();
  const client = new Client({ name: 'profile-user', version: '1' }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', tsx, cli, 'serve', '--config', path],
      stderr: 'pipe',
    });
  try {
    await client.connect(transport);
    const search = () =>
      client.callTool({ name: 'echo_search', arguments: { query: 'apple' } });
    const initial = decode(await search());
    expect(initial.selection.retrieval).toBe('bm25');
    expect(initial.applied.lexical_engine).toBe('minisearch');
    await writeFile(
      join(dir, 'config/retrieval/tight.json'),
      JSON.stringify({
        id: 'tight',
        mode: 'bm25',
        topk: 1,
        lexical_engine: 'sqlite',
      }),
    );
    await run('config', 'use', '--retrieval', 'tight');
    const tight = decode(await search());
    expect(tight.results).toHaveLength(1);
    expect(tight.selection.retrieval).toBe('tight');
    expect(tight.applied.lexical_engine).toBe('sqlite');
    await writeFile(
      join(dir, 'config/retrieval/tight.json'),
      JSON.stringify({
        id: 'tight',
        mode: 'bm25',
        topk: 1,
        lexical_engine: 'minisearch',
        minisearch_b: 0.49,
      }),
    );
    const switchedBack = decode(await search());
    expect(switchedBack.results).toHaveLength(1);
    expect(switchedBack.applied).toMatchObject({
      lexical_engine: 'minisearch',
      minisearch_k: 1.2,
      minisearch_b: 0.49,
      minisearch_d: 0.5,
    });
    await run('config', 'use', '--chunker', 'heading-500');
    expect(decode(await search()).code).toBe('INDEX_REQUIRED');
    await run('sync');
    expect(decode(await search()).selection.chunker).toBe('heading-500');
    await writeFile(
      join(dir, 'tokenizers/words.mjs'),
      "export default {id:'words',version:'1',tokenize(text){return text.toLowerCase().split(/[^a-z]+/).filter(Boolean)}}",
    );
    await run('config', 'use', '--tokenizer', 'words');
    await run('sync');
    expect(decode(await search()).selection.tokenizer).toBe('words');
    await writeFile(
      join(dir, 'config/embedding/other.json'),
      JSON.stringify({
        id: 'other',
        model: 'other',
        dimensions: 3,
        base_url: 'http://127.0.0.1:12345/v1',
      }),
    );
    await run('config', 'use', '--embedding', 'other');
    expect(decode(await search()).selection.embedding).toBe('other');
    const runtimeFile = join(dir, 'config/runtime.json'),
      runtime = await readFile(runtimeFile, 'utf8');
    await writeFile(
      runtimeFile,
      JSON.stringify({ ...JSON.parse(runtime), max_concurrent_searches: 3 }),
    );
    expect(decode(await search()).code).toBe('RESTART_REQUIRED');
    await writeFile(runtimeFile, runtime);
    const main = await readFile(path, 'utf8');
    await writeFile(path, '{invalid');
    expect(decode(await search()).code).toBe('CONFIG_RELOAD');
    await writeFile(path, main);
    expect(decode(await search()).results).toHaveLength(1);
    const status = decode(
      await client.callTool({ name: 'echo_status', arguments: {} }),
    );
    expect(status.active.retrieval).toBe('tight');
    expect(status.ready).toBe(true);
  } finally {
    await client.close();
  }
}, 30000);
it('keeps captured runtime snapshots stable while subsequent loads get new profiles', async () => {
  const { path } = await fixture(),
    runtime = configurationRuntime(path, await loadConfig(path));
  const old = await runtime.snapshot();
  await useProfiles(path, { chunker: 'heading-500' });
  const next = await runtime.snapshot();
  expect(old!.profile!.active.chunker).toBe('markdown-structure-v1');
  expect(next!.profile!.active.chunker).toBe('heading-500');
  expect(old!.profile!.revision).not.toBe(next!.profile!.revision);
});
it('migrates legacy numeric options into a fixed strategy without dropping them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-migrate-'));
  dirs.push(dir);
  const path = join(dir, 'echo.config.json');
  const original = JSON.stringify({
    database: '.echo/index.sqlite',
    chunker: { options: { max_chars: 500 } },
    retrieval: { mode: 'bm25' },
  });
  await writeFile(path, original);
  const migrated = await migrateConfiguration(path);
  expect(migrated.changed).toBe(true);
  if (!('backup' in migrated)) throw new Error('Missing backup');
  expect(await readFile(migrated.backup!, 'utf8')).toBe(original);
  const config = await loadConfig(path);
  expect(config.profile!.active.chunker).toBe('heading-500');
  expect(config.retrieval.mode).toBe('bm25');
  expect((await migrateConfiguration(path)).changed).toBe(false);
});
it('rotates bounded logs and excludes query/key/body fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-log-'));
  dirs.push(dir);
  const log = createLogger({
    ...parseConfig({}).logging,
    level: 'info',
    file: join(dir, 'echo.jsonl'),
    max_file_bytes: 256,
    retain: 2,
  });
  for (let i = 0; i < 20; i++)
    log('info', 'search.completed', {
      results: i,
      query: 'private note',
      api_key: 'secret-value',
      body: 'private body',
    });
  const files = await readdir(dir);
  expect(files.length).toBeLessThanOrEqual(3);
  for (const file of files) {
    expect((await stat(join(dir, file))).size).toBeLessThanOrEqual(256);
    const text = await readFile(join(dir, file), 'utf8');
    expect(text).not.toMatch(/private|secret/);
  }
});
it('evaluates a selected fixed profile against only the isolated corpus', async () => {
  const { dir, path } = await fixture();
  const report = await runEvaluation({
    lexicalOnly: true,
    configPath: path,
    outputDir: join(dir, 'evaluation'),
  });
  expect(report.report.status).toBe('lexical_only');
  expect(report.report.profile.chunker_implementation.id).toBe(
    'markdown-structure-v1',
  );
});

it('keeps an in-flight MCP query on its original snapshot while later calls use the new selection', async () => {
  const { dir, path } = await fixture();
  const { createServer } = await import('node:http');
  const { embeddingFingerprint } = await import('../src/embedding.js');
  let signalStarted: () => void = () => {},
    release: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const api = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (p) => parts.push(p as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString()) as {
        input: string[];
      };
      const finish = () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
          }),
        );
      };
      if (body.input.includes('WAIT')) {
        release = finish;
        signalStarted();
      } else finish();
    });
  });
  // Use a high port: this Windows host's custom ephemeral range includes Fetch-blocked ports.
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failure = (e: Error) => {
          api.removeListener('listening', ready);
          reject(e);
        };
        const ready = () => {
          api.removeListener('error', failure);
          resolve();
        };
        api.once('error', failure);
        api.once('listening', ready);
        api.listen(20000 + Math.floor(Math.random() * 40000), '127.0.0.1');
      });
      break;
    } catch (error) {
      if (attempt === 49) throw error;
    }
  }
  const address = api.address();
  if (!address || typeof address === 'string')
    throw new Error('No API address');
  const client = new Client({ name: 'snapshot-user', version: '1' });
  try {
    await writeFile(
      join(dir, 'config/embedding/default.json'),
      JSON.stringify({
        id: 'default',
        model: 'test',
        dimensions: 2,
        base_url: 'http://127.0.0.1:' + address.port + '/v1',
        api_key_env: 'ECHO_PROFILE_HTTP_TEST',
      }),
    );
    await useProfiles(path, { retrieval: 'balanced' });
    const config = await loadConfig(path);
    await syncIndex(config, undefined, {
      fingerprint: embeddingFingerprint(config.embedding),
      dimensions: 2,
      async embed(texts) {
        return texts.map(() => [1, 0]);
      },
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', tsx, cli, 'serve', '--config', path],
        stderr: 'pipe',
        env: { ECHO_PROFILE_HTTP_TEST: 'synthetic-key' },
      }),
    );
    const waiting = client.callTool({
      name: 'echo_search',
      arguments: { query: 'WAIT', overrides: { mode: 'dense' } },
    });
    await Promise.race([
      reached,
      waiting.then(() => {
        throw new Error('Query ended before the gated API call');
      }),
    ]);
    await writeFile(
      join(dir, 'config/retrieval/tight.json'),
      JSON.stringify({
        id: 'tight',
        mode: 'bm25',
        topk: 1,
        lexical_engine: 'sqlite',
      }),
    );
    await useProfiles(path, { retrieval: 'tight' });
    const next = decode(
      await client.callTool({
        name: 'echo_search',
        arguments: { query: 'apple' },
      }),
    );
    expect(next.selection.retrieval).toBe('tight');
    expect(next.applied.lexical_engine).toBe('sqlite');
    expect(next.results).toHaveLength(1);
    release!();
    release = undefined;
    const old = decode(await waiting);
    expect(old.selection.retrieval).toBe('balanced');
    expect(old.applied.lexical_engine).toBe('minisearch');
    expect(old.results).toHaveLength(2);
    expect(old.selection.revision).not.toBe(next.selection.revision);
  } finally {
    release?.();
    await client.close();
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
}, 30000);
it('preserves complete legacy custom logic and freezes its previous options during migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-custom-migrate-'));
  dirs.push(dir);
  const path = join(dir, 'echo.config.json'),
    module = join(dir, 'custom.mjs');
  await writeFile(
    module,
    "export default {id:'custom',version:'1',chunk(input){return [{startLine:input.lines[0].number,endLine:input.lines[input.options.take-1].number,headingPath:[]}]}}",
  );
  await writeFile(
    path,
    JSON.stringify({
      chunker: { module: 'custom.mjs', options: { take: 2 } },
      retrieval: { mode: 'bm25' },
    }),
  );
  await migrateConfiguration(path);
  const config = await loadConfig(path);
  const { profileChunker } = await import('../src/profiles.js');
  const { runChunker } = await import('../src/chunker.js');
  const chunks = await runChunker(
    await profileChunker(config.profile!.chunker),
    {
      sourceId: 'source',
      path: 'note.md',
      lines: [
        { number: 4, text: 'first' },
        { number: 5, text: 'second' },
        { number: 6, text: 'third' },
      ],
      options: { take: 3 },
    },
  );
  expect(chunks[0]!.text).toBe('first\nsecond');
});

it('reports malformed model JSON as a model failure while preserving hybrid evidence', async () => {
  const { dir, path } = await fixture();
  const { createServer } = await import('node:http');
  const { embeddingFingerprint } = await import('../src/embedding.js');
  const api = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html>gateway failure</html>');
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failure = (error: Error) => {
          api.removeListener('listening', ready);
          reject(error);
        };
        const ready = () => {
          api.removeListener('error', failure);
          resolve();
        };
        api.once('error', failure);
        api.once('listening', ready);
        api.listen(20000 + Math.floor(Math.random() * 40000), '127.0.0.1');
      });
      break;
    } catch (error) {
      if (attempt === 49) throw error;
    }
  }
  const address = api.address();
  if (!address || typeof address === 'string')
    throw new Error('No model address');
  const client = new Client({ name: 'malformed-model-user', version: '1' });
  try {
    await writeFile(
      join(dir, 'config/embedding/default.json'),
      JSON.stringify({
        id: 'default',
        model: 'test',
        dimensions: 2,
        base_url: 'http://127.0.0.1:' + address.port + '/v1',
        api_key_env: 'ECHO_MALFORMED_JSON_TEST',
      }),
    );
    await useProfiles(path, { retrieval: 'balanced' });
    const config = await loadConfig(path);
    await syncIndex(config, undefined, {
      fingerprint: embeddingFingerprint(config.embedding),
      dimensions: 2,
      async embed(texts) {
        return texts.map(() => [1, 0]);
      },
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', tsx, cli, 'serve', '--config', path],
        stderr: 'pipe',
        env: { ECHO_MALFORMED_JSON_TEST: 'synthetic-key' },
      }),
    );
    const result = decode(
      await client.callTool({
        name: 'echo_search',
        arguments: { query: 'apple' },
      }),
    );
    expect(result.status).toBe('partial_failure');
    expect(result.results).toHaveLength(2);
    expect(result.queries[0].code).toBe('MODEL_UNAVAILABLE');
    expect(result.queries[0].next).toMatch(/model|API/);
    expect(result.queries[0].error).not.toContain('<html>');
  } finally {
    await client.close();
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});
