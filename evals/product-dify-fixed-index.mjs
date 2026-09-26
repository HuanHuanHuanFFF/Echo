import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { jsonLines } from './prepare-product-comparison.mjs';

const FIXED_COUNTS = { langchain: 49505, godot: 25477, du: 100001 };
const BATCH_SIZE = 200;
const PAGE_SIZE = 100;
const API_BASE = 'http://127.0.0.1:15101/v1';
const CREATE_TIMEOUT_MS = 5 * 60 * 1000;
const READ_TIMEOUT_MS = 2 * 60 * 1000;
const PENDING_RESOLVE_ATTEMPTS = 6;
const PENDING_RESOLVE_DELAY_MS = 3000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const [rootArg, mode, officialScope] = process.argv.slice(2);
assert.ok(
  rootArg && (mode === '--smoke' || mode === '--execute-fixed-index'),
  'Usage: node evals/product-dify-fixed-index.mjs PRODUCT_ROOT --smoke | PRODUCT_ROOT --execute-fixed-index <langchain|godot|du>',
);
assert.equal(
  mode === '--smoke' ? officialScope : Boolean(officialScope),
  mode === '--smoke' ? undefined : true,
  'Smoke mode takes no scope; fixed indexing requires an explicit official scope.',
);

const root = path.resolve(rootArg);
const freeze = JSON.parse(
  await fs.readFile(path.join(root, 'index-freeze.json'), 'utf8'),
);
assert.equal(freeze.status, 'index-inputs-frozen');
assert.equal(freeze.dify.version, '1.17.1');
assert.ok(freeze.dify.provider && freeze.dify.model);
const manifestBytes = await fs.readFile(
  path.join(root, 'corpus-v1/manifest.json'),
);
assert.equal(
  digest(manifestBytes),
  freeze.corpus_manifest_sha256,
  'Corpus manifest no longer matches the index freeze.',
);
const manifest = JSON.parse(manifestBytes);

let scope;
let corpusPath;
let expectedCount;
let expectedCorpusSha256;
let sourceKind;
let smokeRows = null;
if (mode === '--smoke') {
  scope = 'fixed-smoke';
  const smokeRoot = path.join(root, 'dify-runtime/smoke/fixed-unit-indexer-v1');
  await fs.mkdir(smokeRoot, { recursive: true });
  corpusPath = path.join(smokeRoot, 'corpus.jsonl');
  smokeRows = [
    { id: 'fixed-smoke-cn-short', text: '甲' },
    {
      id: 'fixed-smoke-duplicate-a',
      text: '同文重复探针 fixed-smoke',
    },
    {
      id: 'fixed-smoke-duplicate-b',
      text: '同文重复探针 fixed-smoke',
    },
  ].map((row) => ({ ...row, text_sha256: digest(row.text) }));
  const fixture = smokeRows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  try {
    await fs.writeFile(corpusPath, fixture, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.equal(
      await fs.readFile(corpusPath, 'utf8'),
      fixture,
      'Existing fixed-smoke corpus differs; refusing to overwrite it.',
    );
  }
  expectedCount = smokeRows.length;
  sourceKind = 'synthetic-fixed-unit-smoke';
} else {
  scope = officialScope;
  assert.ok(
    Object.hasOwn(FIXED_COUNTS, scope),
    'Unknown official fixed scope.',
  );
  const info = manifest.scopes[scope];
  assert.ok(info && info.kind === 'official-fixed-unit');
  assert.equal(info.documents, FIXED_COUNTS[scope]);
  corpusPath = info.corpus.path;
  expectedCount = info.documents;
  expectedCorpusSha256 = info.corpus.sha256;
  sourceKind = 'official-fixed-unit';
}

const corpusSha256 = await shaFile(corpusPath);
if (expectedCorpusSha256)
  assert.equal(
    corpusSha256,
    expectedCorpusSha256,
    'Fixed corpus hash changed.',
  );
expectedCorpusSha256 ??= corpusSha256;

const out = path.join(root, 'indexes/dify', scope);
await fs.mkdir(out, { recursive: true });
const stateFile = path.join(out, 'state.json');
let state = await fs
  .readFile(stateFile, 'utf8')
  .then(JSON.parse)
  .catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return {
      version: 1,
      scope,
      source_kind: sourceKind,
      corpus_sha256: corpusSha256,
      total_units: expectedCount,
      status: 'pending',
      dataset_name: datasetName(scope, corpusSha256),
      dataset_id: null,
      dataset_create_pending: false,
      container_create_pending: false,
      container_cleaned: false,
      documents: {},
      committed_units: 0,
      pending_batch: null,
    };
  });
assert.equal(state.scope, scope);
assert.equal(state.source_kind, sourceKind);
assert.equal(state.corpus_sha256, corpusSha256);
assert.equal(state.total_units, expectedCount);
assert.equal(state.dataset_name, datasetName(scope, corpusSha256));
assert.ok(state.documents && typeof state.documents === 'object');
assert.ok(Number.isInteger(state.committed_units));
assert.ok(state.committed_units >= 0 && state.committed_units <= expectedCount);

const serviceSession = JSON.parse(
  await fs.readFile(
    path.join(root, 'dify-runtime/private-session.json'),
    'utf8',
  ),
);
assert.ok(serviceSession.service_api_key);

await preflightCorpus(corpusPath, expectedCount);
await saveState();
await ensureDataset();
await ensureContainerDocument();
await waitForDocument(state.documents.container);
await cleanContainerDummy();
await reconcileCheckpoint();
await indexRemainingUnits();

const segmentAudit = await auditAllSegments({ writeMap: true });
state.committed_units = expectedCount;
state.documents.container.segment_count = segmentAudit.count;
state.documents.container.vector_ready_segments = segmentAudit.vectorReady;
state.segments_audited_at = new Date().toISOString();
state.segment_audit = {
  expected: expectedCount,
  actual: segmentAudit.count,
  exact_content_sha256_matches: segmentAudit.contentHashMatches,
  completed_enabled_with_index_ids: segmentAudit.vectorReady,
  unique_segment_ids: segmentAudit.uniqueSegmentIds,
  unique_index_node_ids: segmentAudit.uniqueIndexNodeIds,
};

if (mode === '--smoke') {
  state.status = 'segments-verified-vector-probe-pending';
  await saveState();
  try {
    state.vector_probe = await runSmokeVectorProbe(
      segmentAudit.smokeSegmentIds,
    );
    state.status = 'smoke-verified';
    state.completed_at = new Date().toISOString();
    await writeJson(path.join(out, 'audit.json'), {
      scope,
      status: state.status,
      corpus_sha256: corpusSha256,
      segment_audit: state.segment_audit,
      vector_probe: state.vector_probe,
    });
    await saveState();
  } catch (error) {
    state.status = 'vector-probe-failed';
    state.vector_probe_error = safeError(error);
    await writeJson(path.join(out, 'audit.json'), {
      scope,
      status: state.status,
      corpus_sha256: corpusSha256,
      segment_audit: state.segment_audit,
      vector_probe_error: state.vector_probe_error,
    });
    await saveState();
    throw error;
  }
} else {
  state.status = 'segments-verified-awaiting-vector-audit';
  state.completed_at = new Date().toISOString();
  await writeJson(path.join(out, 'audit.json'), {
    scope,
    status: state.status,
    corpus_sha256: corpusSha256,
    segment_audit: state.segment_audit,
    vector_audit: 'pending external read-only backend audit',
  });
  await saveState();
}

console.log(
  JSON.stringify({
    scope,
    status: state.status,
    dataset_id: state.dataset_id,
    document_id: state.documents.container.document_id,
    units: segmentAudit.count,
    batch_size: BATCH_SIZE,
    vector_ready_segments: segmentAudit.vectorReady,
    segment_map: path.join(out, 'segment-map.jsonl'),
    audit: path.join(out, 'audit.json'),
  }),
);

async function shaFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function datasetName(currentScope, hash) {
  const prefix =
    currentScope === 'fixed-smoke'
      ? 'echo-fixed-smoke-'
      : 'echo-fixed-' + currentScope + '-';
  return prefix + hash.slice(0, 8);
}

function legacyDummyText() {
  return (
    '__echo_fixed_unit_container__' + scope + '__' + corpusSha256.slice(0, 12)
  );
}

function dummyText() {
  const legacy = legacyDummyText();
  if (state.documents.container?.dummy_text_sha256 === digest(legacy))
    return legacy;
  return 'echo-fixed-unit-container-' + scope + '-' + corpusSha256.slice(0, 12);
}

function dummyVariants() {
  const expected = dummyText();
  return expected === legacyDummyText()
    ? [expected, expected.slice(2)]
    : [expected];
}

async function preflightCorpus(file, targetCount) {
  let count = 0;
  const ids = new Set();
  for await (const row of jsonLines(file)) {
    const id = String(row.id ?? row._id ?? '');
    assert.ok(id && id !== 'undefined', 'A fixed unit has no stable ID.');
    assert.equal(
      typeof row.text,
      'string',
      'A fixed unit text is not a string: ' + id,
    );
    assert.ok(
      row.text.length > 0,
      'Dify does not accept an empty segment: ' + id,
    );
    assert.ok(!ids.has(id), 'Duplicate fixed-unit ID: ' + id);
    ids.add(id);
    const textSha256 = digest(row.text);
    if (row.text_sha256)
      assert.equal(
        row.text_sha256,
        textSha256,
        'Unit text hash mismatch: ' + id,
      );
    count++;
  }
  assert.equal(count, targetCount, 'Fixed-unit corpus row count changed.');
}

async function saveState() {
  await writeJson(stateFile, state);
}

async function writeJson(file, value) {
  await writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

async function writeAtomic(file, contents) {
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  const handle = await fs.open(temporary, 'wx');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
}

async function api(route, method = 'GET', body, timeoutMs = READ_TIMEOUT_MS) {
  const response = await fetch(API_BASE + route, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      authorization: 'Bearer ' + serviceSession.service_api_key,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
  }
  if (!response.ok) {
    const error = new Error(
      'Dify HTTP ' + response.status + ' at ' + method + ' ' + route,
    );
    error.httpStatus = response.status;
    throw error;
  }
  return value;
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function ensureDataset() {
  if (state.dataset_id) return;
  const existing = await findDatasetsByExactName(state.dataset_name);
  if (state.dataset_create_pending) {
    assert.equal(
      existing.length,
      1,
      'Dataset creation outcome is unresolved; refusing to create another dataset.',
    );
    state.dataset_id = existing[0].id;
    state.dataset_create_pending = false;
    state.status = 'dataset-reconciled';
    await saveState();
    return;
  }
  assert.equal(
    existing.length,
    0,
    'A dataset with this deterministic name exists without a checkpoint; refusing to adopt or duplicate it.',
  );
  state.dataset_create_pending = true;
  state.status = 'dataset-create-pending';
  await saveState();
  let created;
  try {
    created = await api(
      '/datasets',
      'POST',
      {
        name: state.dataset_name,
        description:
          'Fixed official units indexed as native text_model segments; scope=' +
          scope +
          '; corpus_sha256=' +
          corpusSha256,
        permission: 'only_me',
        indexing_technique: 'high_quality',
        embedding_model: freeze.dify.model,
        embedding_model_provider: freeze.dify.provider,
        retrieval_model: freeze.dify.retrieval_model,
      },
      CREATE_TIMEOUT_MS,
    );
  } catch (error) {
    state.status = 'dataset-create-result-unknown';
    await saveState();
    const found = await findDatasetsByExactName(state.dataset_name);
    if (found.length === 1) created = found[0];
    else throw error;
  }
  const dataset = created.data ?? created;
  assert.ok(dataset.id, 'Dify dataset creation returned no ID.');
  state.dataset_id = dataset.id;
  state.dataset_create_pending = false;
  state.status = 'dataset-created';
  await saveState();
}

async function findDatasetsByExactName(name) {
  const query = new URLSearchParams({ keyword: name, limit: '100', page: '1' });
  const result = await api('/datasets?' + query.toString());
  const rows = Array.isArray(result?.data) ? result.data : [];
  return rows.filter((row) => row.name === name);
}

async function ensureContainerDocument() {
  const name = 'fixed-container-' + scope + '-' + corpusSha256.slice(0, 8);
  const dummy = dummyText();
  let container = state.documents.container;
  if (container?.document_id) return;

  const existing = await findDocumentsByExactName(name);
  if (state.container_create_pending) {
    assert.equal(
      existing.length,
      1,
      'Container document creation outcome is unresolved; refusing to create another document.',
    );
    container = {
      name,
      document_id: existing[0].id,
      batch: null,
      dummy_text_sha256: digest(dummy),
      status: existing[0].indexing_status ?? 'reconciled',
    };
    state.documents.container = container;
    state.container_create_pending = false;
    state.status = 'container-document-reconciled';
    await saveState();
    return;
  }
  assert.equal(
    existing.length,
    0,
    'A container document with this name exists without a checkpoint; refusing to adopt or duplicate it.',
  );
  state.container_create_pending = true;
  state.status = 'container-create-pending';
  await saveState();
  let created;
  try {
    created = await api(
      '/datasets/' + state.dataset_id + '/document/create-by-text',
      'POST',
      {
        name,
        text: dummy,
        doc_form: 'text_model',
        doc_language: 'Chinese',
        indexing_technique: 'high_quality',
        embedding_model: freeze.dify.model,
        embedding_model_provider: freeze.dify.provider,
      },
      CREATE_TIMEOUT_MS,
    );
  } catch (error) {
    state.status = 'container-create-result-unknown';
    await saveState();
    const found = await findDocumentsByExactName(name);
    if (found.length !== 1) throw error;
    created = { document: found[0], batch: null };
  }
  const document =
    created.document ?? created.data?.document ?? created.data ?? {};
  assert.ok(document.id, 'Dify container document creation returned no ID.');
  container = {
    name,
    document_id: document.id,
    batch: created.batch ?? created.data?.batch ?? null,
    dummy_text_sha256: digest(dummy),
    status: 'indexing',
  };
  state.documents.container = container;
  state.container_create_pending = false;
  state.status = 'container-document-created';
  await saveState();
}

async function findDocumentsByExactName(name) {
  const query = new URLSearchParams({ keyword: name, limit: '100', page: '1' });
  const result = await api(
    '/datasets/' + state.dataset_id + '/documents?' + query.toString(),
  );
  const rows = Array.isArray(result?.data) ? result.data : [];
  return rows.filter((row) => row.name === name);
}

async function waitForDocument(container) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (true) {
    let status = null;
    let error = null;
    if (container.batch) {
      const result = await api(
        '/datasets/' +
          state.dataset_id +
          '/documents/' +
          encodeURIComponent(container.batch) +
          '/indexing-status',
      );
      const rows = Array.isArray(result?.data) ? result.data : [];
      const row =
        rows.find((item) => item.id === container.document_id) ?? rows[0];
      status = row?.indexing_status ?? row?.status ?? null;
      error = row?.error ?? null;
    }
    if (!status) {
      const result = await api(
        '/datasets/' + state.dataset_id + '/documents/' + container.document_id,
      );
      const document = result?.data ?? result;
      status = document?.indexing_status ?? null;
      error = document?.error ?? null;
    }
    container.status = status ?? 'unknown';
    await saveState();
    if (status === 'completed') return;
    if (status === 'error')
      throw new Error(
        'Container document indexing failed: ' + (error ?? 'unknown error'),
      );
    assert.ok(Date.now() < deadline, 'Container document indexing timed out.');
    await sleep(2000);
  }
}

async function cleanContainerDummy() {
  if (state.container_cleaned) return;
  const container = state.documents.container;
  const expectedDummies = dummyVariants();
  const segments = [];
  for await (const segment of listAllSegments()) {
    segments.push(segment);
    assert.ok(
      segments.length <= 1,
      'New text_model container has more than one initial segment; refusing to delete anything.',
    );
  }
  if (segments.length === 1) {
    assert.ok(
      expectedDummies.includes(segments[0].content),
      'Container has a non-dummy segment; refusing to delete it.',
    );
    container.dummy_observed_sha256 = digest(segments[0].content);
    container.dummy_was_normalized = segments[0].content !== expectedDummies[0];
    await saveState();
    try {
      await api(
        '/datasets/' +
          state.dataset_id +
          '/documents/' +
          container.document_id +
          '/segments/' +
          segments[0].id,
        'DELETE',
        undefined,
        CREATE_TIMEOUT_MS,
      );
    } catch (error) {
      state.status = 'dummy-delete-result-unknown';
      await saveState();
      for (let attempt = 0; attempt < PENDING_RESOLVE_ATTEMPTS; attempt++) {
        if ((await getRemoteSegmentTotal()) === 0) break;
        await sleep(PENDING_RESOLVE_DELAY_MS);
      }
      if ((await getRemoteSegmentTotal()) !== 0) throw error;
    }
  }
  assert.equal(
    await getRemoteSegmentTotal(),
    0,
    'Container dummy segment was not removed before fixed-unit insertion.',
  );
  state.container_cleaned = true;
  container.status = 'ready';
  state.status = 'container-ready';
  await saveState();
}

async function reconcileCheckpoint() {
  const container = state.documents.container;
  assert.ok(container?.document_id && state.container_cleaned);
  if (!state.pending_batch) {
    const count = await getRemoteSegmentTotal();
    assert.equal(
      count,
      state.committed_units,
      'Remote segment count differs from the saved checkpoint; refusing to append.',
    );
    return;
  }
  const pending = state.pending_batch;
  assert.equal(pending.start, state.committed_units);
  const end = pending.start + pending.count;
  for (let attempt = 0; attempt < PENDING_RESOLVE_ATTEMPTS; attempt++) {
    const count = await getRemoteSegmentTotal();
    if (count === end) {
      await verifyRemoteRange(pending.start, pending.count);
      state.committed_units = end;
      state.pending_batch = null;
      state.status = 'batch-reconciled';
      state.last_reconciled_at = new Date().toISOString();
      await saveState();
      return;
    }
    if (count !== pending.start)
      throw new Error(
        'Pending batch has a partial or unexpected remote result; refusing to retry it.',
      );
    await sleep(PENDING_RESOLVE_DELAY_MS);
  }
  state.status = 'write-result-unknown';
  await saveState();
  throw new Error(
    'Pending write is not visible remotely; stopped without resending the batch.',
  );
}

async function getRemoteSegmentTotal() {
  const result = await api(
    '/datasets/' +
      state.dataset_id +
      '/documents/' +
      state.documents.container.document_id +
      '/segments?limit=1&page=1',
  );
  assert.ok(
    Number.isInteger(result?.total),
    'Dify segment list omitted total.',
  );
  return result.total;
}

async function getSegmentPage(page) {
  return api(
    '/datasets/' +
      state.dataset_id +
      '/documents/' +
      state.documents.container.document_id +
      '/segments?limit=' +
      PAGE_SIZE +
      '&page=' +
      page,
  );
}

async function* listAllSegments() {
  for (let page = 1; ; page++) {
    const result = await getSegmentPage(page);
    const rows = Array.isArray(result?.data) ? result.data : [];
    yield* rows;
    if (!result.has_more || rows.length === 0) return;
  }
}

async function verifyRemoteRange(start, count) {
  const end = start + count;
  const sourceRows = await readSourceRange(start, count);
  const firstPage = Math.floor(start / PAGE_SIZE) + 1;
  const lastPage = Math.floor((end - 1) / PAGE_SIZE) + 1;
  const byPosition = new Map();
  for (let page = firstPage; page <= lastPage; page++) {
    const result = await getSegmentPage(page);
    for (const segment of result.data ?? [])
      byPosition.set(segment.position, segment);
  }
  for (let offset = start; offset < end; offset++) {
    const segment = byPosition.get(offset + 1);
    assert.ok(
      segment,
      'Pending batch segment missing at position ' + (offset + 1),
    );
    assertSegmentMatches(segment, sourceRows[offset - start], offset);
  }
}

async function readSourceRange(start, count) {
  const result = [];
  let offset = 0;
  for await (const row of jsonLines(corpusPath)) {
    if (offset >= start && offset < start + count) result.push(row);
    offset++;
    if (offset >= start + count) break;
  }
  assert.equal(
    result.length,
    count,
    'Could not read the pending source batch.',
  );
  return result;
}

function assertSegmentMatches(segment, source, offset) {
  const unitId = String(source.id ?? source._id ?? '');
  const textSha256 = digest(source.text);
  assert.equal(segment.position, offset + 1, 'Dify segment position changed.');
  assert.equal(
    segment.content,
    source.text,
    'Dify changed fixed-unit text: ' + unitId,
  );
  assert.equal(
    digest(segment.content),
    textSha256,
    'Dify segment text hash mismatch: ' + unitId,
  );
  assert.equal(
    segment.status,
    'completed',
    'Dify segment indexing is not completed: ' + unitId,
  );
  assert.equal(segment.enabled, true, 'Dify segment is disabled: ' + unitId);
  assert.ok(
    segment.index_node_id,
    'Dify segment has no index node ID: ' + unitId,
  );
  assert.ok(
    segment.index_node_hash,
    'Dify segment has no index node hash: ' + unitId,
  );
}

async function indexRemainingUnits() {
  let offset = 0;
  let batch = [];
  const started = performance.now();
  async function sendBatch(rows, batchStart) {
    const pending = {
      start: batchStart,
      count: rows.length,
      status: 'submitting',
      started_at: new Date().toISOString(),
    };
    state.pending_batch = pending;
    state.status = 'indexing';
    await saveState();
    const batchStarted = performance.now();
    try {
      const result = await api(
        '/datasets/' +
          state.dataset_id +
          '/documents/' +
          state.documents.container.document_id +
          '/segments',
        'POST',
        {
          segments: rows.map((row) => ({ content: row.text })),
        },
        CREATE_TIMEOUT_MS,
      );
      const created = Array.isArray(result?.data) ? result.data : [];
      assert.equal(
        created.length,
        rows.length,
        'Dify segment create response count differs from the requested batch.',
      );
      const createdIds = new Set();
      for (let index = 0; index < rows.length; index++) {
        await assertSegmentMatches(
          created[index],
          rows[index],
          batchStart + index,
        );
        assert.ok(
          !createdIds.has(created[index].id),
          'Dify repeated a segment ID in a batch.',
        );
        createdIds.add(created[index].id);
      }
      state.committed_units = batchStart + rows.length;
      state.pending_batch = null;
      state.status = 'indexing';
      state.last_batch = {
        start: batchStart,
        count: rows.length,
        elapsed_ms: Math.round(performance.now() - batchStarted),
        completed_at: new Date().toISOString(),
      };
      await saveState();
      console.log(
        JSON.stringify({
          scope,
          committed: state.committed_units,
          total: expectedCount,
          batch_size: rows.length,
          batch_elapsed_ms: state.last_batch.elapsed_ms,
          elapsed_ms: Math.round(performance.now() - started),
        }),
      );
    } catch (error) {
      state.committed_units = batchStart;
      pending.status = 'unknown';
      pending.last_error = safeError(error);
      state.pending_batch = pending;
      state.status = 'write-result-unknown';
      await saveState();
      await reconcileCheckpoint();
    }
  }

  for await (const row of jsonLines(corpusPath)) {
    if (offset < state.committed_units) {
      offset++;
      continue;
    }
    batch.push(row);
    offset++;
    if (batch.length === BATCH_SIZE) {
      await sendBatch(batch, offset - batch.length);
      batch = [];
    }
  }
  if (batch.length) await sendBatch(batch, expectedCount - batch.length);
  assert.equal(state.committed_units, expectedCount);
  assert.equal(state.pending_batch, null);
  state.status = 'segments-submitted';
  await saveState();
}

// Avoid 1,000 offset/count API scans when validating a completed 100k-unit import.
// Source rows and every segment field still pass the same exact assertions.
async function* streamStoredSegments() {
  const dataset = state.dataset_id;
  const document = state.documents.container.document_id;
  for (const id of [dataset, document])
    assert.match(id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  const sql =
    "BEGIN READ ONLY; SELECT replace(encode(convert_to(json_build_object('id',id,'position',position,'content',content,'index_node_id',index_node_id,'index_node_hash',index_node_hash,'enabled',enabled,'status',status)::text,'UTF8'),'base64'),chr(10),'') FROM document_segments WHERE dataset_id='" +
    dataset +
    "' AND document_id='" +
    document +
    "' ORDER BY position; COMMIT;";
  const child = spawn(
    'docker',
    [
      'exec',
      'echo-compare-dify-db_postgres-1',
      'psql',
      '-X',
      '-q',
      '-U',
      'postgres',
      '-d',
      'dify',
      '-Atc',
      sql,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (part) => {
    stderr = (stderr + part.toString()).slice(-1000);
  });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  let count = 0;
  try {
    for await (const line of readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
      } catch {
        throw new Error('Invalid framed segment row at index ' + count);
      }
      count++;
      yield row;
    }
    assert.equal(await exited, 0, 'Read-only segment audit failed: ' + stderr);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

async function auditAllSegments({ writeMap }) {
  const mapFile = path.join(out, 'segment-map.jsonl');
  const temporary = mapFile + '.' + process.pid + '.' + Date.now() + '.tmp';
  const handle = writeMap ? await fs.open(temporary, 'wx') : null;
  const source = jsonLines(corpusPath)[Symbol.asyncIterator]();
  const segmentIds = new Set();
  const indexNodeIds = new Set();
  const smokeSegmentIds = {};
  let count = 0;
  let contentHashMatches = 0;
  let vectorReady = 0;
  try {
    const remote =
      mode === '--smoke' ? listAllSegments() : streamStoredSegments();
    for await (const segment of remote) {
      const next = await source.next();
      assert.ok(
        !next.done,
        'Dify contains more segments than the frozen corpus.',
      );
      const row = next.value;
      const unitId = String(row.id ?? row._id ?? '');
      await assertSegmentMatches(segment, row, count);
      assert.ok(!segmentIds.has(segment.id), 'Dify repeated a segment ID.');
      assert.ok(
        !indexNodeIds.has(segment.index_node_id),
        'Dify repeated an index node ID.',
      );
      segmentIds.add(segment.id);
      indexNodeIds.add(segment.index_node_id);
      contentHashMatches++;
      vectorReady++;
      if (mode === '--smoke') smokeSegmentIds[unitId] = segment.id;
      if (handle)
        await handle.write(
          JSON.stringify({
            segment_id: segment.id,
            unit_id: unitId,
            text_sha256: digest(row.text),
          }) + '\n',
        );
      count++;
    }
    const extra = await source.next();
    assert.ok(
      extra.done,
      'Frozen corpus contains more units than Dify segments.',
    );
    assert.equal(
      count,
      expectedCount,
      'Dify segment count differs from fixed corpus count.',
    );
    assert.equal(
      segmentIds.size,
      expectedCount,
      'Dify segment IDs are not one-to-one.',
    );
    assert.equal(
      indexNodeIds.size,
      expectedCount,
      'Dify index node IDs are not one-to-one.',
    );
    if (handle) {
      await handle.sync();
      await handle.close();
      await fs.rename(temporary, mapFile);
    }
    return {
      count,
      contentHashMatches,
      vectorReady,
      uniqueSegmentIds: segmentIds.size,
      uniqueIndexNodeIds: indexNodeIds.size,
      smokeSegmentIds,
    };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    throw error;
  }
}

async function runSmokeVectorProbe(expectedByUnitId) {
  assert.ok(smokeRows, 'Synthetic smoke rows were not prepared.');
  const queries = [
    {
      kind: 'one-character-chinese',
      text: smokeRows[0].text,
      expected: [smokeRows[0].id],
    },
    {
      kind: 'same-text-distinct-ids',
      text: smokeRows[1].text,
      expected: [smokeRows[1].id, smokeRows[2].id],
    },
  ];
  const retrievalModel = {
    ...freeze.dify.retrieval_model,
    search_method: 'semantic_search',
    reranking_enable: false,
    top_k: 10,
    score_threshold_enabled: false,
  };
  const receipts = [];
  const hitUnits = new Set();
  for (const probe of queries) {
    const result = await api(
      '/datasets/' + state.dataset_id + '/retrieve',
      'POST',
      { query: probe.text, retrieval_model: retrievalModel },
      CREATE_TIMEOUT_MS,
    );
    const records = Array.isArray(result?.records) ? result.records : [];
    const segmentIds = records
      .map((record) => record.segment?.id)
      .filter(Boolean);
    for (const unitId of probe.expected) {
      const expectedSegmentId = expectedByUnitId[unitId];
      assert.ok(
        expectedSegmentId,
        'Smoke audit omitted a synthetic unit mapping.',
      );
      if (segmentIds.includes(expectedSegmentId)) hitUnits.add(unitId);
    }
    receipts.push({
      kind: probe.kind,
      query_sha256: digest(probe.text),
      expected_unit_ids: probe.expected,
      returned_segment_ids: segmentIds,
      returned_count: segmentIds.length,
    });
  }
  assert.equal(
    hitUnits.size,
    smokeRows.length,
    'Synthetic vector retrieval did not return every fixed segment ID.',
  );
  return {
    method: 'semantic_search',
    verified_unit_ids: [...hitUnits],
    unique_segments_retrieved: hitUnits.size,
    expected_segments: smokeRows.length,
    queries: receipts,
  };
}
