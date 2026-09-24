import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSha256, verifyExecutionFiles } from './product-freeze.mjs';
import { validateIndexReceipt } from './product-index-receipt.mjs';

const hashText = (value) =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const jsonHash = (value) => hashText(JSON.stringify(value));

function requireThat(value, message) {
  if (!value) throw new Error('Product run integrity: ' + message);
}

function same(actual, expected, message) {
  if (actual !== expected) throw new Error('Product run integrity: ' + message);
}

function resolved(root, value) {
  requireThat(
    typeof value === 'string' && value.length > 0,
    'missing bound path',
  );
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(root, value);
}

function pathKey(file) {
  return path.resolve(file).replaceAll('\\', '/').toLowerCase();
}

export function requiredProductRunExecutionFiles(condition) {
  const moduleFile = fileURLToPath(import.meta.url);
  const libDirectory = path.dirname(moduleFile);
  const evalsDirectory = path.resolve(libDirectory, '..');
  const repository = path.resolve(evalsDirectory, '..');
  const common = [
    moduleFile,
    path.join(evalsDirectory, 'verify-product-run.mjs'),
    path.join(evalsDirectory, 'score-product-evidence.mjs'),
    path.join(evalsDirectory, 'score-product-public.py'),
    path.join(evalsDirectory, 'lib/product-freeze.mjs'),
    path.join(evalsDirectory, 'lib/product-model-provenance.mjs'),
    path.join(evalsDirectory, 'audit-product-model-provenance.mjs'),
    path.join(evalsDirectory, 'lib/product-index-receipt.mjs'),
    path.join(evalsDirectory, 'lib/product-evidence.mjs'),
    path.join(evalsDirectory, 'lib/dify-evidence.mjs'),
    path.join(evalsDirectory, 'lib/khoj-evidence.mjs'),
    path.join(repository, 'package.json'),
    path.join(repository, 'package-lock.json'),
  ];
  const runners = {
    echo: [
      'run-product-echo.mjs',
      'run-minisearch-parameter-exploration.mjs',
      'prepare-product-comparison.mjs',
      'lib/product-private-vectors.mjs',
      'lib/public-runtime.mjs',
      '../dist/database.js',
      '../dist/embedding.js',
      '../dist/minisearch.js',
      '../dist/retrieval.js',
      '../dist/config.js',
      '../dist/lexical.js',
    ],
    dify: [
      'product-dify-query.mjs',
      'lib/dify-auth.mjs',
      'lib/product-jsonl.mjs',
      'lib/product-dify-fixed-state.mjs',
      'lib/product-index-intent.mjs',
    ],
    'khoj-dense': [
      'product-khoj-replay.mjs',
      'lib/product-vector-cache.mjs',
      'lib/product-embedding-queue.mjs',
      'lib/product-evidence.mjs',
      'import-product-khoj-fixed.py',
    ],
    'khoj-rerank': [
      'product-khoj-replay.mjs',
      'lib/product-vector-cache.mjs',
      'lib/product-embedding-queue.mjs',
      'lib/product-evidence.mjs',
      'import-product-khoj-fixed.py',
    ],
  };
  const files = runners[condition];
  requireThat(files, 'unsupported product condition for code freeze');
  return [
    ...new Set([
      ...common,
      ...files.map((file) => path.resolve(evalsDirectory, file)),
    ]),
  ];
}

async function readJson(file, label) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new Error('Product run integrity: cannot read ' + label);
  }
}

async function readJsonl(file, label) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error('Product run integrity: cannot read ' + label);
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error('Product run integrity: malformed ' + label);
    }
  }
  return rows;
}

async function sha256(file, label) {
  try {
    return await fileSha256(file);
  } catch {
    throw new Error('Product run integrity: cannot hash ' + label);
  }
}

async function verifyFileHash(file, expected, label) {
  requireThat(
    /^[a-f0-9]{64}$/i.test(String(expected ?? '')),
    label + ' has no SHA-256',
  );
  same(
    (await sha256(file, label)).toLowerCase(),
    String(expected).toLowerCase(),
    label + ' SHA-256 changed',
  );
}

function rowId(row) {
  return String(row?.id ?? row?._id ?? row?.source_id ?? row?.unit_id ?? '');
}

function queryId(query) {
  return String(query?.id ?? query?.query_id ?? '');
}

function modelFingerprint(freeze) {
  const fingerprint = freeze?.model?.fingerprint;
  requireThat(
    typeof fingerprint === 'string' && fingerprint.length > 0,
    'global model fingerprint is missing',
  );
  return fingerprint;
}

function expectedQuestionCount(info) {
  const count = Number(info?.questions ?? info?.parent_questions);
  requireThat(
    Number.isInteger(count) && count > 0,
    'scope question count is missing',
  );
  return count;
}

function corpusText(row) {
  return typeof row?.text === 'string'
    ? row.text
    : typeof row?.content === 'string'
      ? row.content
      : null;
}

async function loadFrozenScope(root, scope, info, condition) {
  for (const key of ['corpus', 'queries']) {
    const binding = info?.[key];
    requireThat(
      binding?.path && binding?.sha256,
      scope + ' manifest omits ' + key + ' binding',
    );
    await verifyFileHash(
      resolved(root, binding.path),
      binding.sha256,
      scope + ' ' + key,
    );
  }
  const questions = await readJsonl(
    resolved(root, info.queries.path),
    scope + ' frozen questions',
  );
  const corpusRows = await readJsonl(
    resolved(root, info.corpus.path),
    scope + ' frozen corpus',
  );
  same(
    questions.length,
    expectedQuestionCount(info),
    scope + ' frozen question count changed',
  );
  // Official fixed-unit datasets store one question as {id, text}; the
  // product adapters assign their own bookkeeping ID to that single query.
  if (info.kind === 'official-fixed-unit') {
    for (const question of questions) {
      if (question.queries === undefined && typeof question.text === 'string') {
        question.queries = [
          {
            id: condition === 'dify' ? 'q0' : rowId(question),
            text: condition?.startsWith('khoj-')
              ? question.text.trim()
              : question.text,
          },
        ];
      }
    }
  }
  const ids = new Set();
  for (const question of questions) {
    const id = rowId(question);
    requireThat(id, scope + ' frozen question has no id');
    requireThat(!ids.has(id), scope + ' frozen questions repeat an id');
    ids.add(id);
    requireThat(
      Array.isArray(question.queries) && question.queries.length > 0,
      scope + ' question has no frozen subqueries',
    );
    for (const query of question.queries) {
      requireThat(queryId(query), scope + ' frozen subquery has no id');
      requireThat(
        typeof query.text === 'string',
        scope + ' frozen subquery has no text',
      );
    }
  }
  const docsById = new Map();
  const docsByPath = new Map();
  for (const row of corpusRows) {
    const id = rowId(row);
    const text = corpusText(row);
    requireThat(
      id && text !== null,
      scope + ' frozen corpus row is incomplete',
    );
    requireThat(!docsById.has(id), scope + ' frozen corpus repeats an id');
    docsById.set(id, row);
    if (typeof row.relative_path === 'string')
      docsByPath.set(row.relative_path, row);
  }
  return { questions, corpusRows, docsById, docsByPath };
}

function resultFileFromReceipt(root, condition, scope, receipt, dify) {
  const expected = path.join(root, 'runs', condition, scope + '.jsonl');
  const pathValue = dify ? receipt.output_file : receipt.result?.path;
  const output = resolved(root, pathValue);
  same(
    pathKey(output),
    pathKey(expected),
    scope + ' receipt points at a different result file',
  );
  return output;
}

function checkOutputRows(scope, questions, outputRows) {
  same(
    outputRows.length,
    questions.length,
    scope + ' result row count differs from frozen questions',
  );
  for (let index = 0; index < questions.length; index++) {
    const expectedId = rowId(questions[index]);
    same(
      rowId(outputRows[index]),
      expectedId,
      scope + ' result order/id differs from frozen questions',
    );
    if (outputRows[index].scope !== undefined)
      same(
        String(outputRows[index].scope),
        scope,
        scope + ' result scope changed',
      );
  }
}

function rankedQueryRows(scope, question, outputRow) {
  requireThat(
    Array.isArray(outputRow.ranked_queries),
    scope + ' result lacks ranked subqueries',
  );
  same(
    outputRow.ranked_queries.length,
    question.queries.length,
    scope + ' ranked subquery count changed',
  );
  for (let index = 0; index < question.queries.length; index++) {
    same(
      String(outputRow.ranked_queries[index]?.query_id ?? ''),
      queryId(question.queries[index]),
      scope + ' ranked subquery order/id changed',
    );
    requireThat(
      Array.isArray(outputRow.ranked_queries[index].results),
      scope + ' ranked subquery has no result list',
    );
  }
  return outputRow.ranked_queries;
}

function compareCandidateFields(actual, expected, fields, message) {
  for (const field of fields)
    same(actual?.[field], expected[field], message + ' ' + field + ' mismatch');
}

async function verifyEchoFixed(
  root,
  scope,
  info,
  freeze,
  questions,
  outputRows,
) {
  const referenceValue = freeze.echo?.fixed_reference;
  const fileBinding = freeze.echo?.fixed_files?.[scope];
  requireThat(
    referenceValue && fileBinding?.sha256,
    'Echo fixed-unit old-source freeze is missing',
  );
  const reference = resolved(root, referenceValue);
  const referenceFreezeBinding = freeze.echo?.fixed_reference_freeze;
  requireThat(
    referenceFreezeBinding?.path && referenceFreezeBinding?.sha256,
    'Echo fixed reference freeze path/SHA is missing',
  );
  const referenceFreezeFile = resolved(root, referenceFreezeBinding.path);
  same(
    pathKey(referenceFreezeFile),
    pathKey(path.join(reference, 'freeze.json')),
    'Echo fixed reference freeze path differs from its reference root',
  );
  await verifyFileHash(
    referenceFreezeFile,
    referenceFreezeBinding.sha256,
    'Echo preserved freeze',
  );
  const oldFreeze = await readJson(
    referenceFreezeFile,
    'Echo preserved freeze',
  );
  requireThat(
    oldFreeze.status === 'frozen',
    'Echo preserved freeze is not frozen',
  );
  const arm = oldFreeze.arms?.['public-A'];
  const expectedRetrieval = freeze.conditions?.echo?.retrieval;
  requireThat(
    arm && expectedRetrieval,
    'Echo fixed public-A arm binding is missing',
  );
  same(arm.id, 'public-A', 'Echo preserved fixed arm id changed');
  for (const key of [
    'minisearch_k',
    'minisearch_b',
    'minisearch_d',
    'bm25_weight',
    'dense_weight',
    'rrf_k',
  ])
    same(
      arm[key],
      expectedRetrieval[key],
      'Echo preserved public-A arm differs from the current frozen arm',
    );
  same(
    arm.retrieval?.max_chunks_per_source,
    expectedRetrieval.max_chunks_per_source,
    'Echo preserved arm source cap differs',
  );
  same(
    arm.retrieval?.max_context_chars,
    freeze.packing?.max_context_chars,
    'Echo preserved arm context budget differs',
  );
  same(
    freeze.conditions.echo.fixed_return_limit,
    120,
    'Echo fixed return limit changed',
  );
  same(
    freeze.packing?.topk,
    expectedRetrieval.topk,
    'Echo top-k differs from the frozen retrieval arm',
  );
  same(
    freeze.packing?.source_cap,
    expectedRetrieval.max_chunks_per_source,
    'Echo source cap differs from the frozen retrieval arm',
  );
  same(
    expectedRetrieval.max_context_chars,
    freeze.packing?.max_context_chars,
    'Echo retrieval budget differs from the frozen packer',
  );
  for (const key of [
    'bm25_candidates',
    'dense_candidates',
    'title_weight',
    'min_dense_similarity',
    'topk',
    'max_chunks_per_source',
  ])
    same(
      oldFreeze.fixed?.[key],
      expectedRetrieval[key],
      'Echo preserved fixed settings differ from current retrieval settings',
    );
  same(
    oldFreeze.fixed?.max_context_chars_utf16,
    freeze.packing.max_context_chars,
    'Echo preserved context budget differs',
  );
  same(
    oldFreeze.fixed?.model,
    freeze.model?.name,
    'Echo preserved model differs',
  );
  same(
    oldFreeze.fixed?.dimensions,
    freeze.model?.dimensions,
    'Echo preserved model dimensions differ',
  );
  same(
    oldFreeze.fixed?.lexical_engine,
    'MiniSearch 7.2.0; query-term coverage multiplier disabled',
    'Echo preserved lexical mode changed',
  );
  same(
    oldFreeze.fixed?.tokenizer,
    'ICU zh-CN with existing expansion chain',
    'Echo preserved tokenizer changed',
  );
  same(oldFreeze.fixed?.rerank, false, 'Echo preserved rerank setting changed');
  same(oldFreeze.fixed?.mmr, false, 'Echo preserved MMR setting changed');
  requireThat(
    freeze.echo?.embedding_plan?.sha256 && freeze.echo?.vector_cache?.sha256,
    'Echo current model cache bindings are missing',
  );
  same(
    oldFreeze.public?.vectors?.plan_sha256,
    freeze.echo.embedding_plan.sha256,
    'Echo preserved embedding plan differs',
  );
  same(
    oldFreeze.public?.vectors?.cache_sha256,
    freeze.echo.vector_cache.sha256,
    'Echo preserved vector cache differs',
  );
  const cohort = oldFreeze.public?.source_freeze?.cohorts?.[scope];
  requireThat(cohort, 'Echo preserved freeze has no matching fixed scope');
  for (const key of ['source_corpus', 'source_queries']) {
    const binding = info[key];
    requireThat(
      binding?.path && binding?.sha256,
      'Echo fixed scope lacks its frozen ' + key,
    );
    await verifyFileHash(
      resolved(root, binding.path),
      binding.sha256,
      'Echo fixed ' + key,
    );
  }
  same(
    cohort.corpus_file_sha256,
    info.source_corpus.sha256,
    'Echo preserved corpus freeze differs',
  );
  same(
    cohort.query_file_sha256,
    info.source_queries.sha256,
    'Echo preserved query freeze differs',
  );
  const oldResultsFile = path.join(
    reference,
    'public',
    scope + '-public-A-hybrid.jsonl',
  );
  await verifyFileHash(
    oldResultsFile,
    fileBinding.sha256,
    'Echo preserved fixed result',
  );
  const oldRows = await readJsonl(
    oldResultsFile,
    'Echo preserved fixed result',
  );
  same(
    oldRows.length,
    questions.length,
    'Echo preserved fixed result count differs',
  );
  const fixedReturnLimit = freeze.conditions.echo.fixed_return_limit;
  requireThat(
    Number.isInteger(fixedReturnLimit) && fixedReturnLimit > 0,
    'Echo fixed return limit is invalid',
  );
  same(
    outputRows.length,
    oldRows.length,
    'Echo fixed replay row count differs',
  );
  for (let index = 0; index < oldRows.length; index++) {
    const source = oldRows[index];
    const replay = outputRows[index];
    same(
      rowId(source),
      rowId(questions[index]),
      'Echo preserved fixed result id differs from frozen questions',
    );
    same(
      rowId(replay),
      rowId(source),
      'Echo fixed replay id differs from preserved result',
    );
    same(
      source.condition,
      'public-A-hybrid',
      'Echo preserved fixed source condition changed',
    );
    same(
      questions[index].queries.length,
      1,
      'Echo fixed scope must contain one frozen query per question',
    );
    same(source.rrf_k, 10, 'Echo preserved fixed source RRF setting changed');
    same(
      replay.provenance?.reused,
      true,
      'Echo fixed replay is not marked as reused',
    );
    same(
      pathKey(resolved(root, replay.provenance?.path)),
      pathKey(oldResultsFile),
      'Echo fixed replay source path differs',
    );
    same(
      String(replay.provenance?.sha256 ?? '').toLowerCase(),
      String(fileBinding.sha256).toLowerCase(),
      'Echo fixed replay source SHA differs',
    );
    requireThat(
      Array.isArray(source.rankings) && Array.isArray(replay.rankings),
      'Echo fixed rankings are missing',
    );
    same(
      source.rankings.length,
      replay.rankings.length,
      'Echo fixed ranking length changed',
    );
    requireThat(
      source.rankings.length <= fixedReturnLimit,
      'Echo preserved fixed rankings exceed the frozen return limit',
    );
    for (let rank = 0; rank < source.rankings.length; rank++) {
      const old = source.rankings[rank];
      const fresh = replay.rankings[rank];
      same(
        old.rank,
        rank + 1,
        'Echo preserved fixed ranking positions are not consecutive',
      );
      requireThat(
        Number.isFinite(old.rrf_score),
        'Echo preserved fixed score is not finite',
      );
      same(
        String(fresh.id),
        String(old.id),
        'Echo fixed ranking id/order differs from preserved source',
      );
      same(
        fresh.rank,
        old.rank,
        'Echo fixed ranking position differs from preserved source',
      );
      same(
        fresh.score,
        old.rrf_score,
        'Echo fixed ranking score differs from preserved source',
      );
    }
  }
}

function verifyEchoNative(scope, question, row, docsById) {
  const ranked = rankedQueryRows(scope, question, row);
  for (let queryIndex = 0; queryIndex < question.queries.length; queryIndex++) {
    const query = question.queries[queryIndex];
    const queryRow = ranked[queryIndex];
    same(
      String(queryRow.query_sha256 ?? '').toLowerCase(),
      hashText(query.text),
      scope + ' Echo input query SHA differs from frozen subquery',
    );
    for (const candidate of queryRow.results) {
      const source = docsById.get(String(candidate.source_id ?? ''));
      requireThat(
        source,
        scope + ' Echo candidate references an unknown source',
      );
      const sourceText = corpusText(source);
      same(
        candidate.path,
        source.relative_path,
        scope + ' Echo candidate source path changed',
      );
      requireThat(
        typeof candidate.text === 'string',
        scope + ' Echo candidate has no text',
      );
      same(
        candidate.id,
        jsonHash([String(source.id), candidate.text]).slice(0, 32),
        scope + ' Echo candidate id does not bind its source text',
      );
      requireThat(
        candidate.native_id,
        scope + ' Echo candidate has no native chunk id',
      );
      requireThat(
        Number.isFinite(candidate.score),
        scope + ' Echo candidate score is not finite',
      );
      const location = candidate.source_location;
      requireThat(
        Number.isInteger(location?.start_line) &&
          Number.isInteger(location?.end_line) &&
          location.end_line >= location.start_line,
        scope + ' Echo candidate source location is invalid',
      );
      const firstLine = Number(source.original_first_line ?? 1);
      const excerpt = sourceText
        .split('\n')
        .slice(
          location.start_line - firstLine,
          location.end_line - firstLine + 1,
        )
        .join('\n');
      same(
        excerpt,
        candidate.text,
        scope + ' Echo candidate text differs from frozen source lines',
      );
      if (scope === 'qasper')
        same(
          String(candidate.source_id),
          String(question.source_id),
          'Echo QASPER candidate escaped the frozen source filter',
        );
    }
  }
}

async function verifyRuntimeSnapshots(root, scope, receipt) {
  const snapshots = receipt.runtime_snapshots;
  requireThat(
    Array.isArray(snapshots) && snapshots.length === 2,
    'Dify runtime snapshots are missing',
  );
  const names = new Set();
  for (const item of snapshots) {
    const file = resolved(root, item?.path);
    const name = path.basename(file);
    requireThat(
      name === scope + '.native-dataset.json' ||
        name === scope + '.published-workflow.json',
      'Dify runtime snapshot name is unexpected',
    );
    requireThat(!names.has(name), 'Dify runtime snapshot is duplicated');
    names.add(name);
    await verifyFileHash(file, item.sha256, 'Dify runtime snapshot');
  }
  requireThat(
    names.has(scope + '.native-dataset.json') &&
      names.has(scope + '.published-workflow.json'),
    'Dify runtime snapshot set is incomplete',
  );
}

async function verifyDifyIndex(root, scope, info, receipt, freeze) {
  const receiptFile = resolved(root, receipt.query_index_receipt_file);
  await verifyFileHash(
    receiptFile,
    receipt.query_index_receipt_sha256,
    'Dify scope index receipt',
  );
  const verified = await validateIndexReceipt({
    root,
    product: 'dify',
    scope,
    info,
    modelFingerprint: modelFingerprint(freeze),
  });
  same(
    pathKey(verified.path),
    pathKey(receiptFile),
    'Dify run receipt points at a different v2 scope index receipt',
  );
  same(
    String(verified.sha256).toLowerCase(),
    String(receipt.query_index_receipt_sha256).toLowerCase(),
    'Dify run and v2 scope index receipt SHA differ',
  );
  const index = verified.receipt;
  const pinned = await verifyEntryList(
    root,
    index.execution_files,
    'Dify index execution files',
  );
  const runEntries = await verifyEntryList(
    root,
    receipt.scope_execution_files,
    'Dify run execution files',
  );
  requireThat(
    runEntries.size > 0,
    'Dify run does not bind index execution files',
  );
  for (const [key, entry] of runEntries) {
    const frozenEntry = pinned.get(key);
    same(
      frozenEntry?.sha256,
      entry.sha256,
      'Dify run execution file is not bound by its scope index receipt',
    );
  }
  return {
    index,
    executionFiles: [...runEntries].map(([key, entry]) => ({ key, ...entry })),
  };
}

async function verifyEntryList(root, entries, label) {
  requireThat(
    Array.isArray(entries) && entries.length > 0,
    label + ' are missing',
  );
  const result = new Map();
  for (const entry of entries) {
    const file = resolved(root, entry?.path);
    const key = pathKey(file);
    requireThat(!result.has(key), label + ' contain a duplicate path');
    await verifyFileHash(file, entry.sha256, label + ' file');
    result.set(key, { sha256: String(entry.sha256).toLowerCase(), file });
  }
  return result;
}

async function difyFixedMap(root, scope, info, executionFiles, docsById) {
  const binding = executionFiles.find((entry) =>
    entry.key.endsWith('/segment-map.jsonl'),
  );
  requireThat(
    binding,
    'Dify fixed-unit segment map is not in the scope index receipt',
  );
  const file = [...executionFiles].find((entry) => entry.key === binding.key);
  const fullPath = file.file;
  const mappings = await readJsonl(fullPath, 'Dify fixed-unit segment map');
  const bySegment = new Map();
  const byUnit = new Set();
  for (const mapping of mappings) {
    const segmentId = String(mapping.segment_id ?? '');
    const unitId = String(mapping.unit_id ?? '');
    const source = docsById.get(unitId);
    requireThat(
      segmentId && unitId && source,
      'Dify fixed-unit map references an unknown unit',
    );
    same(
      mapping.text_sha256,
      hashText(corpusText(source)),
      'Dify fixed-unit map text SHA differs from frozen corpus',
    );
    requireThat(
      !bySegment.has(segmentId) && !byUnit.has(unitId),
      'Dify fixed-unit map is not one-to-one',
    );
    bySegment.set(segmentId, { unitId, text: corpusText(source) });
    byUnit.add(unitId);
  }
  same(
    byUnit.size,
    docsById.size,
    'Dify fixed-unit map does not cover the frozen corpus',
  );
  return bySegment;
}

async function difySegmentMap(executionFiles, corpusRows) {
  const sources = new Map(corpusRows.map((row) => [rowId(row), row]));
  const map = new Map();
  const segmentFiles = executionFiles.filter((entry) =>
    entry.key.endsWith('.segments.json'),
  );
  same(
    segmentFiles.length,
    sources.size,
    'Dify full-document mapping file count differs from the frozen corpus',
  );
  for (const entry of segmentFiles) {
    const native = await readJson(entry.file, 'Dify frozen segment mapping');
    const sourceId = String(native.source_id ?? '');
    const source = sources.get(sourceId);
    requireThat(
      source && Array.isArray(native.segments),
      'Dify segment mapping references an unknown source',
    );
    for (const segment of native.segments) {
      const id = String(segment.id ?? '');
      const text = String(segment.content ?? '');
      requireThat(
        id && typeof segment.content === 'string' && !map.has(id),
        'Dify native segment mapping is incomplete or duplicated',
      );
      map.set(id, { source, sourceId, text });
    }
  }
  return map;
}

async function difyDocumentMap(executionFiles, corpusRows) {
  const stateEntry = executionFiles.find((entry) =>
    entry.key.endsWith('/state.json'),
  );
  requireThat(
    stateEntry,
    'Dify source document map is not in the scope index receipt',
  );
  const state = await readJson(
    stateEntry.file,
    'Dify frozen source document map',
  );
  requireThat(
    state.documents &&
      typeof state.documents === 'object' &&
      !Array.isArray(state.documents),
    'Dify source document map is incomplete',
  );
  const sources = new Map(corpusRows.map((row) => [rowId(row), row]));
  const byDocument = new Map();
  for (const [key, value] of Object.entries(state.documents)) {
    const sourceId = String(value?.source_id ?? key);
    const documentId = String(value?.document_id ?? value?.documentId ?? '');
    const source = sources.get(sourceId);
    requireThat(
      source && sourceId === key && documentId && !byDocument.has(documentId),
      'Dify source/document mapping is invalid',
    );
    const sourcePath = String(value?.relative_path ?? value?.path ?? '');
    same(
      sourcePath,
      source.relative_path,
      'Dify source/document path differs from frozen corpus',
    );
    byDocument.set(documentId, { source_id: sourceId, path: sourcePath });
  }
  same(
    byDocument.size,
    sources.size,
    'Dify source/document map does not cover the frozen corpus',
  );
  return byDocument;
}

function difyResponseResults(parsed) {
  const data = parsed?.data ?? parsed;
  same(
    data?.status,
    'succeeded',
    'Dify native workflow response did not succeed',
  );
  requireThat(
    Array.isArray(data?.outputs?.result),
    'Dify native workflow response has no result list',
  );
  return data.outputs.result;
}

function compareDifyResults(
  scope,
  info,
  fixedMap,
  segmentMap,
  docsByDocument,
  question,
  nativeResults,
  normalized,
) {
  same(
    normalized.length,
    nativeResults.length,
    scope + ' Dify normalized result count differs from native response',
  );
  for (let index = 0; index < nativeResults.length; index++) {
    const raw = nativeResults[index];
    const candidate = normalized[index];
    const metadata = raw?.metadata ?? {};
    const nativeId = String(metadata.segment_id ?? '');
    const score = Number(metadata.score ?? raw?.score);
    requireThat(
      nativeId && Number.isFinite(score),
      scope + ' Dify native candidate is incomplete',
    );
    if (info.kind === 'official-fixed-unit') {
      const mapped = fixedMap.get(nativeId);
      requireThat(
        mapped,
        'Dify native segment is absent from the frozen fixed-unit map',
      );
      same(
        raw.content,
        mapped.text,
        'Dify native fixed-unit text differs from frozen source',
      );
      same(
        candidate.unit_id,
        mapped.unitId,
        'Dify normalized fixed-unit order/id differs from native response',
      );
      same(
        candidate.rank,
        index + 1,
        'Dify normalized fixed-unit rank differs from native response order',
      );
      same(
        candidate.score,
        score,
        'Dify normalized fixed-unit score differs from native response',
      );
    } else {
      const mapped = segmentMap.get(nativeId);
      requireThat(
        mapped,
        'Dify native segment is absent from the frozen source mapping',
      );
      const documentId = String(metadata.document_id ?? '');
      const document = docsByDocument.get(documentId);
      requireThat(
        document,
        'Dify native document id is absent from the frozen source map',
      );
      same(
        document.source_id,
        mapped.sourceId,
        'Dify native document id maps to a different source',
      );
      same(
        document.path,
        mapped.source.relative_path,
        'Dify native document id maps to a different source path',
      );
      const metadataScope = metadata.doc_metadata?.scope;
      if (metadataScope != null)
        same(
          String(metadataScope),
          mapped.sourceId,
          'Dify native source filter metadata changed',
        );
      same(
        raw.content,
        mapped.text,
        'Dify native response text differs from frozen segment',
      );
      same(
        candidate.native_id,
        nativeId,
        'Dify normalized native ID/order differs from response',
      );
      same(
        candidate.document_id,
        documentId,
        'Dify normalized document ID differs from response',
      );
      same(
        candidate.source_id,
        mapped.sourceId,
        'Dify normalized source ID differs from native segment mapping',
      );
      same(
        candidate.path,
        mapped.source.relative_path,
        'Dify normalized path differs from native segment mapping',
      );
      same(
        candidate.text,
        raw.content,
        'Dify normalized text differs from native response',
      );
      same(
        candidate.id,
        jsonHash([mapped.sourceId, raw.content]).slice(0, 32),
        'Dify normalized candidate ID does not bind native text',
      );
      same(
        candidate.score,
        score,
        'Dify normalized score differs from native response',
      );
      if (scope === 'qasper')
        same(
          mapped.sourceId,
          String(question.source_id),
          'Dify QASPER result escaped the frozen source filter',
        );
    }
  }
}

async function verifyDify(
  root,
  scope,
  info,
  frozen,
  questions,
  outputRows,
  receipt,
  freezeSha,
  freeze,
) {
  same(receipt.status, 'completed', 'Dify run receipt is not complete');
  same(receipt.scope, scope, 'Dify run receipt scope changed');
  if (receipt.condition !== undefined)
    same(receipt.condition, 'dify', 'Dify run receipt condition changed');
  same(
    receipt.parent_questions,
    questions.length,
    'Dify run receipt question count changed',
  );
  same(
    receipt.freeze_sha256,
    freezeSha,
    'Dify run receipt belongs to a different freeze',
  );
  requireThat(
    typeof receipt.run_fingerprint === 'string' &&
      receipt.run_fingerprint.length > 0,
    'Dify run fingerprint is missing',
  );
  same(
    receipt.corpus_sha256,
    info.corpus.sha256,
    'Dify run corpus binding changed',
  );
  same(
    receipt.query_sha256,
    info.queries.sha256,
    'Dify run query binding changed',
  );
  await verifyRuntimeSnapshots(root, scope, receipt);
  const { executionFiles } = await verifyDifyIndex(
    root,
    scope,
    info,
    receipt,
    freeze,
  );
  const outputFile = resultFileFromReceipt(root, 'dify', scope, receipt, true);
  await verifyFileHash(outputFile, receipt.output_sha256, 'Dify result file');
  checkOutputRows(scope, questions, outputRows);
  const nativeFiles = receipt.native_files;
  requireThat(
    Array.isArray(nativeFiles),
    'Dify run receipt has no native response files',
  );
  const byPair = new Map();
  for (const item of nativeFiles) {
    const key = JSON.stringify([
      String(item.question_id ?? ''),
      String(item.query_id ?? ''),
    ]);
    requireThat(
      !byPair.has(key),
      'Dify native file bindings contain a duplicate query',
    );
    const file = resolved(root, item.path);
    await verifyFileHash(file, item.sha256, 'Dify native response file');
    const record = await readJson(file, 'Dify native response file');
    same(
      record.run_fingerprint,
      receipt.run_fingerprint,
      'Dify native receipt belongs to a different run',
    );
    same(
      String(record.question_id),
      String(item.question_id),
      'Dify native question binding changed',
    );
    same(
      String(record.query_id),
      String(item.query_id),
      'Dify native query binding changed',
    );
    requireThat(record.ok === true, 'Dify native response is not successful');
    byPair.set(key, record);
  }
  let expectedNativeCount = 0;
  const fixedMap =
    info.kind === 'official-fixed-unit'
      ? await difyFixedMap(root, scope, info, executionFiles, frozen.docsById)
      : null;
  const segmentMap =
    info.kind === 'official-fixed-unit'
      ? null
      : await difySegmentMap(executionFiles, frozen.corpusRows);
  const docsByDocument =
    info.kind === 'official-fixed-unit'
      ? null
      : await difyDocumentMap(executionFiles, frozen.corpusRows);
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index];
    const ranked = rankedQueryRows(scope, question, outputRows[index]);
    for (
      let queryIndex = 0;
      queryIndex < question.queries.length;
      queryIndex++
    ) {
      const query = question.queries[queryIndex];
      const key = JSON.stringify([rowId(question), queryId(query)]);
      const record = byPair.get(key);
      requireThat(
        record,
        'Dify run is missing a native response for a frozen query',
      );
      const raw = record.raw_http;
      requireThat(
        raw &&
          raw.response_status >= 200 &&
          raw.response_status < 300 &&
          typeof raw.response_body_raw === 'string',
        'Dify native HTTP response is incomplete',
      );
      const inputs = raw.request_body?.inputs;
      same(
        inputs?.query,
        query.text,
        'Dify request query differs from frozen input',
      );
      if (scope === 'qasper')
        same(
          String(inputs?.source_id ?? ''),
          String(question.source_id ?? ''),
          'Dify QASPER source filter differs from frozen question',
        );
      else
        requireThat(
          inputs?.source_id === undefined,
          'Dify non-QASPER request unexpectedly carries a source filter',
        );
      let parsed;
      try {
        parsed = JSON.parse(raw.response_body_raw);
      } catch {
        throw new Error(
          'Product run integrity: Dify native response is not valid JSON',
        );
      }
      const nativeResults = difyResponseResults(parsed);
      compareDifyResults(
        scope,
        info,
        fixedMap,
        segmentMap,
        docsByDocument,
        question,
        nativeResults,
        ranked[queryIndex].results,
      );
      expectedNativeCount++;
    }
    if (info.kind === 'official-fixed-unit')
      verifyFixedRankings(
        'dify',
        freeze,
        question,
        outputRows[index],
        ranked[0].results,
        'unit_id',
      );
  }
  same(
    byPair.size,
    expectedNativeCount,
    'Dify native receipt set does not exactly cover frozen queries',
  );
}

function verifyFixedRankings(
  condition,
  freeze,
  question,
  outputRow,
  normalized,
  idField,
) {
  same(
    question.queries.length,
    1,
    'Official fixed task must have exactly one frozen query',
  );
  const limit = freeze.conditions?.[condition]?.fixed_return_limit;
  requireThat(
    Number.isInteger(limit) && limit > 0,
    'Fixed return limit is missing from the global freeze',
  );
  requireThat(
    normalized.length <= limit,
    'Fixed native rankings exceed the frozen return limit',
  );
  requireThat(
    Array.isArray(outputRow.rankings),
    'Fixed result row has no public rankings',
  );
  same(
    outputRow.rankings.length,
    normalized.length,
    'Fixed public rankings differ in length from verified native results',
  );
  const ids = new Set();
  for (let index = 0; index < normalized.length; index++) {
    const candidate = normalized[index];
    const ranking = outputRow.rankings[index];
    const id = String(candidate?.[idField] ?? '');
    requireThat(
      id && !ids.has(id),
      'Fixed native ranking repeats an official unit',
    );
    ids.add(id);
    same(
      String(ranking?.id ?? ''),
      id,
      'Fixed public ranking id/order differs from verified native results',
    );
    same(
      ranking.rank,
      index + 1,
      'Fixed public ranking position differs from native response order',
    );
    requireThat(
      Number.isFinite(candidate.score),
      'Fixed native score is not finite',
    );
    same(
      ranking.score,
      candidate.score,
      'Fixed public ranking score differs from verified native results',
    );
  }
}

function nativeField(row, snake, kebab) {
  return Object.hasOwn(row ?? {}, snake) ? row[snake] : row?.[kebab];
}

function khojPathMatch(returnedPath, relativePath) {
  return (
    returnedPath === relativePath ||
    returnedPath.endsWith('/' + relativePath) ||
    returnedPath.endsWith('\\' + relativePath)
  );
}

function mapKhojNativeDocument(raw, docsByPath) {
  const returnedPath = raw?.additional?.file;
  requireThat(
    typeof returnedPath === 'string',
    'Khoj native result has no returned file',
  );
  if (docsByPath.has(returnedPath)) return docsByPath.get(returnedPath);
  const matches = [...docsByPath.values()].filter((doc) =>
    khojPathMatch(returnedPath, String(doc.relative_path ?? '')),
  );
  same(
    matches.length,
    1,
    'Khoj native returned file does not map to one frozen source',
  );
  return matches[0];
}

function compareKhojQuery(
  scope,
  info,
  question,
  query,
  queryRow,
  fixedMap,
  docsByPath,
  conditionSettings,
) {
  same(
    String(queryRow.query_id),
    queryId(query),
    'Khoj query id/order differs from frozen query',
  );
  same(
    queryRow.query,
    query.text,
    'Khoj original request input differs from frozen query',
  );
  let expectedText = query.text;
  let expectedFilter = null;
  if (scope === 'qasper') {
    const source = String(question.source_id ?? '');
    const doc = [...docsByPath.values()].find(
      (candidate) => rowId(candidate) === source,
    );
    requireThat(doc, 'Khoj QASPER source id is absent from frozen corpus');
    const relative = String(doc.relative_path).replaceAll('"', '\\"');
    expectedText = 'file:"' + relative + '" ' + query.text;
    expectedFilter = { file: doc.relative_path, source_id: source };
  }
  same(
    queryRow.native_query,
    expectedText,
    'Khoj native query differs from frozen input/filter',
  );
  same(
    JSON.stringify(queryRow.filter ?? null),
    JSON.stringify(expectedFilter),
    'Khoj source filter differs from frozen question',
  );
  same(
    queryRow.filter_applied_before_top10,
    scope === 'qasper',
    'Khoj source filter timing changed',
  );
  same(queryRow.dedupe, false, 'Khoj dedupe setting changed');
  same(queryRow.native_return_limit, 10, 'Khoj native return limit changed');
  const request = queryRow.native_request;
  same(request?.method, 'GET', 'Khoj native request method changed');
  same(request?.path, '/api/search', 'Khoj native request path changed');
  same(
    request?.params?.q,
    expectedText,
    'Khoj actual HTTP query differs from the frozen input/filter',
  );
  same(
    request?.params?.n,
    String(conditionSettings.fixed_return_limit),
    'Khoj actual HTTP top-k differs from the freeze',
  );
  same(
    request?.params?.t,
    info.kind === 'official-fixed-unit' ? 'plaintext' : 'markdown',
    'Khoj actual HTTP text mode changed',
  );
  same(
    request?.params?.r,
    String(conditionSettings.rerank),
    'Khoj actual HTTP rerank flag differs from the freeze',
  );
  same(
    request?.params?.dedupe,
    'false',
    'Khoj actual HTTP dedupe flag changed',
  );
  requireThat(
    Array.isArray(queryRow.native_response),
    'Khoj native response is missing',
  );
  same(
    queryRow.native_response_sha256,
    jsonHash(queryRow.native_response),
    'Khoj native response SHA differs',
  );
  same(
    queryRow.results.length,
    queryRow.native_response.length,
    'Khoj normalized/native result count differs',
  );
  for (let index = 0; index < queryRow.native_response.length; index++) {
    const raw = queryRow.native_response[index];
    const normalized = queryRow.results[index];
    const additional = raw?.additional ?? {};
    const text = additional.compiled;
    const nativeId = String(nativeField(raw, 'corpus_id', 'corpus-id') ?? '');
    const cross = nativeField(raw, 'cross_score', 'cross-score');
    const crossPresent = cross !== undefined && cross !== null;
    requireThat(
      typeof text === 'string' && text.length > 0 && nativeId,
      'Khoj native result is incomplete',
    );
    requireThat(Number.isFinite(raw.score), 'Khoj native score is not finite');
    same(
      normalized.native_id,
      nativeId,
      'Khoj normalized native ID/order differs from response',
    );
    same(normalized.text, text, 'Khoj normalized text differs from response');
    same(
      normalized.score,
      raw.score,
      'Khoj normalized score differs from response',
    );
    same(
      normalized.cross_score,
      crossPresent ? cross : null,
      'Khoj normalized cross-score differs from response',
    );
    same(
      normalized.cross_score_present,
      crossPresent,
      'Khoj normalized cross-score presence differs from response',
    );
    same(
      normalized.native_metadata?.entry ?? null,
      raw.entry ?? null,
      'Khoj normalized entry differs from response',
    );
    same(
      normalized.native_metadata?.heading ?? null,
      additional.heading ?? null,
      'Khoj normalized heading differs from response',
    );
    same(
      normalized.native_metadata?.file,
      additional.file,
      'Khoj normalized file differs from response',
    );
    if (info.kind === 'official-fixed-unit') {
      const source = fixedMap.get(nativeId);
      requireThat(
        source,
        'Khoj fixed native ID is absent from the frozen unit map',
      );
      same(
        text,
        source.compiled,
        'Khoj fixed native text differs from frozen unit',
      );
      same(
        normalized.id,
        source.unit_id,
        'Khoj fixed normalized unit ID/order differs from response',
      );
      same(
        additional.file,
        source.file,
        'Khoj fixed native file differs from frozen unit mapping',
      );
    } else {
      const source = mapKhojNativeDocument(raw, docsByPath);
      same(
        normalized.id,
        jsonHash([String(source.id), text]).slice(0, 32),
        'Khoj normalized candidate ID does not bind native text',
      );
      same(
        normalized.source_id,
        String(source.source_id ?? source.id),
        'Khoj normalized source differs from native file mapping',
      );
      same(
        normalized.path,
        source.relative_path,
        'Khoj normalized path differs from native file mapping',
      );
      if (scope === 'qasper')
        same(
          String(normalized.source_id),
          String(question.source_id),
          'Khoj QASPER result escaped the frozen source filter',
        );
    }
  }
}

async function khojIndexBindings(root, scope, info, receipt, freeze) {
  const queryIndex = receipt.index_receipt;
  requireThat(
    queryIndex?.path && queryIndex?.sha256,
    'Khoj run receipt has no scope query-index binding',
  );
  const queryFile = resolved(root, queryIndex.path);
  await verifyFileHash(
    queryFile,
    queryIndex.sha256,
    'Khoj scope query-index receipt',
  );
  const verified = await validateIndexReceipt({
    root,
    product: 'khoj',
    scope,
    info,
    modelFingerprint: modelFingerprint(freeze),
  });
  same(
    pathKey(verified.path),
    pathKey(queryFile),
    'Khoj run receipt points at a different v2 scope index receipt',
  );
  same(
    String(verified.sha256).toLowerCase(),
    String(queryIndex.sha256).toLowerCase(),
    'Khoj run and v2 scope index receipt SHA differ',
  );
  const queryReceipt = verified.receipt;
  same(
    queryReceipt.status,
    'frozen',
    'Khoj scope query-index receipt is not frozen',
  );
  same(
    queryReceipt.scope,
    scope,
    'Khoj scope query-index receipt scope changed',
  );
  same(queryReceipt.product, 'khoj', 'Khoj scope query-index product changed');
  same(
    queryReceipt.corpus_sha256,
    info.corpus.sha256,
    'Khoj scope query-index corpus changed',
  );
  const pinned = await verifyEntryList(
    root,
    queryReceipt.execution_files,
    'Khoj index execution files',
  );
  const kind = info.kind === 'official-fixed-unit' ? 'fixed' : 'native';
  const indexFile = path.join(
    root,
    'indexes',
    'khoj',
    scope,
    'index-' + kind + '-scope-receipt.json',
  );
  const indexKey = pathKey(indexFile);
  const indexBinding = pinned.get(indexKey);
  requireThat(
    indexBinding,
    'Khoj query-index receipt does not bind the scope index receipt',
  );
  const indexReceipt = await readJson(indexFile, 'Khoj scope index receipt');
  same(
    indexReceipt.status,
    'indexed',
    'Khoj scope index receipt is not complete',
  );
  same(indexReceipt.scope, scope, 'Khoj scope index receipt scope changed');
  same(indexReceipt.kind, kind, 'Khoj scope index receipt kind changed');
  same(
    indexReceipt.inputs?.corpus_sha256,
    info.corpus.sha256,
    'Khoj indexed corpus differs from frozen input',
  );
  let fixedMap = null;
  if (kind === 'fixed') {
    const fixedFile = path.join(
      root,
      'khoj-runtime',
      'input',
      'fixed-' + scope + '.jsonl',
    );
    const fixedBinding = pinned.get(pathKey(fixedFile));
    requireThat(
      fixedBinding,
      'Khoj query-index receipt does not bind the fixed-unit UUID map',
    );
    const rows = await readJsonl(fixedFile, 'Khoj frozen fixed-unit UUID map');
    fixedMap = new Map();
    const unitIds = new Set();
    const byUnitId = new Map();
    for (const row of rows) {
      const nativeId = String(row.corpus_id ?? '');
      const unitId = String(row.unit_id ?? '');
      const source = String(row.source_id ?? '');
      requireThat(
        nativeId &&
          unitId &&
          source &&
          !fixedMap.has(nativeId) &&
          !unitIds.has(unitId),
        'Khoj fixed-unit UUID map is incomplete or duplicated',
      );
      fixedMap.set(nativeId, row);
      unitIds.add(unitId);
      byUnitId.set(unitId, row);
    }
    const corpusRows = await readJsonl(
      resolved(root, info.corpus.path),
      scope + ' frozen corpus',
    );
    same(
      fixedMap.size,
      corpusRows.length,
      'Khoj fixed-unit UUID map does not cover the frozen corpus',
    );
    for (const source of corpusRows) {
      const row = byUnitId.get(rowId(source));
      requireThat(row, 'Khoj fixed-unit UUID map omits an official unit');
      same(
        row.compiled,
        corpusText(source),
        'Khoj fixed-unit import text differs from frozen corpus',
      );
      same(
        String(row.source_id),
        String(source.source_id ?? source.id),
        'Khoj fixed-unit source mapping differs from frozen corpus',
      );
    }
  }
  return { queryReceipt, fixedMap };
}

async function verifyKhoj(
  root,
  condition,
  scope,
  info,
  frozen,
  questions,
  outputRows,
  receipt,
  freezeSha,
  freeze,
) {
  same(receipt.status, 'complete', 'Khoj run receipt is not complete');
  same(receipt.condition, condition, 'Khoj run receipt condition changed');
  same(receipt.scope, scope, 'Khoj run receipt scope changed');
  same(
    receipt.questions,
    questions.length,
    'Khoj run receipt question count changed',
  );
  same(
    receipt.freeze_sha256,
    freezeSha,
    'Khoj run receipt belongs to a different freeze',
  );
  const conditionSettings = freeze.conditions?.[condition];
  requireThat(
    conditionSettings,
    'Khoj condition is missing from the global freeze',
  );
  same(
    conditionSettings.rerank,
    condition === 'khoj-rerank',
    'Khoj freeze rerank condition is mixed',
  );
  same(conditionSettings.dedupe, false, 'Khoj freeze enables deduplication');
  same(
    conditionSettings.fixed_return_limit,
    10,
    'Khoj freeze return limit changed',
  );
  const resultFile = resultFileFromReceipt(
    root,
    condition,
    scope,
    receipt,
    false,
  );
  await verifyFileHash(resultFile, receipt.result?.sha256, 'Khoj result file');
  checkOutputRows(scope, questions, outputRows);
  const { fixedMap } = await khojIndexBindings(
    root,
    scope,
    info,
    receipt,
    freeze,
  );
  for (let index = 0; index < questions.length; index++) {
    same(
      outputRows[index].condition?.name,
      condition,
      'Khoj result condition changed',
    );
    same(
      outputRows[index].condition?.rerank,
      conditionSettings.rerank,
      'Khoj output condition rerank differs from the freeze',
    );
    same(
      outputRows[index].condition?.dedupe,
      false,
      'Khoj output condition enables deduplication',
    );
    same(
      outputRows[index].condition?.return_limit,
      conditionSettings.fixed_return_limit,
      'Khoj output condition return limit differs from the freeze',
    );
    same(
      outputRows[index].native_http_return_limit,
      10,
      'Khoj result return limit changed',
    );
    const ranked = rankedQueryRows(scope, questions[index], outputRows[index]);
    for (
      let queryIndex = 0;
      queryIndex < questions[index].queries.length;
      queryIndex++
    )
      compareKhojQuery(
        scope,
        info,
        questions[index],
        questions[index].queries[queryIndex],
        ranked[queryIndex],
        fixedMap,
        frozen.docsByPath,
        conditionSettings,
      );
    if (info.kind === 'official-fixed-unit')
      verifyFixedRankings(
        condition,
        freeze,
        questions[index],
        outputRows[index],
        ranked[0].results,
        'id',
      );
  }
}

async function verifyEcho(
  root,
  condition,
  scope,
  info,
  frozen,
  questions,
  outputRows,
  receipt,
  freezeSha,
) {
  same(receipt.status, 'complete', 'Echo run receipt is not complete');
  same(receipt.condition, 'echo', 'Echo run receipt condition changed');
  same(receipt.scope, scope, 'Echo run receipt scope changed');
  same(
    receipt.questions,
    questions.length,
    'Echo run receipt question count changed',
  );
  same(
    receipt.freeze_sha256,
    freezeSha,
    'Echo run receipt belongs to a different freeze',
  );
  const resultFile = resultFileFromReceipt(
    root,
    condition,
    scope,
    receipt,
    false,
  );
  await verifyFileHash(resultFile, receipt.result?.sha256, 'Echo result file');
  checkOutputRows(scope, questions, outputRows);
  if (info.kind === 'official-fixed-unit') {
    await verifyEchoFixed(
      root,
      scope,
      info,
      frozen.freeze,
      questions,
      outputRows,
    );
    return;
  }
  for (let index = 0; index < questions.length; index++)
    verifyEchoNative(
      scope,
      questions[index],
      outputRows[index],
      frozen.docsById,
    );
}

async function verifyOneScope(root, condition, scope, info, freezeSha, freeze) {
  const frozen = await loadFrozenScope(root, scope, info, condition);
  const dify = condition === 'dify';
  const receiptFile = dify
    ? path.join(root, 'runs', 'dify', scope + '.receipt.json')
    : path.join(root, 'runs', condition, scope + '-receipt.json');
  const receipt = await readJson(receiptFile, scope + ' run receipt');
  const resultFile = resultFileFromReceipt(
    root,
    condition,
    scope,
    receipt,
    dify,
  );
  const outputRows = await readJsonl(resultFile, scope + ' result file');
  if (dify)
    await verifyDify(
      root,
      scope,
      info,
      frozen,
      frozen.questions,
      outputRows,
      receipt,
      freezeSha,
      freeze,
    );
  else if (condition === 'echo')
    await verifyEcho(
      root,
      condition,
      scope,
      info,
      { ...frozen, freeze },
      frozen.questions,
      outputRows,
      receipt,
      freezeSha,
    );
  else if (condition === 'khoj-dense' || condition === 'khoj-rerank')
    await verifyKhoj(
      root,
      condition,
      scope,
      info,
      frozen,
      frozen.questions,
      outputRows,
      receipt,
      freezeSha,
      freeze,
    );
  else throw new Error('Product run integrity: unsupported condition');
  return { scope, questions: frozen.questions.length };
}

export async function verifyProductRuns({
  root: rootValue,
  condition,
  scopes,
}) {
  requireThat(
    typeof rootValue === 'string' && rootValue.length > 0,
    'batch root is required',
  );
  requireThat(
    ['echo', 'dify', 'khoj-dense', 'khoj-rerank'].includes(condition),
    'unsupported product condition',
  );
  requireThat(
    Array.isArray(scopes) && scopes.length > 0,
    'scope list is required',
  );
  const root = path.resolve(rootValue);
  const freezeFile = path.join(root, 'freeze.json');
  const manifestFile = path.join(root, 'corpus-v1', 'manifest.json');
  const freeze = await readJson(freezeFile, 'global freeze');
  const manifest = await readJson(manifestFile, 'corpus manifest');
  same(freeze.status, 'frozen', 'global freeze is not frozen');
  const manifestSha = await sha256(manifestFile, 'corpus manifest');
  same(
    manifestSha,
    freeze.corpus_manifest_sha256,
    'corpus manifest differs from the global freeze',
  );
  const freezeSha = await sha256(freezeFile, 'global freeze');
  try {
    await verifyExecutionFiles(
      root,
      freeze.execution_files,
      requiredProductRunExecutionFiles(condition),
    );
  } catch {
    throw new Error(
      'Product run integrity: global freeze execution code is missing or changed',
    );
  }
  const seen = new Set();
  const results = [];
  for (const scopeValue of scopes) {
    const scope = String(scopeValue);
    requireThat(
      scope && !seen.has(scope),
      'scope list contains an empty or duplicate scope',
    );
    seen.add(scope);
    const info = manifest.scopes?.[scope];
    requireThat(info, 'scope is absent from the frozen corpus manifest');
    results.push(
      await verifyOneScope(root, condition, scope, info, freezeSha, freeze),
    );
  }
  return { condition, freeze_sha256: freezeSha, scopes: results };
}
