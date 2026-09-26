import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  mapQmdSnippet,
  packQmdParentEvidence,
} from './lib/qmd-parent-evidence.mjs';

const [comparisonArg, qmdArg, scope, mode, ...flags] = process.argv.slice(2);
const scopes = ['A-test', 'B-test', 'C-test', 'D-test', 'mixed-test'];
assert.ok(
  comparisonArg &&
    qmdArg &&
    scopes.includes(scope) &&
    ['rrf', 'rerank'].includes(mode),
  'Usage: node evals/run-qmd-mcp-private.mjs COMPARISON_ROOT QMD_ROOT SCOPE rrf|rerank [--smoke N]',
);
assert.ok(flags.length === 0 || (flags.length === 2 && flags[0] === '--smoke'));
const smokeCount = flags.length ? Number(flags[1]) : null;
assert.ok(
  smokeCount === null ||
    (Number.isInteger(smokeCount) && smokeCount > 0 && smokeCount <= 10),
);
const comparisonRoot = path.resolve(comparisonArg);
const qmdRoot = path.resolve(qmdArg);
const indexName =
  'qmd-' + (scope === 'mixed-test' ? 'mixed' : scope[0].toLowerCase());
const sha = (value) => createHash('sha256').update(value).digest('hex');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const readRows = async (file) => {
  const raw = await fs.readFile(file, 'utf8');
  return raw.trim()
    ? raw
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
};
const preparation = await readJson(
  path.join(qmdRoot, 'private-preparation.json'),
);
const prepared = preparation.scopes.find((row) => row.scope === scope);
assert.ok(prepared);
const corpusRoot = path.join(comparisonRoot, 'corpus-v1');
const corpusFile = path.join(corpusRoot, `${scope}-documents.jsonl`);
const queryFile = path.join(corpusRoot, `${scope}-queries.jsonl`);
assert.equal(sha(await fs.readFile(corpusFile)), prepared.corpus_sha256);
assert.equal(sha(await fs.readFile(queryFile)), prepared.queries_sha256);
const sources = await readRows(corpusFile);
const questions = await readRows(queryFile);
assert.equal(sources.length, prepared.documents);
assert.equal(questions.length, prepared.questions);
const sourceById = new Map(sources.map((row) => [row.id, row]));
const sourceByPath = new Map(
  prepared.files.map((row) => [row.qmd_relative_path, row]),
);
for (const row of prepared.files) {
  const file = path.join(qmdRoot, 'private-data', scope, row.qmd_relative_path);
  assert.equal(sha(await fs.readFile(file)), row.text_sha256);
}
const download = await readJson(path.join(qmdRoot, 'download-manifest.json'));
assert.equal(download.version, '2.8.3');
const configPath = path.join(qmdRoot, 'config', `${indexName}.yml`);
const scriptFile = fileURLToPath(import.meta.url);
const helperFile = path.join(
  path.dirname(scriptFile),
  'lib/qmd-parent-evidence.mjs',
);
const limits = { topk: 10, source_cap: 6, max_context_chars: 20000 };
const runDir = path.join(qmdRoot, 'runs-mcp', mode);
await fs.mkdir(runDir, { recursive: true });
const suffix = smokeCount === null ? '' : `.smoke-${smokeCount}`;
const runFile = path.join(runDir, `${scope}${suffix}.jsonl`);
const freezeFile = path.join(runDir, `${scope}${suffix}.freeze.json`);
const receiptFile = path.join(runDir, `${scope}${suffix}.receipt.json`);
const frozen = {
  schema: 'echo-qmd-mcp-private-run-v1',
  scope,
  mode,
  smoke_count: smokeCount,
  qmd_version: download.version,
  mcp_client_version: '2.0.0',
  gpu_backend: process.env.QMD_LLAMA_GPU ?? 'auto',
  embedding_model: download.embedding_model,
  model_sha256: Object.fromEntries(
    download.models.map((row) => [row.file, row.sha256]),
  ),
  corpus_sha256: prepared.corpus_sha256,
  queries_sha256: prepared.queries_sha256,
  labels_sha256: prepared.labels_sha256,
  config_sha256: sha(await fs.readFile(configPath)),
  script_sha256: sha(await fs.readFile(scriptFile)),
  helper_sha256: sha(await fs.readFile(helperFile)),
  retrieval: {
    typed_searches_per_subquery: ['lex', 'vec'],
    one_mcp_call_per_parent: true,
    limit: 10,
    candidate_limit: 40,
    rerank: mode === 'rerank',
    snippet_chars: 300,
  },
  packing: limits,
};
try {
  assert.deepEqual(await readJson(freezeFile), frozen);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  await fs.writeFile(freezeFile, JSON.stringify(frozen, null, 2) + '\n', {
    flag: 'wx',
  });
}
const prior = await fs.readFile(runFile, 'utf8').then(
  (s) =>
    s.trim()
      ? s
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
  questions.slice(0, prior.length).map((row) => row.id),
);
const target = smokeCount ?? questions.length;

process.env.XDG_CACHE_HOME = path.join(qmdRoot, 'cache');
process.env.QMD_CONFIG_DIR = path.join(qmdRoot, 'config');
process.env.QMD_EMBED_MODEL = download.embedding_model;
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
const client = new Client({ name: 'echo-qmd-private-eval', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [qmdBin, '--index', indexName, 'mcp'],
  env: { ...process.env },
});
await client.connect(transport);
const available = await client.listTools();
assert.ok(available.tools.some((tool) => tool.name === 'query'));
const serverVersion = client.getServerVersion();

function sourceForFile(file) {
  const relative = String(file).replace(/^qmd:\/\//, '');
  const prefix = indexName + '/';
  assert.ok(
    relative.startsWith(prefix),
    'MCP result escaped the QMD collection',
  );
  const map = sourceByPath.get(
    relative.slice(prefix.length).replaceAll('\\', '/'),
  );
  assert.ok(map, 'MCP result is not in the frozen source map');
  return sourceById.get(map.source_id);
}

const handle = await fs.open(runFile, 'a');
try {
  for (let index = prior.length; index < target; index++) {
    const question = questions[index];
    const searches = question.queries.flatMap((row) => {
      assert.ok(!/[\r\n]/.test(row.text));
      return [
        { type: 'lex', query: row.text },
        { type: 'vec', query: row.text },
      ];
    });
    assert.ok(searches.length > 0 && searches.length <= 10);
    const started = performance.now();
    const result = await client.callTool({
      name: 'query',
      arguments: {
        searches,
        collections: [indexName],
        limit: 10,
        candidateLimit: 40,
        rerank: mode === 'rerank',
      },
    });
    const latencyMs = Math.round(performance.now() - started);
    const error = result.isError
      ? result.content
          ?.filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n') || 'MCP query failed'
      : null;
    const native = error ? [] : result.structuredContent?.results;
    assert.ok(
      Array.isArray(native),
      'QMD MCP result has no structured results',
    );
    const candidates = native.map((item) => {
      const source = sourceForFile(item.file);
      const mapped = mapQmdSnippet(item.snippet, source);
      return {
        id: sha(JSON.stringify([source.id, mapped.spans, item.snippet])),
        source_id: source.id,
        path: source.relative_path,
        text: item.snippet,
        native_id: item.docid,
        native_score: item.score,
        map_status: mapped.status,
        spans: mapped.spans,
      };
    });
    const packed = packQmdParentEvidence(question, candidates, limits);
    const row = {
      id: question.id,
      native_results: native,
      candidates,
      native_error: error,
      latency_ms: latencyMs,
      response: packed.response,
      selection_trace: packed.selection_trace,
      request_chars: packed.request_chars,
      response_chars: packed.response_chars,
      excluded: packed.excluded,
    };
    await handle.write(JSON.stringify(row) + '\n');
    await handle.sync();
    if (error)
      console.warn(
        `${scope} ${mode}: QMD MCP rejected ${question.id}: ${error}`,
      );
    if ((index + 1) % 10 === 0 || index + 1 === target)
      console.log(`${scope} ${mode}: ${index + 1}/${target} parents`);
  }
} finally {
  await handle.close();
  await client.close();
}
const bytes = await fs.readFile(runFile);
const finished = await readRows(runFile);
assert.equal(finished.length, target);
await fs.writeFile(
  receiptFile,
  JSON.stringify(
    {
      ...frozen,
      status: smokeCount === null ? 'complete' : 'smoke',
      server_version: serverVersion,
      questions: finished.length,
      result_sha256: sha(bytes),
      native_errors: finished.filter((row) => row.native_error).length,
      latency_ms: finished.map((row) => row.latency_ms),
    },
    null,
    2,
  ) + '\n',
);
console.log(`${scope} ${mode}: receipt ${receiptFile}`);
