import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repository = await realpath(
  fileURLToPath(new URL('../', import.meta.url)),
);
await mkdir(join(repository, '.echo'), { recursive: true });
const workspaceRoot = await realpath(join(repository, '.echo'));
const base = await mkdtemp(join(workspaceRoot, 'default-runtime-'));
let client;
try {
  const runtime = join(base, 'runtime'),
    work = join(base, 'workspace');
  await mkdir(runtime);
  await mkdir(work);
  await cp(join(repository, 'dist'), join(runtime, 'dist'), {
    recursive: true,
  });
  await cp(join(repository, 'package.json'), join(runtime, 'package.json'));
  const cli = join(runtime, 'dist/cli.js'),
    configPath = join(work, 'echo.config.json');
  const invoke = async (...args) => {
    const result = await promisify(execFile)(
      process.execPath,
      [cli, ...args, '--config', configPath],
      {
        cwd: work,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    return JSON.parse(result.stdout);
  };
  assert.equal((await invoke('init')).status, 'ok');
  const main = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(main.active.chunker, 'markdown-structure-v1');
  assert.equal(main.active.retrieval, 'balanced');
  const retrievalPath = join(work, 'config/retrieval/balanced.json');
  const retrieval = JSON.parse(await readFile(retrievalPath, 'utf8'));
  assert.deepEqual(retrieval, {
    id: 'balanced',
    mode: 'hybrid',
    lexical_engine: 'minisearch',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    topk: 10,
    max_chunks_per_source: 3,
    bm25_candidates: 60,
    dense_candidates: 60,
    rrf_k: 10,
    title_weight: 2,
    bm25_weight: 0.5,
    dense_weight: 1,
    max_context_chars: 20000,
    min_dense_similarity: 0.3,
  });
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const strategy = await readFile(
    join(work, 'chunkers/markdown-structure-v1.mjs'),
  );
  assert.equal(
    hash(strategy),
    hash(
      await readFile(
        join(
          repository,
          'examples/profiles/chunkers/markdown-structure-v1.mjs',
        ),
      ),
    ),
  );
  // Existing explicit retrieval settings and chunk selection survive repeated init.
  await writeFile(
    retrievalPath,
    JSON.stringify({
      ...retrieval,
      rrf_k: 30,
      lexical_engine: 'sqlite',
      max_context_chars: 16000,
    }),
  );
  await writeFile(
    configPath,
    JSON.stringify({
      ...main,
      active: { ...main.active, chunker: 'heading-1000' },
    }),
  );
  assert.deepEqual((await invoke('init')).created, []);
  assert.equal(JSON.parse(await readFile(retrievalPath, 'utf8')).rrf_k, 30);
  assert.equal(
    JSON.parse(await readFile(retrievalPath, 'utf8')).max_context_chars,
    16000,
  );
  assert.equal(
    JSON.parse(await readFile(retrievalPath, 'utf8')).lexical_engine,
    'sqlite',
  );
  assert.equal(
    JSON.parse(await readFile(configPath, 'utf8')).active.chunker,
    'heading-1000',
  );
  await writeFile(retrievalPath, JSON.stringify(retrieval));
  await writeFile(configPath, JSON.stringify(main));
  await mkdir(join(work, 'notes'));
  const raw =
    '---\necho_id: 123e4567-e89b-42d3-a456-426614174000\n---\n# Database\n## Rollback\nrollback transaction failure\n## Resume\nresume from checkpoint\n';
  const note = join(work, 'notes/note.md');
  await writeFile(note, raw);
  await writeFile(
    join(work, 'config/sources.json'),
    JSON.stringify({ collections: [{ id: 'smoke', root: 'notes' }] }),
  );
  await invoke('config', 'use', '--retrieval', 'bm25');
  assert.equal((await invoke('sync')).status, 'ok');
  const found = await invoke('search', '--query', 'rollback');
  assert.equal(found.status, 'ok');
  assert.equal(found.selection.chunker, 'markdown-structure-v1');
  assert.equal(found.applied.rrf_k, 10);
  assert.equal(found.applied.lexical_engine, 'minisearch');
  assert.equal(found.applied.max_context_chars, 20000);
  assert.ok(found.results.length > 0);
  for (const piece of found.results)
    assert.equal(
      piece.text,
      raw
        .split('\n')
        .slice(piece.start_line - 1, piece.end_line)
        .join('\n'),
    );
  assert.equal(await readFile(note, 'utf8'), raw);
  client = new Client({ name: 'default-runtime-smoke', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'serve', '--config', configPath],
      stderr: 'pipe',
    }),
  );
  const answer = await client.callTool({
    name: 'echo_search',
    arguments: { query: 'rollback' },
  });
  assert.equal(answer.isError, undefined);
  const result = JSON.parse(answer.content[0].text);
  assert.equal(result.status, 'ok');
  assert.equal(result.selection.chunker, 'markdown-structure-v1');
  assert.deepEqual(result.results, found.results);
  const receipt = {
    status: 'passed',
    node: process.version,
    icu: process.versions.icu,
    default_active: main.active,
    default_retrieval: retrieval,
    strategy_sha256: hash(strategy),
    runtime_layout:
      'copied dist + package.json; no examples/src in copied runtime; dependencies resolved from repository',
    preserved_explicit_existing_settings: true,
    cli_and_mcp_evidence_equal: true,
    exact_source_lines: true,
    fixture_unchanged: true,
    tested_mode: 'bm25; hybrid defaults checked without a model call',
    new_embedding_calls: 0,
  };
  await writeFile(
    join(workspaceRoot, 'default-runtime-smoke.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  );
  console.log(JSON.stringify(receipt));
} finally {
  if (client) await client.close();
  assert.equal(dirname(await realpath(base)), workspaceRoot);
  await rm(base, { recursive: true, force: true });
}
