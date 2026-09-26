import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { supplementCli } from './lib/supplement-cli.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  mapQmdSnippet,
  packQmdParentEvidence,
} from './lib/qmd-parent-evidence.mjs';
import {
  packProductEvidence,
  sourceLineSpans,
  spansCover,
} from './lib/product-evidence.mjs';
import {
  fittedLineCount,
  readStart,
  selectFirstFiles,
  supplementPolicy,
} from './lib/supplement-budget.mjs';

// This program reads saved first responses. The only MCP tool it can invoke is get.
const { action, condition, comparisonRoot, qmdRoot, experimentRoot } =
  supplementCli('run');
const scopes = ['A-test', 'B-test', 'C-test', 'D-test', 'mixed-test'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const readRows = async (file) =>
  (await fs.readFile(file, 'utf8'))
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
const fileHash = async (file) => sha(await fs.readFile(file));
const inputHashes = {};
async function pinned(file, expected) {
  const actual = await fileHash(file);
  assert.equal(actual, expected, `Input SHA mismatch: ${file}`);
  inputHashes[file] = actual;
}
const manifestFile = path.join(comparisonRoot, 'corpus-v1/manifest.json');
const preparation = await readJson(
  path.join(qmdRoot, 'private-preparation.json'),
);
await pinned(manifestFile, preparation.corpus_manifest_sha256);
assert.equal(
  preparation.corpus_manifest_sha256,
  '478ef81433e860a80b59d30fa2dc65c09b7216c811cce83c6b003f27e6d3ec4b',
);
const manifest = await readJson(manifestFile);
const productFreeze = await readJson(path.join(comparisonRoot, 'freeze.json'));
await pinned(
  path.join(comparisonRoot, 'freeze.json'),
  '6c76d17f0bb1b82c878ac15d9d5f0180bda4870486b7599bef84f4ed6b0267ea',
);
const indexFreezeFile = path.join(comparisonRoot, 'index-freeze.json');
await pinned(
  indexFreezeFile,
  '33c25117167584a92c5e997c907d24bd89424d27052e43aad110ce867dbd3814',
);
const qmdDownload = await readJson(
  path.join(qmdRoot, 'download-manifest.json'),
);
assert.equal(qmdDownload.version, '2.8.3');
const sourceKey = (collection, relative) =>
  JSON.stringify([collection, relative]);
const result = { echo: [], rrf: [], rerank: [] };
const corpus = new Map();
let copyCount = 0;

function score(question, labels, pieces, byPath) {
  if (question.no_answer)
    return {
      no_answer: true,
      complete: false,
      covered: 0,
      expected: 0,
      facts: [],
    };
  const factById = new Map(labels.facts.map((fact) => [fact.id, fact]));
  const facts = question.required_facts.filter((factId) =>
    factById.get(factId).evidence.some((anchor) => {
      const source = byPath.get(sourceKey(anchor.collection_id, anchor.path));
      assert.ok(source, `Gold source missing: ${anchor.path}`);
      const spans = pieces
        .filter((piece) => piece.source_id === source.id)
        .flatMap((piece) => piece.spans);
      return sourceLineSpans(source, anchor.start_line, anchor.end_line).every(
        ([a, b]) => spansCover(spans, a, b),
      );
    }),
  );
  return {
    no_answer: false,
    complete: facts.length === question.required_facts.length,
    covered: facts.length,
    expected: question.required_facts.length,
    facts,
  };
}

for (const scope of scopes) {
  const info = manifest.scopes[scope];
  const prepared = preparation.scopes.find((item) => item.scope === scope);
  assert.ok(prepared);
  for (const [item, expected] of [
    [info.corpus, prepared.corpus_sha256],
    [info.queries, prepared.queries_sha256],
    [info.labels, prepared.labels_sha256],
  ]) {
    assert.equal(item.sha256, expected);
    await pinned(item.path, expected);
  }
  const sources = await readRows(info.corpus.path);
  const questions = await readRows(info.queries.path);
  const labels = await readJson(info.labels.path);
  assert.equal(sources.length, prepared.documents);
  assert.equal(questions.length, prepared.questions);
  const byId = new Map(sources.map((source) => [source.id, source]));
  const byPath = new Map(
    sources.map((source) => [
      sourceKey(source.collection_id, source.relative_path),
      source,
    ]),
  );
  const labelsById = new Map(
    labels.questions.map((label) => [label.id, label]),
  );
  const preparedBySource = new Map(
    prepared.files.map((file) => [file.source_id, file]),
  );
  for (const source of sources) {
    const copy = preparedBySource.get(source.id);
    assert.ok(copy);
    assert.equal(copy.text_sha256, source.text_sha256);
    assert.equal(sha(source.text), source.text_sha256);
    const file = path.join(
      qmdRoot,
      'private-data',
      scope,
      copy.qmd_relative_path,
    );
    const raw = await fs.readFile(file, 'utf8');
    assert.ok(
      raw === source.text || raw === source.text + '\n',
      `QMD copy differs: ${file}`,
    );
    copyCount++;
  }
  corpus.set(scope, {
    sources,
    questions,
    labels,
    byId,
    byPath,
    labelsById,
    preparedBySource,
  });

  for (const mode of ['echo', 'rrf', 'rerank']) {
    const isEcho = mode === 'echo';
    const runDir = path.join(
      isEcho ? comparisonRoot : qmdRoot,
      isEcho ? 'runs/echo' : `runs-mcp/${mode}`,
    );
    const runFile = path.join(runDir, `${scope}.jsonl`);
    const receipt = await readJson(
      path.join(
        runDir,
        isEcho ? `${scope}-receipt.json` : `${scope}.receipt.json`,
      ),
    );
    const rows = await readRows(runFile);
    await pinned(
      runFile,
      isEcho ? receipt.result.sha256 : receipt.result_sha256,
    );
    assert.equal(receipt.status, 'complete');
    assert.equal(receipt.questions, questions.length);
    assert.deepEqual(
      rows.map((row) => row.id),
      questions.map((row) => row.id),
    );
    if (isEcho) {
      assert.equal(
        receipt.freeze_sha256,
        inputHashes[path.join(comparisonRoot, 'freeze.json')],
      );
    } else {
      const freeze = await readJson(path.join(runDir, `${scope}.freeze.json`));
      assert.equal(freeze.corpus_sha256, info.corpus.sha256);
      assert.equal(freeze.queries_sha256, info.queries.sha256);
      assert.equal(freeze.labels_sha256, info.labels.sha256);
      assert.equal(freeze.qmd_version, '2.8.3');
      assert.equal(freeze.retrieval.one_mcp_call_per_parent, true);
      assert.equal(freeze.retrieval.rerank, mode === 'rerank');
      await pinned(
        path.join(
          qmdRoot,
          'config',
          `qmd-${scope === 'mixed-test' ? 'mixed' : scope[0].toLowerCase()}.yml`,
        ),
        freeze.config_sha256,
      );
      assert.equal(
        receipt.native_errors,
        rows.filter((row) => row.native_error).length,
      );
      assert.deepEqual(
        receipt.latency_ms,
        rows.map((row) => row.latency_ms),
      );
      assert.deepEqual(freeze.packing, {
        topk: 10,
        source_cap: 6,
        max_context_chars: 20000,
      });
      inputHashes[path.join(runDir, `${scope}.freeze.json`)] = await fileHash(
        path.join(runDir, `${scope}.freeze.json`),
      );
    }
    for (let index = 0; index < questions.length; index++) {
      const row = rows[index];
      const question = questions[index];
      const label = labelsById.get(question.id);
      assert.ok(label);
      const packed = isEcho
        ? packProductEvidence(
            question,
            row.ranked_queries,
            productFreeze.packing,
          )
        : packQmdParentEvidence(question, row.candidates, {
            topk: 10,
            source_cap: 6,
            max_context_chars: 20000,
          });
      assert.deepEqual(row.response, packed.response);
      assert.deepEqual(row.selection_trace, packed.selection_trace);
      assert.equal(row.request_chars, packed.request_chars);
      assert.equal(row.response_chars, packed.response_chars);
      assert.ok(row.request_chars + row.response_chars <= 20000);
      const pieces = row.response.results.map((item) => {
        const source = byId.get(item.source_id);
        assert.ok(source);
        let spans;
        if (isEcho) {
          const candidate = row.ranked_queries
            .flatMap((ranked) => ranked.results)
            .find((candidate) => candidate.id === item.id);
          assert.ok(candidate);
          assert.equal(
            source.text
              .split('\n')
              .slice(
                candidate.source_location.start_line -
                  source.original_first_line,
                candidate.source_location.end_line -
                  source.original_first_line +
                  1,
              )
              .join('\n'),
            item.text,
          );
          spans = sourceLineSpans(
            source,
            candidate.source_location.start_line,
            candidate.source_location.end_line,
          );
        } else {
          const candidate = row.candidates.find(
            (candidate) => candidate.id === item.id,
          );
          assert.ok(candidate);
          const mapped = mapQmdSnippet(candidate.text, source);
          assert.equal(mapped.status, 'mapped');
          assert.deepEqual(candidate.spans, mapped.spans);
          spans = mapped.spans;
        }
        return { source_id: source.id, spans };
      });
      result[mode].push({
        scope,
        question,
        label,
        labels,
        row,
        firstPieces: pieces,
        first: score(label, labels, pieces, byPath),
        byId,
        byPath,
        preparedBySource,
      });
    }
  }
}

const expectedBaseline = {
  echo: [190, 393, 0],
  rrf: [4, 19, 3],
  rerank: [4, 20, 3],
};
const baseline = {};
for (const [mode, rows] of Object.entries(result)) {
  assert.equal(rows.length, 200);
  const answerable = rows.filter((item) => !item.first.no_answer);
  assert.equal(answerable.length, 196);
  const totals = [
    answerable.filter((item) => item.first.complete).length,
    answerable.reduce((sum, item) => sum + item.first.covered, 0),
    rows.filter((item) => item.row.native_error).length,
  ];
  assert.deepEqual(
    totals,
    expectedBaseline[mode],
    `Saved ${mode} first-result baseline differs`,
  );
  baseline[mode] = {
    complete: totals[0],
    facts: totals[1],
    native_errors: totals[2],
    questions: 200,
    answerable: 196,
    expected_facts: answerable.reduce(
      (sum, item) => sum + item.first.expected,
      0,
    ),
  };
  assert.equal(baseline[mode].expected_facts, 403);
}
const verification = {
  status: 'verified',
  baseline,
  qmd_copies_matching_frozen_source: copyCount,
  corpus_manifest_sha256: preparation.corpus_manifest_sha256,
  input_sha256: inputHashes,
  script_sha256: await fileHash(fileURLToPath(import.meta.url)),
  cli_sha256: await fileHash(
    new URL('./lib/supplement-cli.mjs', import.meta.url),
  ),
  policy_sha256: await fileHash(
    new URL('./lib/supplement-budget.mjs', import.meta.url),
  ),
};
await fs.mkdir(experimentRoot, { recursive: true });
const verificationFile = path.join(experimentRoot, 'verification.json');
try {
  assert.deepEqual(await readJson(verificationFile), verification);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await fs.writeFile(
    verificationFile,
    JSON.stringify(verification, null, 2) + '\n',
    { flag: 'wx' },
  );
}
if (action === 'verify') {
  console.log(
    JSON.stringify({
      baseline,
      qmd_copies_matching_frozen_source: copyCount,
      verification_file: verificationFile,
    }),
  );
  process.exit(0);
}

async function connectQmd(scope) {
  const indexName =
    'qmd-' + (scope === 'mixed-test' ? 'mixed' : scope[0].toLowerCase());
  process.env.XDG_CACHE_HOME = path.join(qmdRoot, 'cache');
  process.env.QMD_CONFIG_DIR = path.join(qmdRoot, 'config');
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
  const client = new Client({
    name: 'echo-qmd-supplement-readonly',
    version: '1.0.0',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(qmdRoot, 'app/node_modules/@tobilu/qmd/bin/qmd'),
      '--index',
      indexName,
      'mcp',
    ],
    env: { ...process.env },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'get'));
  assert.equal(client.getServerVersion()?.version, '2.8.3');
  return client;
}

function sourceSpans(source, first, count) {
  const start = source.original_first_line + first - 1;
  return sourceLineSpans(source, start, start + count - 1);
}

async function readOne(item, mode, client) {
  const { scope, question, row, byId, preparedBySource } = item;
  const selected = selectFirstFiles(row.response.results);
  const reads = [];
  let used = row.request_chars + row.response_chars;
  for (const hit of selected) {
    const source = byId.get(hit.source_id);
    const lines = source.text.split('\n');
    const candidate =
      mode === 'echo'
        ? row.ranked_queries
            .flatMap((ranked) => ranked.results)
            .find((piece) => piece.id === hit.id)
        : row.candidates.find((piece) => piece.id === hit.id);
    assert.ok(candidate);
    const native =
      mode === 'echo'
        ? null
        : row.native_results.find(
            (piece) => piece.docid === candidate.native_id,
          );
    if (mode !== 'echo') assert.ok(native);
    const hitLine =
      mode === 'echo'
        ? candidate.source_location.start_line - source.original_first_line + 1
        : native.line;
    const start = readStart(hitLine);
    const copy = preparedBySource.get(source.id);
    const file =
      mode === 'echo'
        ? path.join(qmdRoot, 'private-data', scope, copy.qmd_relative_path)
        : native.file;
    const requestFor = (maxLines) =>
      mode === 'echo'
        ? { path: file, fromLine: start, maxLines }
        : { file, fromLine: start, maxLines, lineNumbers: false };
    const responseFor = (text) => ({ path: source.relative_path, text });
    const count = fittedLineCount({
      lines,
      start,
      maxLines: supplementPolicy.maxLines,
      used,
      requestFor,
      responseFor,
      safety: mode === 'echo' ? 0 : supplementPolicy.qmdSafetyChars,
    });
    if (!count) {
      reads.push({
        status: 'budget_excluded',
        source_id: source.id,
        path: source.relative_path,
        hit_line: hitLine,
        used_before: used,
      });
      continue;
    }
    const request = requestFor(count);
    const expected = lines.slice(start - 1, start - 1 + count).join('\n');
    const started = performance.now();
    let nativeResponse;
    let actual;
    if (mode === 'echo') {
      const raw = await fs.readFile(file, 'utf8');
      assert.ok(raw === source.text || raw === source.text + '\n');
      actual = raw
        .split('\n')
        .slice(start - 1, start - 1 + count)
        .join('\n');
      nativeResponse = { host_read_path: file, text: actual };
    } else {
      nativeResponse = await client.callTool({
        name: 'get',
        arguments: request,
      });
      assert.equal(
        nativeResponse.isError,
        undefined,
        `QMD get failed: ${file}`,
      );
      const resources = nativeResponse.content.filter(
        (part) => part.type === 'resource',
      );
      assert.equal(
        resources.length,
        1,
        `QMD get did not return one resource: ${file}`,
      );
      actual = resources[0].resource.text;
      if (actual !== expected) {
        // QMD may add a context comment; only the exact returned suffix maps to source lines.
        assert.ok(
          actual.endsWith(expected),
          `QMD get body differs from frozen source: ${file}`,
        );
      }
    }
    const latencyMs = performance.now() - started;
    assert.equal(actual.endsWith(expected), true);
    const response = responseFor(actual);
    const cost =
      JSON.stringify(request).length + JSON.stringify(response).length;
    const usedBefore = used;
    used += cost;
    reads.push({
      status: used <= supplementPolicy.budgetChars ? 'read' : 'over_budget',
      source_id: source.id,
      path: source.relative_path,
      hit_line: hitLine,
      from_line: start,
      max_lines: count,
      request,
      native_response: nativeResponse,
      normalized_response: response,
      request_chars: JSON.stringify(request).length,
      response_chars: JSON.stringify(response).length,
      used_before: usedBefore,
      used_after: used,
      latency_ms: latencyMs,
      spans: sourceSpans(source, start, count),
    });
  }
  const afterPieces = [
    ...item.firstPieces,
    ...reads
      .filter((read) => read.status === 'read')
      .map((read) => ({ source_id: read.source_id, spans: read.spans })),
  ];
  const after = score(item.label, item.labels, afterPieces, item.byPath);
  return {
    id: question.id,
    scope,
    mode,
    native_error: row.native_error ?? null,
    no_answer: item.label.no_answer,
    first: item.first,
    after,
    first_context_chars: row.request_chars + row.response_chars,
    cumulative_context_chars: used,
    over_budget: reads.some((read) => read.status === 'over_budget'),
    reads,
    retrieval_calls_added: 0,
    embedding_calls_added: 0,
    rerank_calls_added: 0,
  };
}

if (action === 'run') {
  for (const scope of scopes) {
    const target = path.join(experimentRoot, `${condition}-${scope}.jsonl`);
    const items = result[condition].filter((item) => item.scope === scope);
    const prior = await readRows(target).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(
      prior.map((item) => item.id),
      items.slice(0, prior.length).map((item) => item.question.id),
    );
    let client;
    if (condition !== 'echo' && prior.length < items.length)
      client = await connectQmd(scope);
    try {
      const handle = await fs.open(target, 'a');
      try {
        for (let index = prior.length; index < items.length; index++) {
          const record = await readOne(items[index], condition, client);
          await handle.write(JSON.stringify(record) + '\n');
          await handle.sync();
          if ((index + 1) % 10 === 0)
            console.log(`${condition} ${scope}: ${index + 1}/${items.length}`);
        }
      } finally {
        await handle.close();
      }
    } finally {
      if (client) await client.close();
    }
  }
  console.log(`${condition}: all 200 saved questions supplemented`);
}

if (action === 'summarize') {
  const summary = {
    schema: 'echo-qmd-supplement-v1',
    status: 'complete',
    baseline_verified: baseline,
    conditions: {},
    verification_sha256: await fileHash(verificationFile),
  };
  for (const mode of ['echo', 'rrf', 'rerank']) {
    const rows = (
      await Promise.all(
        scopes.map((scope) =>
          readRows(path.join(experimentRoot, `${mode}-${scope}.jsonl`)),
        ),
      )
    ).flat();
    assert.equal(rows.length, 200);
    assert.deepEqual(
      rows.map((row) => row.id),
      result[mode].map((item) => item.question.id),
    );
    const agg = (list) => ({
      questions: list.length,
      answerable: list.filter((row) => !row.no_answer).length,
      first_complete: list.filter((row) => !row.no_answer && row.first.complete)
        .length,
      after_complete: list.filter((row) => !row.no_answer && row.after.complete)
        .length,
      first_facts: list.reduce((sum, row) => sum + row.first.covered, 0),
      after_facts: list.reduce((sum, row) => sum + row.after.covered, 0),
      expected_facts: list.reduce((sum, row) => sum + row.first.expected, 0),
      no_answer_nonempty: list.filter(
        (row) =>
          row.no_answer &&
          result[mode].find((item) => item.question.id === row.id).row.response
            .results.length > 0,
      ).length,
      native_errors: list.filter((row) => row.native_error).length,
      budget_excluded_reads: list
        .flatMap((row) => row.reads)
        .filter((read) => read.status === 'budget_excluded').length,
      over_budget_questions: list.filter((row) => row.over_budget).length,
      supplement_calls: list
        .flatMap((row) => row.reads)
        .filter((read) => ['read', 'over_budget'].includes(read.status)).length,
      supplement_request_chars: list
        .flatMap((row) => row.reads)
        .reduce((sum, read) => sum + (read.request_chars ?? 0), 0),
      supplement_response_chars: list
        .flatMap((row) => row.reads)
        .reduce((sum, read) => sum + (read.response_chars ?? 0), 0),
      supplement_latency_ms: list
        .flatMap((row) => row.reads)
        .reduce((sum, read) => sum + (read.latency_ms ?? 0), 0),
      mean_cumulative_context_chars:
        list.reduce((sum, row) => sum + row.cumulative_context_chars, 0) /
        list.length,
    });
    summary.conditions[mode] = {
      ...agg(rows),
      scopes: Object.fromEntries(
        scopes.map((scope) => [
          scope,
          agg(rows.filter((row) => row.scope === scope)),
        ]),
      ),
      raw_sha256: Object.fromEntries(
        await Promise.all(
          scopes.map(async (scope) => [
            scope,
            await fileHash(path.join(experimentRoot, `${mode}-${scope}.jsonl`)),
          ]),
        ),
      ),
    };
  }
  assert.equal(summary.conditions.echo.first_complete, 190);
  assert.equal(summary.conditions.rrf.first_complete, 4);
  assert.equal(summary.conditions.rerank.first_complete, 4);
  const target = path.join(experimentRoot, 'summary.json');
  await fs.writeFile(target, JSON.stringify(summary, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(JSON.stringify(summary.conditions));
}
