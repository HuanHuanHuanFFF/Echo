import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [comparisonArg, qmdArg, scope, mode] = process.argv.slice(2);
assert.ok(
  comparisonArg &&
    qmdArg &&
    ['langchain', 'godot'].includes(scope) &&
    ['default', 'no-rerank'].includes(mode),
  'Usage: node evals/run-qmd-fixed-public.mjs COMPARISON_ROOT QMD_ROOT langchain|godot default|no-rerank',
);
const comparisonRoot = path.resolve(comparisonArg);
const qmdRoot = path.resolve(qmdArg);
const preparation = JSON.parse(
  await fs.readFile(path.join(qmdRoot, 'public-preparation.json'), 'utf8'),
);
const prepared = preparation.scopes[scope];
assert.ok(prepared);
const manifestFile = path.join(comparisonRoot, 'corpus-v1/manifest.json');
const manifestBytes = await fs.readFile(manifestFile);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(sha(manifestBytes), preparation.corpus_manifest_sha256);
const info = manifest.scopes[scope];
const corpusFile = path.join(
  comparisonRoot,
  'corpus-v1',
  `${scope}-documents.jsonl`,
);
const queryFile = path.join(
  comparisonRoot,
  'corpus-v1',
  `${scope}-queries.jsonl`,
);
assert.equal(sha(await fs.readFile(corpusFile)), prepared.corpus_sha256);
assert.equal(sha(await fs.readFile(queryFile)), prepared.queries_sha256);
const readRows = async (file) => {
  const text = await fs.readFile(file, 'utf8');
  return text.trim()
    ? text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
};
const queries = await readRows(queryFile);
assert.equal(queries.length, info.questions);
const mapFile = path.join(qmdRoot, 'public-data', `${scope}-map.jsonl`);
assert.equal(sha(await fs.readFile(mapFile)), prepared.map_sha256);
const mapping = new Map(
  (await readRows(mapFile)).map((row) => [row.file, row]),
);
assert.equal(mapping.size, info.documents);
const modelManifest = JSON.parse(
  await fs.readFile(path.join(qmdRoot, 'download-manifest.json'), 'utf8'),
);
assert.equal(modelManifest.version, '2.8.3');
assert.deepEqual(
  Object.fromEntries(modelManifest.models.map((row) => [row.file, row.sha256])),
  preparation.model_sha256,
);

const indexName = prepared.index_name;
const collection = prepared.collection;
const configFile = path.join(qmdRoot, 'config', `${indexName}.yml`);
const freeze = {
  schema: 'echo-qmd-public-fixed-run-v1',
  scope,
  mode,
  qmd_version: modelManifest.version,
  corpus_manifest_sha256: preparation.corpus_manifest_sha256,
  corpus_sha256: prepared.corpus_sha256,
  queries_sha256: prepared.queries_sha256,
  map_sha256: prepared.map_sha256,
  config_sha256: sha(await fs.readFile(configFile)),
  qmd_query_path: 'single string query; native QMD expansion and RRF',
  rerank: mode === 'default',
  limit: 50,
  candidate_limit: 120,
  mcp_request_timeout_ms: 600000,
  result_unit: 'one official FreshStack unit per Markdown file',
  embedding_model: modelManifest.embedding_model,
  model_sha256: preparation.model_sha256,
  script_sha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
  mcp_client_version: '2.0.0',
  gpu_backend: 'vulkan',
};
const runDir = path.join(qmdRoot, 'runs-public', mode);
await fs.mkdir(runDir, { recursive: true });
const runFile = path.join(runDir, `${scope}.jsonl`);
const freezeFile = path.join(runDir, `${scope}.freeze.json`);
const receiptFile = path.join(runDir, `${scope}.receipt.json`);
try {
  assert.deepEqual(JSON.parse(await fs.readFile(freezeFile, 'utf8')), freeze);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  await fs.writeFile(freezeFile, JSON.stringify(freeze, null, 2) + '\n', {
    flag: 'wx',
  });
}
const prior = await fs.readFile(runFile, 'utf8').then(
  (text) =>
    text.trim()
      ? text
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [],
  (error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  },
);
assert.deepEqual(
  prior.map((row) => row.id),
  queries.slice(0, prior.length).map((row) => row.id),
);

process.env.XDG_CACHE_HOME = path.join(qmdRoot, 'cache');
process.env.QMD_CONFIG_DIR = path.join(qmdRoot, 'config');
process.env.QMD_EMBED_MODEL = modelManifest.embedding_model;
process.env.QMD_LLAMA_GPU = 'vulkan';
const clientPackage = path.join(
  qmdRoot,
  'app/node_modules/@modelcontextprotocol/client',
);
const { Client } = await import(
  pathToFileURL(path.join(clientPackage, 'dist/index.mjs')).href
);
const { StdioClientTransport } = await import(
  pathToFileURL(path.join(clientPackage, 'dist/stdio.mjs')).href
);
const qmdBin = path.join(qmdRoot, 'app/node_modules/@tobilu/qmd/bin/qmd');
const client = new Client({
  name: 'echo-qmd-fixed-public-eval',
  version: '1.0.0',
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [qmdBin, '--index', indexName, 'mcp'],
  env: {
    ...process.env,
    LLAMA_LOG_LEVEL: 'error',
    GGML_LOG_LEVEL: 'error',
    GGML_BACKEND_SILENT: '1',
  },
  stderr: 'pipe',
});
const stderrStream = transport.stderr;
assert.ok(stderrStream);
let stderrBuffer = '';
let stderrTruncationWarnings = 0;
let stderrEmbeddingErrors = 0;
stderrStream.on('data', (chunk) => {
  stderrBuffer += chunk.toString('utf8');
  const lines = stderrBuffer.split('\n');
  stderrBuffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.includes('Batch text truncated to fit embedding context'))
      stderrTruncationWarnings++;
    if (line.includes('Embedding error')) stderrEmbeddingErrors++;
  }
});
const processStartedAt = new Date().toISOString();
const processStarted = performance.now();
await client.connect(transport);
assert.ok(
  (await client.listTools()).tools.some((tool) => tool.name === 'query'),
);
const serverVersion = client.getServerVersion();

function unitForFile(file) {
  let relative = String(file)
    .replace(/^qmd:\/\//, '')
    .split('?')[0];
  const indexedPrefix = `${indexName}/${collection}/`;
  if (relative.startsWith(indexedPrefix))
    relative = relative.slice(indexedPrefix.length);
  else {
    const collectionPrefix = `${collection}/`;
    assert.ok(
      relative.startsWith(collectionPrefix),
      `QMD result escaped collection: ${file}`,
    );
    relative = relative.slice(collectionPrefix.length);
  }
  const filename = relative.replaceAll('\\', '/');
  const unit = mapping.get(filename);
  assert.ok(unit, `QMD result has no official unit mapping: ${filename}`);
  return unit;
}

const handle = await fs.open(runFile, 'a');
const finished = [...prior];
try {
  for (let i = prior.length; i < queries.length; i++) {
    const input = queries[i];
    const started = performance.now();
    let result;
    let thrownError = null;
    try {
      result = await client.callTool(
        {
          name: 'query',
          arguments: {
            query: input.text,
            collections: [collection],
            limit: freeze.limit,
            candidateLimit: freeze.candidate_limit,
            rerank: freeze.rerank,
          },
        },
        {
          timeout: freeze.mcp_request_timeout_ms,
          resetTimeoutOnProgress: true,
        },
      );
    } catch (error) {
      thrownError = error instanceof Error ? error.message : String(error);
    }
    const latencyMs = Math.round(performance.now() - started);
    const error =
      thrownError ||
      (result?.isError
        ? result.content
            ?.filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n') || 'QMD MCP query failed'
        : null);
    const native = error ? [] : result.structuredContent?.results;
    assert.ok(
      Array.isArray(native),
      'QMD MCP result has no structured results',
    );
    const ids = new Set();
    const rankings = native.map((item, rank) => {
      const unit = unitForFile(item.file);
      assert.ok(!ids.has(unit.id), `QMD returned duplicate unit ${unit.id}`);
      ids.add(unit.id);
      return {
        id: unit.id,
        rank: rank + 1,
        rank_score: native.length - rank,
        native_score: item.score,
        native_id: item.docid,
        file: item.file,
        snippet: item.snippet,
      };
    });
    const row = {
      id: input.id,
      query_chars: input.text.length,
      latency_ms: latencyMs,
      native_error: error,
      rankings,
    };
    await handle.write(JSON.stringify(row) + '\n');
    await handle.sync();
    finished.push(row);
    if (error) console.warn(`${scope} ${mode}: ${input.id} failed: ${error}`);
    if ((i + 1) % 5 === 0 || i + 1 === queries.length)
      console.log(`${scope} ${mode}: ${i + 1}/${queries.length}`);
  }
} finally {
  await handle.close();
  await client.close();
}

assert.equal(finished.length, queries.length);
const runBytes = await fs.readFile(runFile);
const finishedAt = new Date().toISOString();
const wallDurationMs = Math.round(performance.now() - processStarted);
await fs.writeFile(
  receiptFile,
  JSON.stringify(
    {
      ...freeze,
      status: 'complete',
      server_version: serverVersion,
      questions: finished.length,
      query_errors: finished.filter((row) => row.native_error).length,
      result_sha256: sha(runBytes),
      latency_ms: finished.map((row) => row.latency_ms),
      started_at: processStartedAt,
      finished_at: finishedAt,
      wall_duration_ms: wallDurationMs,
      stderr_truncation_warnings: stderrTruncationWarnings,
      stderr_embedding_errors: stderrEmbeddingErrors,
    },
    null,
    2,
  ) + '\n',
);
console.log(`${scope} ${mode}: receipt ${receiptFile}`);
