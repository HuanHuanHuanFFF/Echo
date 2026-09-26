#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const rootArgumentIndex = process.argv.indexOf('--root');
const experimentRootArgument =
  rootArgumentIndex >= 0
    ? process.argv[rootArgumentIndex + 1]
    : process.env.KHOJ_COMPARISON_ROOT;
if (!experimentRootArgument)
  throw new Error('--root or KHOJ_COMPARISON_ROOT is required');
const experimentRoot = path.resolve(experimentRootArgument);
const runtimeRoot = path.join(experimentRoot, 'khoj-runtime');
const defaultCorpusRoot = path.join(experimentRoot, 'corpus-v1');
const defaultPublicRoot = path.resolve(
  experimentRoot,
  '..',
  'public-benchmarks-2026-09-19',
);
const defaultIndexFreezePath = path.join(experimentRoot, 'index-freeze.json');
const defaultQueryFreezePath = path.join(experimentRoot, 'freeze.json');
const defaultEchoRoot = path.resolve(scriptRoot, '..');
const execFileAsync = promisify(execFile);
const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  console.log(
    [
      'Khoj comparison adapter. Supply --root <ROOT> or KHOJ_COMPARISON_ROOT.',
      '',
      'Inspect input hashes/denominators or run the offline synthetic adapter smoke:',
      '  node evals/product-khoj-replay.mjs --root <ROOT> --mode plan --kind native --scope A-test',
      '  node evals/product-khoj-replay.mjs --root <ROOT> --mode smoke',
      '',
      'Start only the isolated Khoj compose project:',
      '  $root = "<comparison-root>"',
      '  docker compose -p khoj-product-comparison -f "$root/khoj-runtime/compose.yml" up -d server',
      '',
      'A-test already has its own user. Create a distinct token for each remaining full-document scope:',
      '  $scopes = @("B-test", "C-test", "D-test", "mixed-test", "qasper")',
      '  foreach ($scope in $scopes) {',
      '    $user = "echo-compare-" + $scope.ToLower()',
      '    node evals/product-khoj-replay.mjs --root $root --mode create-user --scope $scope --username $user',
      '    node evals/product-khoj-replay.mjs --root $root --mode index --kind native --scope $scope --username $user --token-file "$root/khoj-runtime/data/config/$scope-token"',
      '  }',
      'Each token stays in ROOT/khoj-runtime/data/config/<scope>-token and is never printed.',
      '',
      'Fixed-unit index example:',
      '  node evals/product-khoj-replay.mjs --root $root --mode create-user --scope du',
      '  node evals/product-khoj-replay.mjs --root $root --mode index --kind fixed --scope du --username echo-compare-du --token-file "$root/khoj-runtime/data/config/du-token"',
      '',
      'Search both frozen conditions only after global freeze.json and the scope query-index receipt exist:',
      '  node evals/product-khoj-replay.mjs --root $root --mode live --kind native --scope A-test --username echo-compare-a-test --token-file "$root/khoj-runtime/data/config/A-test-token"',
      'Stop after the batch with docker compose -p khoj-product-comparison -f "$root/khoj-runtime/compose.yml" stop server database.',
      'Native HTTP returns at most 10 results; it cannot support an R@50 claim.',
    ].join('\n'),
  );
}

async function* jsonLines(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  let pending = '';
  let line = 0;
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const value = pending.slice(0, end);
        pending = pending.slice(end + 1);
        line++;
        if (value.trim()) {
          try {
            yield JSON.parse(value);
          } catch (error) {
            throw new Error(
              'Invalid JSONL record ' +
                file +
                ':' +
                line +
                ': ' +
                error.message,
            );
          }
        }
      }
    }
    if (pending.trim()) {
      line++;
      try {
        yield JSON.parse(pending);
      } catch (error) {
        throw new Error(
          'Invalid JSONL record ' + file + ':' + line + ': ' + error.message,
        );
      }
    }
  } finally {
    stream.destroy();
  }
}

async function readJsonLines(file) {
  const rows = [];
  for await (const row of jsonLines(file)) rows.push(row);
  return rows;
}

async function fileSha256(file) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function manifestPath(manifest, scope, kind) {
  const item = manifest.scopes[scope];
  assert.ok(item, 'Unknown corpus scope: ' + scope);
  if (kind === 'native') {
    assert.ok(
      item.kind !== 'official-fixed-unit',
      'Native kind cannot use an official fixed scope',
    );
  } else {
    assert.equal(
      item.kind,
      'official-fixed-unit',
      'Fixed kind requires official-fixed-unit scope',
    );
  }
  return item;
}

function deriveFixedPath(id) {
  const match = String(id).match(/^(.*)_([0-9]+)_([0-9]+)$/);
  return match ? match[1] : String(id);
}

function sourceIdOf(doc) {
  return doc.source_id || doc.id || doc._id;
}

function pathOf(doc, kind) {
  if (doc.relative_path) return doc.relative_path;
  if (doc.path) return doc.path;
  if (kind === 'fixed') return deriveFixedPath(doc.id || doc._id);
  return doc.id || doc._id;
}

function corpusFileOf(entry) {
  return entry.corpus.path;
}

function queryFileOf(entry) {
  return entry.queries.path;
}

async function loadScope(corpusRoot, manifest, scope, kind, options = {}) {
  const { loadQuestions = true, buildResultMap = true } = options;
  const entry = manifestPath(manifest, scope, kind);
  const corpusFile = corpusFileOf(entry);
  const queryFile = queryFileOf(entry);
  assert.ok(fs.existsSync(corpusFile), 'Missing corpus file: ' + corpusFile);
  assert.ok(fs.existsSync(queryFile), 'Missing query file: ' + queryFile);

  const docByPath = new Map();
  const docBySource = new Map();
  const fixedByCorpusId = new Map();
  let documents = 0;
  for await (const doc of jsonLines(corpusFile)) {
    const id = doc.id || doc._id;
    assert.equal(typeof id, 'string', 'corpus row has no id');
    assert.equal(typeof doc.text, 'string', 'corpus row has no text: ' + id);
    const normalized = {
      id,
      source_id: sourceIdOf(doc),
      relative_path: pathOf({ ...doc, id }, kind),
    };
    documents++;
    if (!buildResultMap) continue;
    if (kind === 'fixed') {
      const corpusId = fixedCorpusId(normalized.source_id);
      assert.ok(
        !fixedByCorpusId.has(corpusId),
        'duplicate fixed corpus id: ' + id,
      );
      fixedByCorpusId.set(corpusId, {
        ...normalized,
        text_sha256: sha256(doc.text),
      });
    } else {
      assert.ok(
        !docBySource.has(normalized.source_id),
        'duplicate source_id: ' + normalized.source_id,
      );
      assert.ok(
        !docByPath.has(normalized.relative_path),
        'duplicate relative_path: ' + normalized.relative_path,
      );
      docBySource.set(normalized.source_id, normalized);
      docByPath.set(normalized.relative_path, normalized);
    }
  }
  assert.equal(
    documents,
    entry.documents,
    scope + ' document denominator changed',
  );

  const queryRows = loadQuestions ? await readJsonLines(queryFile) : [];
  if (loadQuestions)
    assert.equal(
      queryRows.length,
      entry.questions,
      scope + ' question denominator changed',
    );
  const questions = queryRows.map((row) =>
    normalizeQuestion(row, scope, docBySource),
  );
  assert.equal(new Set(questions.map((q) => q.id)).size, questions.length);
  return {
    manifest: entry,
    corpusFile,
    queryFile,
    documents,
    questions,
    docByPath,
    docBySource,
    fixedByCorpusId,
  };
}

function normalizeQuestion(row, scope, docBySource) {
  const id = row.id || row.query_id;
  assert.equal(typeof id, 'string', 'question has no id');
  let queries;
  if (Array.isArray(row.queries) && row.queries.length) {
    queries = row.queries.map((query, index) => ({
      query_id: query.id || query.query_id || id + ':q' + index,
      text: String(query.text || '').trim(),
    }));
  } else {
    queries = [{ query_id: id, text: String(row.text || '').trim() }];
  }
  assert.ok(
    queries.every((q) => q.text),
    'question has an empty query: ' + id,
  );
  const sourceId = row.source_id || null;
  if (scope === 'qasper') {
    assert.ok(sourceId, 'QASPER question has no source_id: ' + id);
    assert.ok(
      docBySource.has(sourceId),
      'QASPER source_id has no document: ' + sourceId,
    );
  }
  return {
    id,
    scope,
    source_id: sourceId,
    text: row.text || queries[0].text,
    queries,
    raw: row,
  };
}

function queryForScope(question, query, scope, docBySource) {
  if (scope !== 'qasper') {
    return {
      text: query.text,
      filter: null,
      filter_applied_before_top10: false,
    };
  }
  const doc = docBySource.get(question.source_id);
  assert.ok(doc, 'QASPER target document missing: ' + question.source_id);
  const target = doc.relative_path.replaceAll('"', '\\"');
  return {
    text: 'file:"' + target + '" ' + query.text,
    filter: { file: doc.relative_path, source_id: question.source_id },
    filter_applied_before_top10: true,
  };
}

function conditionValues(value) {
  const normalized = String(value || 'both').toLowerCase();
  if (normalized === 'both' || normalized === 'all') return [false, true];
  if (['false', 'rfalse', 'no-rerank', 'norank'].includes(normalized))
    return [false];
  if (['true', 'rtrue', 'rerank', 'rank'].includes(normalized)) return [true];
  throw new Error('condition must be both, false, or true');
}

function resultId(sourceId, text) {
  return sha256(JSON.stringify([sourceId, text])).slice(0, 32);
}

function fixedCorpusId(sourceId) {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const digest = crypto
    .createHash('sha1')
    .update(namespace)
    .update('khoj-fixed-corpus:' + sourceId, 'utf8')
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resolveReturnedDoc(additional, docsByPath) {
  const returnedPath = additional?.file;
  assert.equal(
    typeof returnedPath,
    'string',
    'Khoj result has no additional.file',
  );
  if (docsByPath.has(returnedPath)) return docsByPath.get(returnedPath);
  const candidates = [...docsByPath.values()].filter(
    (doc) =>
      returnedPath.endsWith('/' + doc.relative_path) ||
      returnedPath.endsWith('\\' + doc.relative_path),
  );
  assert.equal(
    candidates.length,
    1,
    'Cannot map native returned file: ' + returnedPath,
  );
  return candidates[0];
}

function responseField(result, snakeCase, kebabCase) {
  return Object.hasOwn(result, snakeCase)
    ? result[snakeCase]
    : result[kebabCase];
}

function mapNativeResult(result, docsByPath) {
  const additional = result.additional || {};
  const doc = resolveReturnedDoc(additional, docsByPath);
  const text = additional.compiled;
  assert.equal(typeof text, 'string', 'Khoj result has no additional.compiled');
  assert.ok(text.length > 0, 'Khoj result has empty additional.compiled');
  const corpusId = responseField(result, 'corpus_id', 'corpus-id');
  assert.equal(typeof corpusId, 'string', 'Khoj result has no corpus-id');
  const crossScore = responseField(result, 'cross_score', 'cross-score');
  const crossScorePresent = crossScore !== undefined && crossScore !== null;
  return {
    id: resultId(doc.source_id, text),
    native_id: corpusId,
    native_metadata: {
      entry: result.entry ?? null,
      heading: additional.heading ?? null,
      file: additional.file,
    },
    source_id: doc.source_id,
    path: doc.relative_path,
    text,
    score: result.score,
    cross_score: crossScorePresent ? crossScore : null,
    cross_score_present: crossScorePresent,
  };
}

function mapFixedResult(result, fixedByCorpusId) {
  const additional = result.additional || {};
  const text = additional.compiled;
  assert.equal(
    typeof text,
    'string',
    'Fixed Khoj result has no additional.compiled',
  );
  assert.ok(text.length > 0, 'Fixed Khoj result has empty additional.compiled');
  const corpusId = responseField(result, 'corpus_id', 'corpus-id');
  assert.equal(typeof corpusId, 'string', 'Fixed Khoj result has no corpus-id');
  const doc = fixedByCorpusId.get(corpusId);
  assert.ok(doc, 'Cannot map fixed native corpus_id to official unit');
  assert.equal(
    String(additional.file || '').replaceAll('\\', '/'),
    doc.relative_path.replaceAll('\\', '/'),
    'Fixed native file path does not match the official unit',
  );
  assert.equal(
    sha256(text),
    doc.text_sha256,
    'Khoj compiled text differs from the original fixed unit; filename/parent expansion is forbidden',
  );
  return {
    id: doc.id,
    score: result.score,
    native_id: corpusId,
    native_metadata: {
      entry: result.entry ?? null,
      heading: additional.heading ?? null,
      file: additional.file,
    },
    text,
    cross_score: responseField(result, 'cross_score', 'cross-score') ?? null,
    cross_score_present:
      responseField(result, 'cross_score', 'cross-score') !== undefined &&
      responseField(result, 'cross_score', 'cross-score') !== null,
  };
}

async function httpJson(base, token, route, options = {}) {
  const response = await fetch(base + route, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = { raw: text.slice(0, 2000) };
  }
  if (!response.ok) {
    throw new Error(
      (options.method || 'GET') +
        ' ' +
        route +
        ' -> ' +
        response.status +
        ' ' +
        JSON.stringify(value),
    );
  }
  return value;
}

async function uploadNativeCorpus(base, token, corpusFile, expectedDocuments) {
  let uploaded = 0;
  for await (const doc of jsonLines(corpusFile)) {
    const relativePath = pathOf(doc, 'native');
    assert.equal(
      typeof doc.text,
      'string',
      'Native corpus row has no text: ' + doc.id,
    );
    const form = new FormData();
    form.append(
      'files',
      new Blob([doc.text], { type: 'text/markdown' }),
      relativePath,
    );
    await httpJson(base, token, '/api/content?t=markdown&client=khoj-replay', {
      method: uploaded === 0 ? 'PUT' : 'PATCH',
      body: form,
    });
    uploaded++;
    if (uploaded % 25 === 0)
      console.log(
        JSON.stringify({
          phase: 'upload',
          completed: uploaded,
          total: expectedDocuments,
        }),
      );
  }
  assert.equal(
    uploaded,
    expectedDocuments,
    'Native upload document denominator changed',
  );
  return uploaded;
}

async function searchNative(
  base,
  token,
  question,
  query,
  scopeData,
  scope,
  rerank,
  kind,
) {
  const search = queryForScope(question, query, scope, scopeData.docBySource);
  const params = new URLSearchParams({
    q: search.text,
    n: '10',
    t: kind === 'fixed' ? 'plaintext' : 'markdown',
    r: String(rerank),
    dedupe: 'false',
  });
  const started = performance.now();
  const response = await httpJson(
    base,
    token,
    '/api/search?' + params.toString(),
  );
  const elapsed = performance.now() - started;
  assert.ok(
    Array.isArray(response),
    'Khoj /api/search did not return an array',
  );
  assert.ok(
    response.length <= 10,
    'Khoj native HTTP returned more than its fixed top 10',
  );
  const resultMap =
    kind === 'fixed' ? scopeData.fixedByCorpusId : scopeData.docByPath;
  const results = response.map((row) =>
    kind === 'fixed'
      ? mapFixedResult(row, resultMap)
      : mapNativeResult(row, resultMap),
  );
  if (scope === 'qasper') {
    const target = scopeData.docBySource.get(question.source_id);
    assert.ok(target, 'QASPER target document missing: ' + question.source_id);
    assert.ok(
      search.filter_applied_before_top10,
      'QASPER source filter was not enabled',
    );
    assert.ok(
      results.every(
        (result) =>
          result.source_id === question.source_id &&
          result.path === target.relative_path,
      ),
      'Khoj returned a candidate outside the QASPER target file filter',
    );
  }
  return {
    query_id: query.query_id,
    query: query.text,
    native_query: search.text,
    native_request: {
      method: 'GET',
      path: '/api/search',
      params: Object.fromEntries(params),
    },
    filter: search.filter,
    filter_applied_before_top10: search.filter_applied_before_top10,
    dedupe: false,
    native_return_limit: 10,
    native_response: response,
    native_response_sha256: sha256(JSON.stringify(response)),
    results,
    elapsed_ms: elapsed,
  };
}

async function loadPacker(echoRoot) {
  const file = path.join(echoRoot, 'evals', 'lib', 'product-evidence.mjs');
  assert.ok(fs.existsSync(file), 'Missing unified evidence packer: ' + file);
  return (await import(pathToFileURL(file).href)).packProductEvidence;
}

async function packNative(
  packProductEvidence,
  question,
  rankedQueries,
  packing = {},
) {
  const queryIds = question.queries.map((query) => query.query_id || query.id);
  assert.deepEqual(
    rankedQueries.map((query) => query.query_id),
    queryIds,
    'Khoj ranked query IDs/order differ from question.queries',
  );
  const packQuestion = {
    queries: question.queries.map((query, index) => ({
      id: queryIds[index],
      text: query.text,
    })),
    ...(question.source_id ? { source_id: question.source_id } : {}),
  };
  return packProductEvidence(packQuestion, rankedQueries, {
    topk: packing.topk ?? 10,
    source_cap: packing.source_cap ?? 6,
    max_context_chars: packing.max_context_chars ?? 20000,
  });
}

function fixedRows(question, rankedQueries) {
  assert.equal(
    question.queries.length,
    1,
    'Official fixed task must have one query',
  );
  assert.equal(
    rankedQueries.length,
    1,
    'Official fixed task must have one ranking',
  );
  const rankings = [];
  for (const query of rankedQueries) {
    for (const [index, result] of query.results.entries()) {
      rankings.push({
        id: result.id,
        rank: index + 1,
        score: result.score,
      });
    }
  }
  return rankings;
}

async function writeJsonl(file, rows) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const handle = await fsp.open(file, 'wx');
  try {
    for (const row of rows) await handle.write(JSON.stringify(row) + '\n');
  } finally {
    await handle.close();
  }
}

function fixedInputRow(doc) {
  const id = doc.id || doc._id;
  assert.equal(typeof id, 'string', 'Fixed corpus row has no id');
  assert.equal(
    typeof doc.text,
    'string',
    'Fixed corpus row has no text: ' + id,
  );
  const sourceId = id;
  return {
    unit_id: id,
    source_id: sourceId,
    corpus_id: fixedCorpusId(sourceId),
    file: pathOf({ ...doc, id }, 'fixed'),
    heading: '',
    raw: doc.text,
    compiled: doc.text,
  };
}

async function verifyPreparedFixed(output, scopeData) {
  const actual = jsonLines(output)[Symbol.asyncIterator]();
  let records = 0;
  for await (const doc of jsonLines(scopeData.corpusFile)) {
    const expected = fixedInputRow(doc);
    const found = await actual.next();
    assert.ok(
      !found.done,
      'Existing fixed input ended before the frozen corpus',
    );
    assert.deepEqual(
      found.value,
      expected,
      'Existing fixed input differs from corpus-v1; refuse overwrite',
    );
    records++;
  }
  assert.equal(
    (await actual.next()).done,
    true,
    'Existing fixed input has extra records',
  );
  assert.equal(records, scopeData.manifest.documents);
  return records;
}

async function prepareFixed(scopeData, scope) {
  const output = path.join(runtimeRoot, 'input', 'fixed-' + scope + '.jsonl');
  await fsp.mkdir(path.dirname(output), { recursive: true });
  let reused = false;
  let records = 0;
  if (fs.existsSync(output)) {
    records = await verifyPreparedFixed(output, scopeData);
    reused = true;
  } else {
    const handle = await fsp.open(output, 'wx');
    try {
      for await (const doc of jsonLines(scopeData.corpusFile)) {
        await handle.write(JSON.stringify(fixedInputRow(doc)) + '\n');
        records++;
      }
      assert.equal(records, scopeData.manifest.documents);
    } catch (error) {
      await handle.close();
      await fsp.rm(output, { force: true });
      throw error;
    }
    await handle.close();
  }
  return {
    output,
    records,
    reused,
    output_sha256: await fileSha256(output),
    mode: 'parser-bypass-native-entry',
    raw_equals_compiled: true,
    filename_added_to_compiled: false,
    vector_source: 'read-only public vectors.sqlite',
  };
}

async function inspectFixedCache(scopeData, publicRoot, echoRoot) {
  const Database = createRequire(path.join(echoRoot, 'package.json'))(
    'better-sqlite3',
  );
  const cachePath = path.join(publicRoot, 'vectors.sqlite');
  const planPath = path.join(publicRoot, 'embedding-plan.json');
  const plan = JSON.parse(await fsp.readFile(planPath, 'utf8'));
  assert.equal(plan.config.dimensions, 1024);
  const db = new Database(cachePath, { readonly: true });
  const find = db.prepare(
    "SELECT input,vector,vector_sha FROM entries WHERE key=? AND purpose='document'",
  );
  let missing = 0;
  let mismatch = 0;
  for await (const doc of jsonLines(scopeData.corpusFile)) {
    const key = sha256(
      JSON.stringify([plan.fingerprint, 'document', doc.text]),
    );
    const row = find.get(key);
    if (!row || !row.vector) {
      missing++;
      continue;
    }
    if (
      row.input !== doc.text ||
      row.vector.length !== 4096 ||
      sha256(row.vector) !== row.vector_sha
    )
      mismatch++;
  }
  db.close();
  return {
    checked: scopeData.documents,
    missing,
    mismatch,
    cache_sha256: await fileSha256(cachePath),
    plan_sha256: await fileSha256(planPath),
  };
}

async function offlineSmoke() {
  const docs = [
    {
      id: 'smoke-doc-a',
      source_id: 'smoke-doc-a',
      relative_path: 'smoke/a.md',
    },
    {
      id: 'smoke-doc-b',
      source_id: 'smoke-doc-b',
      relative_path: 'smoke/b.md',
    },
  ];
  const map = new Map(docs.map((doc) => [doc.relative_path, doc]));
  const nativeResponse = [
    {
      'corpus-id': 'native-a',
      entry: 'Alpha evidence.',
      score: 0.1,
      'cross-score': 0.42,
      additional: {
        file: 'smoke/a.md',
        compiled: '# smoke/a.md\n# A\nAlpha evidence.',
        heading: '# A',
      },
    },
    {
      'corpus-id': 'native-b',
      entry: 'Beta evidence.',
      score: 0.2,
      additional: {
        file: 'smoke/b.md',
        compiled: '# smoke/b.md\n# B\nBeta evidence.',
        heading: '# B',
      },
    },
  ];
  const question = {
    id: 'smoke-q',
    scope: 'smoke',
    queries: [{ query_id: 'q0', text: 'Alpha' }],
  };
  const ranked = [
    {
      query_id: 'q0',
      query: 'Alpha',
      results: nativeResponse.map((row) => mapNativeResult(row, map)),
    },
  ];
  const packProductEvidence = await loadPacker(defaultEchoRoot);
  const packed = await packNative(packProductEvidence, question, ranked);
  const nativeRow = {
    ...packed,
    id: question.id,
    scope: question.scope,
    condition: {
      name: 'khoj-rerank',
      rerank: true,
      dedupe: false,
      return_limit: 10,
    },
    ranked_queries: ranked,
  };
  assert.equal(
    ranked[0].results[0].id,
    resultId('smoke-doc-a', nativeResponse[0].additional.compiled),
  );
  assert.equal(ranked[0].results[0].native_metadata.entry, 'Alpha evidence.');
  assert.equal(ranked[0].results[0].native_id, 'native-a');
  assert.equal(ranked[0].results[0].cross_score, 0.42);
  assert.ok(
    nativeRow.request && nativeRow.response,
    'shared packer output must be top-level',
  );
  assert.equal(Object.hasOwn(nativeRow, 'packProductEvidence'), false);
  assert.throws(
    () =>
      mapNativeResult(
        {
          'corpus-id': 'missing-compiled',
          entry: 'parent/raw text',
          additional: { file: 'smoke/a.md' },
        },
        map,
      ),
    /additional\.compiled/,
  );

  const fixedUnit = {
    id: 'smoke-unit-1',
    source_id: 'smoke-unit-1',
    relative_path: 'smoke-unit-1',
    text_sha256: sha256('Exact original unit.'),
  };
  const fixedCorpusIdValue = fixedCorpusId(fixedUnit.source_id);
  const fixed = mapFixedResult(
    {
      'corpus-id': fixedCorpusIdValue,
      entry: 'Exact original unit.',
      score: 0.3,
      additional: {
        file: fixedUnit.relative_path,
        compiled: 'Exact original unit.',
        heading: '',
      },
    },
    new Map([[fixedCorpusIdValue, fixedUnit]]),
  );
  assert.equal(fixed.id, fixedUnit.id);
  assert.throws(
    () =>
      mapFixedResult(
        {
          'corpus-id': fixedCorpusIdValue,
          entry: 'Exact original unit.',
          score: 0.3,
          additional: {
            file: fixedUnit.relative_path,
            compiled: '# filename\nExact original unit.',
          },
        },
        new Map([[fixedCorpusIdValue, fixedUnit]]),
      ),
    /filename\/parent expansion is forbidden/,
  );
  return {
    mode: 'offline-contract-smoke',
    network_forbidden: true,
    native: { row: nativeRow },
    fixed: {
      id: fixed.id,
      native_id: fixed.native_id,
      native_metadata: fixed.native_metadata,
    },
  };
}

async function plan() {
  const corpusRoot = path.resolve(option('--corpus-root', defaultCorpusRoot));
  const publicRoot = path.resolve(option('--public-root', defaultPublicRoot));
  const manifest = JSON.parse(
    await fsp.readFile(path.join(corpusRoot, 'manifest.json'), 'utf8'),
  );
  const scope = option('--scope');
  const kind = option('--kind', 'native');
  assert.ok(scope, '--scope is required');
  const data = await loadScope(corpusRoot, manifest, scope, kind, {
    buildResultMap: scope === 'qasper',
  });
  const checks = {
    corpus_sha256: await fileSha256(data.corpusFile),
    queries_sha256: await fileSha256(data.queryFile),
    expected_corpus_sha256:
      data.manifest.corpus?.sha256 || data.manifest.source_corpus?.sha256,
    expected_queries_sha256:
      data.manifest.queries?.sha256 || data.manifest.source_queries?.sha256,
    documents: data.documents,
    questions: data.questions.length,
  };
  assert.equal(
    checks.corpus_sha256,
    checks.expected_corpus_sha256,
    'corpus-v1 corpus sha changed',
  );
  assert.equal(
    checks.queries_sha256,
    checks.expected_queries_sha256,
    'corpus-v1 query sha changed',
  );
  if (kind === 'fixed' && hasFlag('--verify-cache'))
    checks.fixed_cache = await inspectFixedCache(
      data,
      publicRoot,
      path.resolve(option('--echo-root', defaultEchoRoot)),
    );
  const output = {
    mode: 'plan',
    kind,
    scope,
    source: { corpus_file: data.corpusFile, query_file: data.queryFile },
    checks,
    conditions: conditionValues(option('--condition', 'both')).map(
      (rerank) => ({ rerank, native_http_topk: 10 }),
    ),
    qasper_filter:
      scope === 'qasper'
        ? 'file filter is applied in EntryAdapters.apply_filters before vector ordering and top10 slice'
        : null,
    golden_labels_read: false,
    model_calls: false,
  };
  const outputPath = option('--output');
  if (outputPath) {
    await fsp.writeFile(outputPath, JSON.stringify(output, null, 2) + '\n', {
      flag: 'wx',
    });
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
  return output;
}

async function importFixed(scope, username) {
  const composeFile = path.join(runtimeRoot, 'compose.yml');
  const input = '/runtime/input/fixed-' + scope + '.jsonl';
  const args = [
    'compose',
    '-p',
    'khoj-product-comparison',
    '-f',
    composeFile,
    'exec',
    '-T',
    'server',
    'python3',
    '/runtime/scripts/import_fixed_entries.py',
    '--input',
    input,
    '--username',
    username,
    '--model-name',
    'default',
    '--batch-size',
    '500',
    '--vector-cache-db',
    '/runtime/cache/vectors.sqlite',
    '--vector-cache-plan',
    '/runtime/cache/embedding-plan.json',
    '--apply',
    '--receipt',
    '/root/.khoj/fixed-' + scope + '-import.json',
  ];
  try {
    const result = await execFileAsync('docker', args, { windowsHide: true });
    if (result.stderr && result.stderr.trim())
      console.error(result.stderr.trim());
    console.log(result.stdout.trim());
  } catch (error) {
    const details =
      error.stderr && error.stderr.trim() ? '\n' + error.stderr.trim() : '';
    throw new Error(error.message + details);
  }
}

function defaultUsernameRegistryPath() {
  return path.join(runtimeRoot, 'results', 'scope-user-registry.json');
}

function scopeIndexReceiptPath(scope, kind) {
  const name =
    kind === 'native'
      ? 'index-native-scope-receipt.json'
      : 'index-fixed-scope-receipt.json';
  return path.join(experimentRoot, 'indexes', 'khoj', scope, name);
}

function scopeQueryIndexReceiptPath(scope) {
  return path.join(
    experimentRoot,
    'indexes',
    'khoj',
    scope,
    'query-index-receipt.json',
  );
}

async function updateScopeUserRegistry(scope, username, register) {
  const file = defaultUsernameRegistryPath();
  let registry;
  if (fs.existsSync(file))
    registry = JSON.parse(await fsp.readFile(file, 'utf8'));
  else registry = { version: 1, scope_users: {} };
  assert.equal(registry.version, 1, 'Unsupported scope-user registry version');
  assert.ok(registry.scope_users && typeof registry.scope_users === 'object');
  const assigned = registry.scope_users[scope];
  if (assigned)
    assert.equal(
      assigned,
      username,
      'This scope is already assigned to another Khoj user',
    );
  for (const [otherScope, otherUser] of Object.entries(registry.scope_users)) {
    if (otherScope !== scope)
      assert.notEqual(
        otherUser,
        username,
        'Every corpus scope requires its own Khoj user',
      );
  }
  if (!register) {
    assert.equal(assigned, username, 'Index this scope before searching it');
    return;
  }
  registry.scope_users[scope] = username;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', {
    flag: 'wx',
  });
  await fsp.rename(temporary, file);
}

async function readToken() {
  const tokenFile = option('--token-file', process.env.KHOJ_TOKEN_FILE);
  const token =
    process.env.KHOJ_API_TOKEN ||
    (tokenFile ? (await fsp.readFile(tokenFile, 'utf8')).trim() : '');
  assert.ok(token, '--token-file or KHOJ_API_TOKEN is required');
  return token;
}

function baseUrl() {
  return option(
    '--base-url',
    process.env.KHOJ_BASE_URL || 'http://127.0.0.1:14211',
  ).replace(/\/+$/, '');
}

async function authenticatedProfile(base, token, expectedUsername) {
  const profile = await httpJson(base, token, '/api/settings');
  assert.equal(
    profile.username,
    expectedUsername,
    'Khoj token belongs to a different user than --username',
  );
  return profile;
}

async function readManifest(corpusRoot) {
  const manifestFile = path.join(corpusRoot, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
  return {
    manifestFile,
    manifest,
    manifestSha256: await fileSha256(manifestFile),
  };
}

async function verifyInputBindings(manifest, manifestSha256, scope, kind) {
  const entry = manifestPath(manifest, scope, kind);
  const corpusSha256 = await fileSha256(entry.corpus.path);
  const queriesSha256 = await fileSha256(entry.queries.path);
  assert.equal(
    corpusSha256,
    entry.corpus.sha256,
    'corpus-v1 corpus sha changed',
  );
  assert.equal(
    queriesSha256,
    entry.queries.sha256,
    'corpus-v1 query sha changed',
  );
  return {
    manifest_sha256: manifestSha256,
    corpus_sha256: corpusSha256,
    queries_sha256: queriesSha256,
    documents: entry.documents,
    questions: entry.questions,
  };
}

async function verifyIndexFreeze(manifestSha256, manifest, scope, kind) {
  const freezeFile = path.resolve(
    option('--index-freeze', defaultIndexFreezePath),
  );
  const freeze = JSON.parse(await fsp.readFile(freezeFile, 'utf8'));
  assert.equal(
    freeze.status,
    'index-inputs-frozen',
    'index-freeze.json is not frozen',
  );
  assert.equal(
    freeze.corpus_manifest_sha256,
    manifestSha256,
    'index-freeze corpus manifest changed',
  );
  assert.equal(
    freeze.model?.name,
    'qwen3.7-text-embedding',
    'index-freeze embedding model changed',
  );
  assert.equal(
    freeze.model?.dimensions,
    1024,
    'index-freeze embedding dimensions changed',
  );
  const runtimeManifestFile = path.join(runtimeRoot, 'runtime-manifest.json');
  const runtimeManifest = JSON.parse(
    await fsp.readFile(runtimeManifestFile, 'utf8'),
  );
  assert.equal(
    freeze.khoj?.commit,
    runtimeManifest.source?.commit,
    'index-freeze Khoj source revision changed',
  );
  const composePath = path.join(runtimeRoot, 'compose.yml');
  const bootstrapPath = path.join(
    runtimeRoot,
    'scripts',
    'bootstrap_search_model.py',
  );
  const composeText = await fsp.readFile(composePath, 'utf8');
  const bootstrapText = await fsp.readFile(bootstrapPath, 'utf8');
  assert.ok(
    composeText.includes('http://host.docker.internal:15109/v1'),
    'Khoj compose does not route embeddings through the local gateway',
  );
  assert.ok(
    composeText.includes('qwen3.7-text-embedding') &&
      composeText.includes('"1024"'),
    'Khoj compose model/dimension changed',
  );
  assert.ok(
    bootstrapText.includes(
      'DEFAULT_ENDPOINT = "http://host.docker.internal:15109/v1"',
    ),
  );
  assert.ok(
    bootstrapText.includes('DEFAULT_MODEL = "qwen3.7-text-embedding"') &&
      bootstrapText.includes('DEFAULT_DIMENSIONS = 1024'),
  );
  if (kind === 'fixed') {
    assert.match(
      String(freeze.khoj?.fixed_units || ''),
      /parser bypass.*exact text/i,
    );
  } else {
    assert.ok(
      freeze.khoj?.markdown_parser,
      'index-freeze has no native Markdown parser contract',
    );
  }
  const publicRoot = path.resolve(option('--public-root', defaultPublicRoot));
  const embeddingPlanPath = path.join(publicRoot, 'embedding-plan.json');
  const embeddingPlan = JSON.parse(
    await fsp.readFile(embeddingPlanPath, 'utf8'),
  );
  assert.equal(
    embeddingPlan.fingerprint,
    freeze.model.fingerprint,
    'public vector cache model fingerprint changed',
  );
  assert.equal(
    embeddingPlan.config?.dimensions,
    1024,
    'public vector cache dimensions changed',
  );
  return {
    path: freezeFile,
    sha256: await fileSha256(freezeFile),
    model_fingerprint: freeze.model.fingerprint,
    embedding_plan_sha256: await fileSha256(embeddingPlanPath),
    runtime_config_files: [
      { path: composePath, sha256: await fileSha256(composePath) },
      { path: bootstrapPath, sha256: await fileSha256(bootstrapPath) },
    ],
  };
}

function canonicalPath(file) {
  return path.resolve(file).replaceAll('\\', '/').toLowerCase();
}

function executionFileCandidates(value, echoRoot) {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value))
    return [path.resolve(value)];
  return [
    path.resolve(experimentRoot, value),
    path.resolve(runtimeRoot, value),
    path.resolve(echoRoot, value),
  ];
}

async function verifyFrozenExecutionFiles(freeze, echoRoot) {
  assert.ok(
    Array.isArray(freeze.execution_files),
    'freeze.json has no execution_files list',
  );
  const bound = new Map();
  for (const item of freeze.execution_files) {
    assert.equal(
      typeof item.path,
      'string',
      'execution_files entry has no path',
    );
    assert.match(
      String(item.sha256 || ''),
      /^[0-9a-f]{64}$/i,
      'execution_files entry has no SHA-256',
    );
    const candidates = executionFileCandidates(item.path, echoRoot).filter(
      (candidate) => fs.existsSync(candidate),
    );
    let matched;
    for (const candidate of candidates) {
      if (
        (await fileSha256(candidate)).toLowerCase() ===
        item.sha256.toLowerCase()
      ) {
        matched = candidate;
        break;
      }
    }
    assert.ok(
      matched,
      'Frozen execution file is missing or changed: ' + item.path,
    );
    bound.set(canonicalPath(matched), item.sha256.toLowerCase());
  }
  const required = [
    path.join(scriptRoot, 'product-khoj-replay.mjs'),
    path.join(scriptRoot, 'import-product-khoj-fixed.py'),
    path.join(runtimeRoot, 'scripts', 'khoj_replay.mjs'),
    path.join(runtimeRoot, 'scripts', 'import_fixed_entries.py'),
    path.join(runtimeRoot, 'scripts', 'bootstrap_search_model.py'),
    path.join(echoRoot, 'evals', 'lib', 'product-evidence.mjs'),
  ];
  for (const file of required) {
    assert.ok(
      bound.has(canonicalPath(file)),
      'freeze.json does not bind execution file: ' + file,
    );
  }
  return [...bound.entries()].map(([file, sha256]) => ({ path: file, sha256 }));
}

async function verifyQueryFreeze(
  manifestSha256,
  manifest,
  scope,
  kind,
  echoRoot,
) {
  const freezeFile = path.resolve(option('--freeze', defaultQueryFreezePath));
  const freeze = JSON.parse(await fsp.readFile(freezeFile, 'utf8'));
  assert.equal(freeze.status, 'frozen', 'root freeze.json is not frozen');
  const { verifyRuntimeImages } = await import(
    pathToFileURL(path.join(echoRoot, 'evals/lib/product-freeze.mjs')).href
  );
  await verifyRuntimeImages(freeze.runtime_images, 'khoj');
  assert.equal(
    freeze.corpus_manifest_sha256,
    manifestSha256,
    'query freeze corpus manifest changed',
  );
  const packing = freeze.packing || {};
  assert.equal(packing.topk, 10, 'Frozen topk changed');
  assert.equal(packing.source_cap, 6, 'Frozen source cap changed');
  assert.equal(
    packing.max_context_chars,
    20000,
    'Frozen packed-context budget changed',
  );
  const dense = freeze.conditions?.['khoj-dense'];
  const rerank = freeze.conditions?.['khoj-rerank'];
  assert.ok(dense && rerank, 'freeze.json must include both Khoj conditions');
  assert.equal(dense.fixed_return_limit, 10);
  assert.equal(dense.rerank, false);
  assert.equal(dense.dedupe, false);
  assert.equal(rerank.fixed_return_limit, 10);
  assert.equal(rerank.rerank, true);
  assert.equal(rerank.dedupe, false);
  const inputs = await verifyInputBindings(
    manifest,
    manifestSha256,
    scope,
    kind,
  );
  const executionFiles = await verifyFrozenExecutionFiles(freeze, echoRoot);
  return {
    path: freezeFile,
    sha256: await fileSha256(freezeFile),
    packing,
    conditions: [
      { name: 'khoj-dense', ...dense },
      { name: 'khoj-rerank', ...rerank },
    ],
    execution_files: executionFiles,
    inputs,
  };
}

async function verifyQueryIndexReceipt(
  scope,
  corpusSha256,
  indexReceiptPath,
  echoRoot,
) {
  const { validateIndexReceipt } = await import(
    pathToFileURL(path.join(echoRoot, 'evals/lib/product-index-receipt.mjs'))
      .href
  );
  const currentManifest = JSON.parse(
    await fsp.readFile(path.join(defaultCorpusRoot, 'manifest.json'), 'utf8'),
  );
  const indexParameters = JSON.parse(
    await fsp.readFile(defaultIndexFreezePath, 'utf8'),
  );
  await validateIndexReceipt({
    root: experimentRoot,
    product: 'khoj',
    scope,
    info: currentManifest.scopes[scope],
    modelFingerprint: indexParameters.model.fingerprint,
  });
  const file = scopeQueryIndexReceiptPath(scope);
  const receipt = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(
    receipt.status,
    'frozen',
    'Per-scope query-index receipt is not frozen',
  );
  assert.equal(
    receipt.scope,
    scope,
    'Per-scope query-index receipt scope changed',
  );
  assert.equal(
    receipt.corpus_sha256,
    corpusSha256,
    'Per-scope query-index corpus changed',
  );
  assert.ok(
    typeof receipt.created_at === 'string' &&
      Number.isFinite(Date.parse(receipt.created_at)),
  );
  assert.ok(
    Array.isArray(receipt.execution_files) &&
      receipt.execution_files.length > 0,
  );
  const boundFiles = new Set();
  for (const item of receipt.execution_files) {
    assert.equal(
      typeof item.path,
      'string',
      'query-index execution file has no path',
    );
    assert.match(
      String(item.sha256 || ''),
      /^[0-9a-f]{64}$/i,
      'query-index execution file has no SHA-256',
    );
    const candidates = executionFileCandidates(item.path, echoRoot).filter(
      (candidate) => fs.existsSync(candidate),
    );
    let matched;
    for (const candidate of candidates) {
      if (
        (await fileSha256(candidate)).toLowerCase() ===
        item.sha256.toLowerCase()
      ) {
        matched = candidate;
        break;
      }
    }
    assert.ok(
      matched,
      'Per-scope indexed state file is missing or changed: ' + item.path,
    );
    boundFiles.add(canonicalPath(matched));
  }
  assert.ok(
    boundFiles.has(canonicalPath(indexReceiptPath)),
    'query-index receipt does not bind the scope index receipt',
  );
  return {
    path: file,
    sha256: await fileSha256(file),
    execution_files: [...boundFiles],
  };
}

async function createScopeUser() {
  const scope = option('--scope');
  assert.ok(
    scope &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope) &&
      !scope.includes('..'),
    '--scope must be a safe corpus scope name',
  );
  const username = option('--username', 'echo-compare-' + scope.toLowerCase());
  assert.match(
    username,
    /^[a-z0-9][a-z0-9-]*$/,
    '--username must be lowercase letters/numbers/hyphens',
  );
  const tokenName = option('--token-name', scope + '-token');
  assert.match(
    tokenName,
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    '--token-name must be a safe filename',
  );
  assert.ok(!tokenName.includes('..'));
  const hostTokenPath = path.join(runtimeRoot, 'data', 'config', tokenName);
  assert.ok(
    !fs.existsSync(hostTokenPath),
    'Token file already exists; refusing to replace it',
  );
  const usernameLiteral = JSON.stringify(username);
  const tokenNameLiteral = JSON.stringify(tokenName);
  const pythonCode = [
    'import django, json, os, secrets',
    'from pathlib import Path',
    "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'khoj.app.settings')",
    'django.setup()',
    'from django.db import transaction',
    'from khoj.database.models import KhojApiUser, KhojUser',
    'username = ' + usernameLiteral,
    "token_file = Path('/root/.khoj') / " + tokenNameLiteral,
    "if token_file.exists(): raise RuntimeError('Scope token file already exists')",
    "if KhojUser.objects.filter(username=username).exists(): raise RuntimeError('Scope user already exists')",
    'with transaction.atomic():',
    '    user = KhojUser.objects.create_user(username=username, email=username + "@localhost.invalid", password=secrets.token_urlsafe(32), is_active=True, is_staff=False)',
    '    token = "kk-" + secrets.token_urlsafe(32)',
    '    api_user = KhojApiUser.objects.create(user=user, token=token, name=username[:50])',
    'fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)',
    "with os.fdopen(fd, 'w', encoding='utf-8') as stream: stream.write(api_user.token)",
    "print(json.dumps({'status':'created','username':username,'token_file':str(token_file),'token_printed':False}))",
  ].join('\n');
  const composeFile = path.join(runtimeRoot, 'compose.yml');
  try {
    const result = await execFileAsync(
      'docker',
      [
        'compose',
        '-p',
        'khoj-product-comparison',
        '-f',
        composeFile,
        'exec',
        '-T',
        'server',
        'python3',
        '-c',
        pythonCode,
      ],
      { windowsHide: true },
    );
    if (result.stderr && result.stderr.trim())
      console.error(result.stderr.trim());
    console.log(result.stdout.trim());
  } catch (error) {
    const details =
      error.stderr && error.stderr.trim() ? '\n' + error.stderr.trim() : '';
    throw new Error(error.message + details);
  }
}

async function index() {
  const corpusRoot = path.resolve(option('--corpus-root', defaultCorpusRoot));
  const { manifest, manifestSha256 } = await readManifest(corpusRoot);
  const scope = option('--scope');
  const kind = option('--kind', 'native');
  const username = option(
    '--username',
    process.env.KHOJ_COMPARISON_USERNAME || '',
  );
  assert.ok(
    scope && username,
    '--scope and --username are required for indexing',
  );
  const indexFreeze = await verifyIndexFreeze(
    manifestSha256,
    manifest,
    scope,
    kind,
  );
  const inputs = await verifyInputBindings(
    manifest,
    manifestSha256,
    scope,
    kind,
  );
  const data = await loadScope(corpusRoot, manifest, scope, kind, {
    loadQuestions: false,
    buildResultMap: false,
  });
  const token = await readToken();
  const profile = await authenticatedProfile(baseUrl(), token, username);
  const receiptPath = path.resolve(
    option('--receipt', scopeIndexReceiptPath(scope, kind)),
  );
  if (profile.has_documents) {
    assert.ok(
      fs.existsSync(receiptPath),
      'Dedicated Khoj user already has documents but no matching import receipt; refusing to replace them',
    );
    const previous = JSON.parse(await fsp.readFile(receiptPath, 'utf8'));
    assert.equal(previous.status, 'indexed');
    assert.equal(previous.kind, kind);
    assert.equal(previous.scope, scope);
    assert.equal(previous.username, username);
    assert.equal(previous.inputs?.corpus_sha256, inputs.corpus_sha256);
    assert.equal(previous.inputs?.queries_sha256, inputs.queries_sha256);
    assert.equal(previous.index_freeze?.sha256, indexFreeze.sha256);
    await updateScopeUserRegistry(scope, username, true);
    console.log(JSON.stringify({ reused_index: true, receipt: receiptPath }));
    return previous;
  }
  assert.ok(
    !fs.existsSync(receiptPath),
    'Scope index receipt already exists while its user is empty; choose a fresh scope user',
  );
  await updateScopeUserRegistry(scope, username, true);
  let indexed;
  if (kind === 'native') {
    indexed = {
      uploaded_documents: await uploadNativeCorpus(
        baseUrl(),
        token,
        data.corpusFile,
        data.manifest.documents,
      ),
      upload_method: 'first PUT then PATCH',
      parser: 'Khoj native Markdown content endpoint',
    };
  } else {
    const prepared = await prepareFixed(data, scope);
    assert.equal(prepared.records, data.manifest.documents);
    await importFixed(scope, username);
    const importerReceiptPath = path.join(
      runtimeRoot,
      'data',
      'config',
      `fixed-${scope}-import.json`,
    );
    assert.ok(
      fs.existsSync(importerReceiptPath),
      'Khoj fixed importer did not write its receipt',
    );
    const importerReceipt = JSON.parse(
      await fsp.readFile(importerReceiptPath, 'utf8'),
    );
    assert.equal(importerReceipt.input_sha256, prepared.output_sha256);
    assert.equal(importerReceipt.records_validated, data.manifest.documents);
    assert.equal(importerReceipt.batch_size, 500);
    assert.equal(importerReceipt.username, username);
    indexed = {
      imported_units:
        importerReceipt.inserted + importerReceipt.skipped_existing,
      inserted: importerReceipt.inserted,
      skipped_existing: importerReceipt.skipped_existing,
      batch_size: importerReceipt.batch_size,
      input_jsonl_sha256: prepared.output_sha256,
      parser: 'parser-bypass native Entry ORM; raw equals compiled corpus unit',
      vector_cache: 'read-only public vectors.sqlite',
    };
  }
  const after = await authenticatedProfile(baseUrl(), token, username);
  assert.equal(
    after.has_documents,
    true,
    'Khoj index stage completed without searchable entries',
  );
  const receipt = {
    status: 'indexed',
    kind,
    scope,
    username,
    index_freeze: indexFreeze,
    inputs,
    indexed,
    profile_verified: true,
    token_not_printed: true,
  };
  await fsp.mkdir(path.dirname(receiptPath), { recursive: true });
  await fsp.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      receipt: receiptPath,
      scope,
      documents: inputs.documents,
      indexed,
    }),
  );
  return receipt;
}

async function live() {
  const corpusRoot = path.resolve(option('--corpus-root', defaultCorpusRoot));
  const { manifest, manifestSha256 } = await readManifest(corpusRoot);
  const scope = option('--scope');
  const kind = option('--kind', 'native');
  const username = option(
    '--username',
    process.env.KHOJ_COMPARISON_USERNAME || '',
  );
  const echoRoot = path.resolve(option('--echo-root', defaultEchoRoot));
  assert.ok(
    scope && username,
    '--scope and --username are required for live mode',
  );
  assert.ok(
    ['native', 'fixed'].includes(kind),
    '--kind must be native or fixed',
  );
  assert.ok(
    ['both', 'all', undefined].includes(option('--condition')),
    'Frozen live mode always runs both conditions',
  );
  const frozen = await verifyQueryFreeze(
    manifestSha256,
    manifest,
    scope,
    kind,
    echoRoot,
  );
  const data = await loadScope(corpusRoot, manifest, scope, kind, {
    buildResultMap: true,
  });
  assert.equal(data.documents, frozen.inputs.documents);
  assert.equal(data.questions.length, frozen.inputs.questions);
  await updateScopeUserRegistry(scope, username, false);
  const token = await readToken();
  const profile = await authenticatedProfile(baseUrl(), token, username);
  assert.equal(
    profile.has_documents,
    true,
    'Index this scope before searching it',
  );
  const indexReceiptPath = scopeIndexReceiptPath(scope, kind);
  assert.ok(
    fs.existsSync(indexReceiptPath),
    'Missing completed scope index receipt',
  );
  const indexReceipt = JSON.parse(await fsp.readFile(indexReceiptPath, 'utf8'));
  assert.equal(indexReceipt.status, 'indexed');
  assert.equal(indexReceipt.username, username);
  assert.equal(indexReceipt.scope, scope);
  assert.equal(indexReceipt.kind, kind);
  assert.equal(indexReceipt.inputs.corpus_sha256, frozen.inputs.corpus_sha256);
  const queryIndexReceipt = await verifyQueryIndexReceipt(
    scope,
    frozen.inputs.corpus_sha256,
    indexReceiptPath,
    echoRoot,
  );

  const packProductEvidence =
    kind === 'native' ? await loadPacker(echoRoot) : null;
  const allOutputs = [];
  for (const condition of frozen.conditions) {
    const output = path.join(
      experimentRoot,
      'runs',
      condition.name,
      scope + '.jsonl',
    );
    await fsp.mkdir(path.dirname(output), { recursive: true });
    const handle = await fsp.open(output, 'wx');
    let completed = 0;
    try {
      for (const question of data.questions) {
        const started = performance.now();
        const rankedQueries = [];
        for (const query of question.queries) {
          rankedQueries.push(
            await searchNative(
              baseUrl(),
              token,
              question,
              query,
              data,
              scope,
              condition.rerank,
              kind,
            ),
          );
        }
        const elapsed = performance.now() - started;
        const common = {
          id: question.id,
          scope,
          username,
          condition: {
            name: condition.name,
            rerank: condition.rerank,
            dedupe: false,
            return_limit: 10,
          },
          native_http_return_limit: 10,
          ranked_queries: rankedQueries,
          elapsed_ms: elapsed,
        };
        let row;
        if (kind === 'native') {
          const packed = await packNative(
            packProductEvidence,
            question,
            rankedQueries,
            frozen.packing,
          );
          row = { ...packed, ...common };
        } else {
          row = {
            ...common,
            rankings: fixedRows(question, rankedQueries),
          };
        }
        await handle.write(JSON.stringify(row) + '\n');
        completed++;
        if (completed % 25 === 0)
          console.log(
            JSON.stringify({
              phase: 'search',
              scope,
              condition: condition.name,
              completed,
              total: data.questions.length,
            }),
          );
      }
      assert.equal(
        completed,
        frozen.inputs.questions,
        'Search question denominator changed',
      );
    } finally {
      await handle.close();
    }
    const outputSha = await fileSha256(output);
    await fsp.writeFile(
      path.join(
        experimentRoot,
        'runs',
        condition.name,
        scope + '-receipt.json',
      ),
      JSON.stringify(
        {
          status: 'complete',
          condition: condition.name,
          scope,
          questions: completed,
          freeze_sha256: frozen.sha256,
          index_receipt: queryIndexReceipt,
          result: { path: output, sha256: outputSha },
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    allOutputs.push({
      name: condition.name,
      sha256: outputSha,
      output,
      rows: completed,
      native_http_return_limit: 10,
      dedupe: false,
    });
  }
  const receipt = {
    status: 'complete',
    mode: 'live',
    kind,
    scope,
    username,
    freeze: { path: frozen.path, sha256: frozen.sha256 },
    query_index_receipt: {
      path: queryIndexReceipt.path,
      sha256: queryIndexReceipt.sha256,
    },
    index_receipt: {
      path: indexReceiptPath,
      sha256: await fileSha256(indexReceiptPath),
    },
    inputs: frozen.inputs,
    conditions: allOutputs,
    dedicated_user_verified: true,
    token_not_printed: true,
    golden_labels_read: false,
    native_http_return_limit: 10,
    qasper_filter_before_top10: scope === 'qasper',
    embedding_calls_by_runner: false,
  };
  const receiptPath = path.resolve(
    option(
      '--receipt',
      path.join(runtimeRoot, 'results', `search-${scope}-receipt.json`),
    ),
  );
  await fsp.mkdir(path.dirname(receiptPath), { recursive: true });
  await fsp.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(JSON.stringify({ receiptPath, outputs: allOutputs }));
  return receipt;
}

async function main() {
  if (hasFlag('--help')) {
    usage();
    return;
  }
  const mode = option('--mode', 'plan');
  if (mode === 'smoke') {
    const output = await offlineSmoke();
    const target = path.resolve(
      option(
        '--output',
        path.join(runtimeRoot, 'results', 'adapter-contract-smoke.json'),
      ),
    );
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, JSON.stringify(output, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log(
      JSON.stringify({ smoke_receipt: target, network_forbidden: true }),
    );
  } else if (mode === 'prepare-fixed') {
    const corpusRoot = path.resolve(option('--corpus-root', defaultCorpusRoot));
    const { manifest, manifestSha256 } = await readManifest(corpusRoot);
    const scope = option('--scope');
    assert.ok(scope, '--scope is required');
    const data = await loadScope(corpusRoot, manifest, scope, 'fixed', {
      loadQuestions: false,
      buildResultMap: false,
    });
    const inputs = await verifyInputBindings(
      manifest,
      manifestSha256,
      scope,
      'fixed',
    );
    const output = await prepareFixed(data, scope);
    const receiptPath = path.join(
      runtimeRoot,
      'results',
      'fixed-' + scope + '-prepare-receipt.json',
    );
    await fsp.writeFile(
      receiptPath,
      JSON.stringify(
        {
          ...output,
          inputs,
          corpus_file: data.corpusFile,
          vector_cache: 'public vectors.sqlite read-only',
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    console.log(JSON.stringify(output));
  } else if (mode === 'create-user') {
    await createScopeUser();
  } else if (mode === 'index') {
    await index();
  } else if (mode === 'live') {
    await live();
  } else if (mode === 'plan') {
    await plan();
  } else {
    throw new Error('Unknown --mode ' + mode);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
