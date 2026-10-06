import { guidePaths, verifyPackageFiles } from './package-files.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Exercise the distributable outside the repository: no symlink/npm-link or
// ancestor node_modules fallback for the installed Echo process.
const repository = await realpath(
  fileURLToPath(new URL('../', import.meta.url)),
);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run with npm run smoke:package');
const temporaryRoot = await realpath(tmpdir());
const base = await realpath(
  await mkdtemp(join(temporaryRoot, 'echo package-')),
);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !['NODE_PATH', 'NODE_OPTIONS', 'ECHO_EMBEDDING_API_KEY'].includes(
        name.toUpperCase(),
      ),
  ),
);
const run = async (command, args, cwd) =>
  promisify(execFile)(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 240000,
    maxBuffer: 4 * 1024 * 1024,
  });
const npm = (args, cwd) =>
  run(
    process.execPath,
    [npmCli, '--cache', join(base, 'npm-cache'), ...args],
    cwd,
  );
const json = (value) => JSON.stringify(value, null, 2) + '\n';
let client;
try {
  await rm(join(repository, '.echo/package-install-smoke.json'), {
    force: true,
  });
  console.log('Checking npm tarball contents...');
  // Build explicitly, then pack without lifecycle output to keep JSON parseable.
  const output = join(repository, 'dist');
  await mkdir(output, { recursive: true });
  const outputInfo = await lstat(output);
  assert.ok(
    outputInfo.isDirectory() && !outputInfo.isSymbolicLink(),
    'dist must be a generated directory, not a link',
  );
  assert.equal(dirname(await realpath(output)), repository);
  await writeFile(
    join(output, 'echo-package-stale-' + randomUUID() + '.txt'),
    'stale build marker',
    { flag: 'wx' },
  );
  await npm(['run', 'prepack'], repository);
  const packed = JSON.parse(
    (
      await npm(
        ['pack', '--json', '--ignore-scripts', '--pack-destination', base],
        repository,
      )
    ).stdout,
  )[0];
  const packageInfo = JSON.parse(
    await readFile(join(repository, 'package.json'), 'utf8'),
  );
  assert.equal(packageInfo.name, '@huanf/echo');
  assert.equal(packageInfo.license, 'MIT');
  assert.notEqual(packageInfo.private, true);
  const paths = packed.files.map((file) => file.path);
  verifyPackageFiles(paths);
  const guides = guidePaths;
  assert.ok(
    (await readFile(join(repository, 'dist/cli.js'), 'utf8')).startsWith(
      '#!/usr/bin/env node',
    ),
  );

  const consumer = join(base, 'consumer'),
    work = join(consumer, 'knowledge base');
  await mkdir(work, { recursive: true });
  await writeFile(
    join(consumer, 'package.json'),
    json({ name: 'echo-package-consumer', private: true }),
  );
  console.log('Installing packed artifact and native dependencies...');
  await npm(
    [
      'install',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--registry=https://registry.npmjs.org/',
      '--fetch-retries=1',
      '--fetch-timeout=30000',
      join(base, packed.filename),
    ],
    consumer,
  );
  const installed = join(consumer, 'node_modules/@huanf/echo');
  assert.equal(await realpath(installed), installed);
  assert.equal(
    JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version,
    packageInfo.version,
  );
  const cli = join(installed, 'dist/cli.js'),
    config = join(work, 'echo.config.json');
  // npm exec must find the real installed bin shim, with all downloads disabled.
  const invoke = async (...args) =>
    JSON.parse(
      (
        await npm(
          ['exec', '--offline', '--', 'echo-mcp', ...args, '--config', config],
          consumer,
        )
      ).stdout,
    );
  await writeFile(join(work, 'README.md'), 'user-owned root README\n');
  assert.equal((await invoke('init')).status, 'ok');
  for (const path of guides)
    assert.ok((await readFile(join(work, path), 'utf8')).startsWith('# '));
  assert.equal(
    await readFile(join(work, 'README.md'), 'utf8'),
    'user-owned root README\n',
  );
  const guide = await readFile(
    join(work, 'config/retrieval/README.md'),
    'utf8',
  );
  assert.ok(!guide.includes('<!-- RETRIEVAL_PARAMETERS -->'));
  const retrievalPath = join(work, 'config/retrieval/balanced.json');
  const retrieval = JSON.parse(await readFile(retrievalPath, 'utf8'));
  for (const [key, value] of Object.entries(retrieval).filter(
    ([key]) => key !== 'id',
  ))
    assert.ok(
      guide.includes('| ' + key + ' | ' + JSON.stringify(value) + ' |'),
      'Guide default mismatch: ' + key,
    );
  assert.equal(retrieval.max_chunks_per_source, 6);
  assert.equal(retrieval.max_context_chars, 20000);
  assert.equal(retrieval.max_results, 20);
  assert.equal(retrieval.packing_mode, 'preview');
  await writeFile(join(work, 'config/README.md'), 'user guide\n');
  assert.deepEqual((await invoke('init')).created, []);
  assert.equal(
    await readFile(join(work, 'config/README.md'), 'utf8'),
    'user guide\n',
  );
  await mkdir(join(work, 'notes'));
  const source = '# Recovery\nrollback restores the previous committed state\n';
  const note = join(work, 'notes/note.md');
  await writeFile(note, source);
  await writeFile(
    join(work, 'config/sources.json'),
    json({ collections: [{ id: 'notes', root: 'notes' }] }),
  );
  await writeFile(retrievalPath, json({ ...retrieval, mode: 'bm25' }));
  console.log('Verifying installed CLI and MCP with isolated Markdown...');
  assert.equal((await invoke('sync')).status, 'ok');
  const syncedSource = await readFile(note, 'utf8');
  assert.match(syncedSource, /echo_id: [0-9a-f-]{36}/);
  const found = await invoke('search', '--query', 'rollback');
  assert.ok(found.results.length > 0);
  for (const hit of found.results) {
    assert.equal(hit.path, await realpath(note));
    assert.equal(
      hit.text,
      syncedSource
        .split('\n')
        .slice(hit.start_line - 1, hit.end_line)
        .join('\n'),
    );
  }
  const status = await invoke('status', '--check-sources');
  assert.equal(status.ready, true);
  assert.equal(status.freshness.state, 'unchanged');
  // The MCP client library is the test harness. The child process and every
  // Echo dependency resolve exclusively from the installed artifact directory.
  client = new Client({ name: 'installed-package-check', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'serve', '--config', config],
      cwd: work,
      env: environment,
      stderr: 'pipe',
    }),
  );
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    'echo_search',
    'echo_status',
  ]);
  const search = listed.tools.find((tool) => tool.name === 'echo_search');
  assert.ok(search.inputSchema.properties.overrides.properties.topk);
  const answer = await client.callTool({
    name: 'echo_search',
    arguments: { query: 'rollback' },
  });
  assert.notEqual(answer.isError, true);
  assert.deepEqual(JSON.parse(answer.content[0].text).results, found.results);
  await writeFile(note, syncedSource + '\nchanged content\n');
  const checked = await client.callTool({
    name: 'echo_status',
    arguments: { check_sources: true },
  });
  assert.equal(JSON.parse(checked.content[0].text).freshness.state, 'changed');
  await client.close();
  client = undefined;
  const receipt = {
    status: 'passed',
    package: packageInfo.name,
    version: packageInfo.version,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    packed_files: paths.length,
    packed_bytes: packed.size,
    tarball_sha256: createHash('sha256')
      .update(await readFile(join(base, packed.filename)))
      .digest('hex'),
    isolated_install: true,
    bin_shim: true,
    cli_and_mcp: true,
    source_locations: true,
    source_freshness: true,
    user_files_preserved: true,
    generated_guides: guides.length,
    new_embedding_calls: 0,
  };
  await mkdir(join(repository, '.echo'), { recursive: true });
  await writeFile(
    join(repository, '.echo/package-install-smoke.json'),
    json(receipt),
  );
  console.log(json(receipt));
} finally {
  if (client) await client.close();
  assert.equal(dirname(await realpath(base)), temporaryRoot);
  assert.ok(
    resolve(base).startsWith(
      temporaryRoot + (process.platform === 'win32' ? '\\' : '/'),
    ),
  );
  await rm(base, { recursive: true, force: true });
}
