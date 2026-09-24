import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const isRuntimeModule =
  path.basename(moduleRoot).toLowerCase() === 'dify-runtime';
function requestedComparisonRoot(argv) {
  const index = argv.indexOf('--root');
  if (index >= 0) return argv[index + 1] || null;
  return process.env.DIFY_COMPARISON_ROOT || null;
}
const requestedRoot = requestedComparisonRoot(process.argv.slice(2));
const inferredRoot = isRuntimeModule ? path.dirname(moduleRoot) : null;
const comparisonRoot = requestedRoot
  ? path.resolve(requestedRoot)
  : inferredRoot;
const runtimeRoot = comparisonRoot
  ? path.join(comparisonRoot, 'dify-runtime')
  : path.join(moduleRoot, '.root-required', 'dify-runtime');
const echoRoot = [
  path.resolve(moduleRoot, '..'),
  path.resolve(process.cwd()),
].find((root) =>
  existsSync(path.join(root, 'evals', 'lib', 'product-evidence.mjs')),
);
if (!echoRoot)
  throw new Error('Echo evals/lib/product-evidence.mjs is unavailable');
const authFile = [
  path.join(moduleRoot, 'dify-auth.mjs'),
  path.join(moduleRoot, 'lib', 'dify-auth.mjs'),
].find(existsSync);
if (!authFile)
  throw new Error('Dify auth helper is unavailable beside this adapter');
const { loadDifySession } = await import(pathToFileURL(authFile).href);
const { verifyRuntimeImages } = await import(
  pathToFileURL(path.join(echoRoot, 'evals/lib/product-freeze.mjs')).href
);
const { readJsonl } = await import(
  pathToFileURL(path.join(echoRoot, 'evals/lib/product-jsonl.mjs')).href
);
const { validateIndexReceipt } = await import(
  pathToFileURL(path.join(echoRoot, 'evals/lib/product-index-receipt.mjs')).href
);
const { packProductEvidence } = await import(
  pathToFileURL(path.join(echoRoot, 'evals', 'lib', 'product-evidence.mjs'))
    .href
);
const corpusRoot = path.join(comparisonRoot || runtimeRoot, 'corpus-v1');
const indexRoot = path.join(comparisonRoot || runtimeRoot, 'indexes', 'dify');
const manifestFile = path.join(corpusRoot, 'manifest.json');
const indexFreezeFile = path.join(
  comparisonRoot || runtimeRoot,
  'index-freeze.json',
);
const defaultFreezeFile = path.join(
  comparisonRoot || runtimeRoot,
  'freeze.json',
);
const sessionFile = path.join(runtimeRoot, 'private-session.json');
const probePrivateFile = path.join(runtimeRoot, 'workflow-probe-private.json');
const outputRoot = path.join(comparisonRoot || runtimeRoot, 'runs', 'dify');
const nativeRoot = path.join(runtimeRoot, 'runs', 'dify', 'native');
const journalRoot = path.join(runtimeRoot, 'query-state');
const privateWorkflowRoot = path.join(runtimeRoot, 'private', 'workflows');
const provider = 'langgenius/openai_api_compatible/openai_api_compatible';
const embeddingModel = 'qwen3.7-text-embedding';
const difyVersion = '1.17.1';
const difyCommit = '8387590ace4a094de812b7847fc6a4c3a27cd52b';
const fixedReturnLimit = 60;
const queryMaxLength = 20000;
const packing = { topk: 10, source_cap: 6, max_context_chars: 20000 };
const requestTimeoutMs = 300000;

function parseArgs(argv) {
  const result = {
    scope: null,
    live: false,
    probe: false,
    selfTest: false,
    freezeFile: defaultFreezeFile,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--root') result.root = argv[++index] || null;
    else if (item === '--scope') result.scope = argv[++index] || null;
    else if (item === '--live') result.live = true;
    else if (item === '--probe') result.probe = true;
    else if (item === '--self-test') result.selfTest = true;
    else if (item === '--freeze-file')
      result.freezeFile = path.resolve(argv[++index] || '');
    else if (item === '--help' || item === '-h') result.help = true;
    else throw new Error('unknown argument: ' + item);
  }
  if (result.probe && (result.live || result.scope)) {
    throw new Error('--probe uses the existing isolated workflow only');
  }
  if (result.selfTest && (result.live || result.probe || result.scope)) {
    throw new Error(
      '--self-test is offline and takes no scope or live options',
    );
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));

function usage() {
  return [
    'Dify native workflow query adapter.',
    '  --root <comparison-root> sets the isolated product comparison directory.',
    '  node product-dify-query.mjs --root <comparison-root> show manifest/index plan',
    '  node product-dify-query.mjs --root <comparison-root> --scope qasper inspect one scope',
    '  node product-dify-query.mjs --root <comparison-root> --probe one synthetic isolated workflow probe',
    '  node product-dify-query.mjs --self-test      validate packing/mapping in memory',
    '  node product-dify-query.mjs --root <comparison-root> --scope qasper --live --freeze-file <root freeze.json>',
    'A live scope runs every manifest parent question and has no partial-limit option.',
  ].join('\n');
}

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hashJson = (value) => hash(JSON.stringify(value));
const hashFile = async (file) => hash(await fs.readFile(file));
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

function safeScope(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('scope contains unsupported characters');
  }
  return value;
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(temporary, JSON.stringify(value) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporary, file);
}

async function appendJsonLineDurable(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, 'a', 0o600);
  try {
    await handle.write(JSON.stringify(value) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function resolveCorpusFile(file) {
  const resolved = path.resolve(file);
  const root = path.resolve(corpusRoot).toLowerCase();
  const candidate = resolved.toLowerCase();
  if (
    candidate !== root &&
    !candidate.startsWith(root + path.sep.toLowerCase())
  ) {
    throw new Error('manifest path escapes corpus-v1');
  }
  return resolved;
}

async function loadManifest() {
  const bytes = await fs.readFile(manifestFile);
  return {
    bytes,
    sha256: hash(bytes),
    value: JSON.parse(bytes.toString('utf8')),
  };
}

function scopeInfo(manifest, scope) {
  const info = manifest.scopes?.[scope];
  if (!info?.corpus?.path || !info?.queries?.path) {
    throw new Error('manifest has no complete entry for scope ' + scope);
  }
  return {
    ...info,
    corpusFile: resolveCorpusFile(info.corpus.path),
    queryFile: resolveCorpusFile(info.queries.path),
  };
}

function isFixedScope(info) {
  return info.kind === 'official-fixed-unit';
}

function metadataFieldName(state) {
  const field = state.metadata_field ?? state.metadataField;
  const name = typeof field === 'string' ? field : field?.name;
  if (name && name !== 'scope')
    throw new Error('QASPER metadata field must be scope');
  return name || 'scope';
}

function normalizeDocuments(state) {
  const raw = state.documents;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Dify index state documents must be keyed by source_id');
  }
  const bySource = new Map();
  const byDocument = new Map();
  for (const [key, value] of Object.entries(raw)) {
    const sourceId = String(value?.source_id ?? key);
    const documentId = String(value?.document_id ?? value?.documentId ?? '');
    const relativePath = String(value?.relative_path ?? value?.path ?? '');
    const textSha256 = value?.text_sha256 ?? value?.source_text_sha256 ?? null;
    if (
      !sourceId ||
      sourceId !== key ||
      !documentId ||
      byDocument.has(documentId)
    ) {
      throw new Error(
        'invalid or duplicate source/document mapping in Dify state',
      );
    }
    const row = {
      source_id: sourceId,
      document_id: documentId,
      path: relativePath,
      text_sha256: textSha256,
      status: value?.status ?? null,
    };
    bySource.set(sourceId, row);
    byDocument.set(documentId, row);
  }
  return { bySource, byDocument };
}

async function loadQueryRows(file) {
  const rows = [];
  const ids = new Set();
  for await (const row of readJsonl(file)) {
    if (!row || row.id === undefined || typeof row.text !== 'string') {
      throw new Error('query row must contain id and text');
    }
    const id = String(row.id);
    if (!id || ids.has(id)) throw new Error('duplicate or empty question id');
    ids.add(id);
    const queries =
      Array.isArray(row.queries) && row.queries.length
        ? row.queries.map((query, index) => ({
            id: String(query?.id ?? 'q' + index),
            text: String(query?.text ?? ''),
          }))
        : [{ id: 'q0', text: row.text }];
    const queryIds = new Set();
    for (const query of queries) {
      if (!query.id || queryIds.has(query.id) || !query.text) {
        throw new Error('question contains an empty or duplicate query input');
      }
      if (query.text.length > queryMaxLength) {
        throw new Error(
          'query exceeds Dify input limit; no truncation is allowed',
        );
      }
      queryIds.add(query.id);
    }
    rows.push({
      id,
      text: row.text,
      queries,
      source_id: row.source_id == null ? null : String(row.source_id),
    });
  }
  return rows;
}

async function loadCorpusMap(info) {
  const byId = new Map();
  for await (const row of readJsonl(info.corpusFile)) {
    const id = String(row?.id ?? row?.source_id ?? row?.unit_id ?? '');
    const text =
      typeof row?.text === 'string'
        ? row.text
        : typeof row?.content === 'string'
          ? row.content
          : null;
    if (!id || text === null || byId.has(id)) {
      throw new Error('corpus row has a missing or duplicate id/text');
    }
    byId.set(id, {
      id,
      text_sha256: String(row.text_sha256 ?? hash(text)),
      path: String(row.relative_path ?? row.path ?? ''),
    });
  }
  if (Number.isInteger(info.documents) && byId.size !== info.documents) {
    throw new Error('corpus source count differs from manifest');
  }
  return byId;
}

async function loadIndexState(scope, info, corpusMap) {
  const file = path.join(indexRoot, scope, 'state.json');
  if (!(await fileExists(file)))
    throw new Error('missing Dify index state for ' + scope);
  const raw = await readJson(file);
  if (raw.scope && raw.scope !== scope)
    throw new Error('Dify index state scope mismatch');
  if (raw.corpus_sha256 !== info.corpus.sha256)
    throw new Error('Dify index state corpus hash mismatch');
  if (
    ![
      'indexed-awaiting-final-audit',
      'indexed',
      'complete',
      'completed',
      'frozen',
    ].includes(raw.status)
  ) {
    throw new Error('Dify index state is not complete for querying');
  }
  const documents = normalizeDocuments(raw);
  if (documents.bySource.size !== corpusMap.size) {
    throw new Error('Dify state does not cover every corpus source');
  }
  for (const [sourceId, source] of corpusMap) {
    const entry = documents.bySource.get(sourceId);
    if (!entry || entry.status !== 'verified')
      throw new Error('Dify state lacks a verified source mapping');
    if (entry.text_sha256 && entry.text_sha256 !== source.text_sha256) {
      throw new Error('Dify source text hash differs from corpus');
    }
    if (entry.path && source.path && entry.path !== source.path) {
      throw new Error('Dify source path differs from corpus');
    }
  }
  if (!raw.dataset_id) throw new Error('Dify index state has no dataset_id');
  return {
    file,
    sha256: await hashFile(file),
    raw,
    datasetId: String(raw.dataset_id),
    documents,
  };
}

async function loadFixedSegmentMap(scope, corpusMap, indexState) {
  const file = path.join(indexRoot, scope, 'segment-map.jsonl');
  if (!(await fileExists(file)))
    throw new Error(
      'fixed scope requires indexes/dify/' + scope + '/segment-map.jsonl',
    );
  const bySegment = new Map();
  const byUnit = new Map();
  for await (const row of readJsonl(file)) {
    const segmentId = String(row.segment_id ?? '');
    const unitId = String(row.unit_id ?? '');
    const textSha256 = String(row.text_sha256 ?? '');
    if (!segmentId || !unitId || !/^[a-f0-9]{64}$/i.test(textSha256)) {
      throw new Error('invalid fixed-unit segment map row');
    }
    if (bySegment.has(segmentId) || byUnit.has(unitId)) {
      throw new Error('fixed-unit segment map must be one-to-one');
    }
    const source = corpusMap.get(unitId);
    if (!source || !indexState.documents.bySource.has(unitId)) {
      throw new Error('fixed-unit map references an unknown official id');
    }
    if (textSha256 !== source.text_sha256) {
      throw new Error('fixed-unit map text hash differs from official corpus');
    }
    bySegment.set(segmentId, {
      segment_id: segmentId,
      unit_id: unitId,
      text_sha256: textSha256,
    });
    byUnit.set(unitId, segmentId);
  }
  if (byUnit.size !== corpusMap.size)
    throw new Error('fixed-unit map does not cover all official units');
  return { file, sha256: await hashFile(file), bySegment, byUnit };
}

function resolveExecutionFile(fileValue) {
  if (path.isAbsolute(fileValue)) return path.resolve(fileValue);
  const candidates = [
    path.resolve(comparisonRoot, fileValue),
    path.resolve(echoRoot, fileValue),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

async function validateExecutionFiles(freeze) {
  if (
    !Array.isArray(freeze.execution_files) ||
    !freeze.execution_files.length
  ) {
    throw new Error(
      'receipt must pin execution_files as {path,sha256} entries',
    );
  }
  const resolved = new Map();
  for (const item of freeze.execution_files) {
    if (
      typeof item?.path !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(String(item?.sha256 ?? ''))
    ) {
      throw new Error('invalid freeze execution_files entry');
    }
    const file = resolveExecutionFile(item.path);
    if (!(await fileExists(file)))
      throw new Error('missing frozen execution file: ' + item.path);
    const actual = await hashFile(file);
    if (actual !== String(item.sha256).toLowerCase()) {
      throw new Error('frozen execution file hash mismatch: ' + item.path);
    }
    resolved.set(path.resolve(file).toLowerCase(), { file, sha256: actual });
  }
  return resolved;
}

function requirePinnedFile(file, pinned, label) {
  if (!pinned.has(path.resolve(file).toLowerCase())) {
    throw new Error('freeze.json does not pin ' + label);
  }
}

async function loadScopeIndexReceipt(
  scope,
  info,
  indexState,
  fixedMap,
  corpusMap,
) {
  const indexParameters = await readJson(indexFreezeFile);
  await validateIndexReceipt({
    root: comparisonRoot,
    product: 'dify',
    scope,
    info,
    modelFingerprint: indexParameters.model.fingerprint,
  });
  const file = path.join(indexRoot, scope, 'query-index-receipt.json');
  if (!(await fileExists(file))) {
    throw new Error('scope query-index-receipt.json is missing for ' + scope);
  }
  const bytes = await fs.readFile(file);
  const receipt = JSON.parse(bytes.toString('utf8'));
  if (
    receipt.status !== 'frozen' ||
    receipt.scope !== scope ||
    receipt.corpus_sha256 !== info.corpus.sha256
  ) {
    throw new Error(
      'scope query-index receipt is not frozen for these corpus inputs',
    );
  }
  const pins = await validateExecutionFiles(receipt);
  requirePinnedFile(indexState.file, pins, 'scope state.json');
  if (fixedMap) {
    requirePinnedFile(fixedMap.file, pins, 'fixed segment-map.jsonl');
  } else {
    for (const sourceId of corpusMap.keys()) {
      const segmentsFile = path.join(
        indexRoot,
        scope,
        sourceId + '.segments.json',
      );
      if (!(await fileExists(segmentsFile)))
        throw new Error('missing full-document segment mapping file');
      requirePinnedFile(
        segmentsFile,
        pins,
        'full-document segment mapping file',
      );
    }
  }
  return { file, sha256: hash(bytes), receipt, pins };
}
async function validateFreeze(
  freezeFile,
  manifest,
  info,
  scope,
  indexState,
  fixedMap,
  scopeReceipt,
) {
  if (!(await fileExists(freezeFile)))
    throw new Error('formal Dify query requires root freeze.json');
  const freezeBytes = await fs.readFile(freezeFile);
  const freeze = JSON.parse(freezeBytes.toString('utf8'));
  await verifyRuntimeImages(freeze.runtime_images, 'dify');
  if (freeze.status !== 'frozen')
    throw new Error('root freeze.json status must be frozen');
  if (freeze.corpus_manifest_sha256 !== manifest.sha256)
    throw new Error('root freeze manifest hash mismatch');
  assert.deepEqual(
    freeze.packing,
    packing,
    'root freeze packing conditions mismatch',
  );

  const indexFreeze = await readJson(indexFreezeFile);
  if (
    indexFreeze.status !== 'index-inputs-frozen' ||
    indexFreeze.corpus_manifest_sha256 !== manifest.sha256
  ) {
    throw new Error('Dify index freeze is stale or bound to another manifest');
  }
  const condition = freeze.conditions?.dify ?? freeze.dify;
  if (!condition || condition.fixed_return_limit !== fixedReturnLimit) {
    throw new Error('root freeze must pin the Dify top-60 return limit');
  }
  for (const key of [
    'version',
    'commit',
    'provider',
    'model',
    'process_rule',
    'retrieval_model',
  ]) {
    assert.deepEqual(
      condition[key],
      indexFreeze.dify?.[key],
      'root freeze Dify condition mismatch: ' + key,
    );
  }
  assert.equal(condition.version, difyVersion);
  assert.equal(condition.commit, difyCommit);
  assert.equal(condition.provider, provider);
  assert.equal(condition.model, embeddingModel);
  assert.equal(condition.retrieval_model?.top_k, fixedReturnLimit);
  assert.equal(
    condition.retrieval_model?.weights?.vector_setting?.vector_weight,
    0.7,
  );
  assert.equal(
    condition.retrieval_model?.weights?.keyword_setting?.keyword_weight,
    0.3,
  );
  assert.equal(condition.retrieval_model?.reranking_enable, false);

  if (hash(await fs.readFile(info.corpusFile)) !== info.corpus.sha256) {
    throw new Error('scope corpus hash differs from corpus-v1/manifest.json');
  }
  if (hash(await fs.readFile(info.queryFile)) !== info.queries.sha256) {
    throw new Error('scope query hash differs from corpus-v1/manifest.json');
  }
  if (indexState.raw.corpus_sha256 !== info.corpus.sha256) {
    throw new Error('Dify index state is not bound to this scope corpus');
  }

  const pinned = await validateExecutionFiles(freeze);
  requirePinnedFile(manifestFile, pinned, 'corpus-v1/manifest.json');
  requirePinnedFile(indexFreezeFile, pinned, 'index-freeze.json');

  requirePinnedFile(
    path.join(moduleRoot, 'product-dify-query.mjs'),
    pinned,
    'product-dify-query.mjs',
  );
  requirePinnedFile(authFile, pinned, 'dify-auth.mjs');
  requirePinnedFile(
    path.join(echoRoot, 'evals', 'lib', 'product-evidence.mjs'),
    pinned,
    'evals/lib/product-evidence.mjs',
  );
  if (
    fixedMap &&
    indexState.raw.segment_map_sha256 &&
    indexState.raw.segment_map_sha256 !== fixedMap.sha256
  ) {
    throw new Error('Dify state segment-map hash mismatch');
  }
  return { freeze, sha256: hash(freezeBytes), pinned, scopeReceipt };
}

async function validateNativeDataset(indexState, expected) {
  const { session } = await loadDifySession({ sessionFile });
  assert.ok(session.service_api_key);
  const base = (process.env.DIFY_BASE_URL || 'http://localhost:15101').replace(
    /\/+$/,
    '',
  );
  const response = await fetch(base + '/v1/datasets/' + indexState.datasetId, {
    headers: { Authorization: 'Bearer ' + session.service_api_key },
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(
    response.ok,
    'Native dataset configuration read failed: ' + response.status,
  );
  const native = await response.json();
  assert.equal(native.indexing_technique, 'high_quality');
  assert.equal(native.embedding_model, expected.model);
  assert.equal(native.embedding_model_provider, expected.provider);
  assert.equal(native.embedding_available, true);
  const credential = unwrap(
    await consoleRequest(
      session,
      '/workspaces/current/model-providers/' +
        provider +
        '/models/credentials?model=' +
        encodeURIComponent(embeddingModel) +
        '&model_type=text-embedding',
    ),
  );
  assert.equal(
    credential.load_balancing?.enabled,
    false,
    'Model load balancing must remain disabled',
  );
  const providerTransport = Object.fromEntries(
    ['endpoint_url', 'max_chunks', 'context_size', 'encoding_format'].map(
      (key) => [key, String(credential.credentials?.[key])],
    ),
  );
  assert.deepEqual(
    providerTransport,
    {
      endpoint_url: 'http://host.docker.internal:15109/v1',
      max_chunks: '8',
      context_size: '32768',
      encoding_format: 'float',
    },
    'Native model transport differs from audited gateway',
  );
  const actual = {};
  for (const [key, value] of Object.entries(expected.retrieval_model)) {
    assert.deepEqual(
      native.retrieval_model_dict?.[key],
      value,
      'Native dataset retrieval setting differs from freeze: ' + key,
    );
    actual[key] = native.retrieval_model_dict[key];
  }
  return {
    dataset_id: indexState.datasetId,
    indexing_technique: native.indexing_technique,
    embedding_model: native.embedding_model,
    embedding_model_provider: native.embedding_model_provider,
    retrieval_model: native.retrieval_model_dict,
    provider_transport: providerTransport,
  };
}

function workflowGraph(datasetId, useMetadata, fieldName) {
  const variables = [
    {
      variable: 'query',
      label: 'query',
      type: 'paragraph',
      required: true,
      max_length: queryMaxLength,
    },
  ];
  if (useMetadata) {
    variables.push({
      variable: 'source_id',
      label: 'source_id',
      type: 'paragraph',
      required: true,
      max_length: 512,
    });
  }
  const knowledge = {
    title: 'Knowledge Retrieval',
    type: 'knowledge-retrieval',
    dataset_ids: [datasetId],
    retrieval_mode: 'multiple',
    query_variable_selector: ['start', 'query'],
    multiple_retrieval_config: {
      top_k: fixedReturnLimit,
      score_threshold: 0,
      reranking_mode: 'weighted_score',
      reranking_enable: false,
      weights: {
        weight_type: 'customized',
        vector_setting: {
          vector_weight: 0.7,
          embedding_provider_name: provider,
          embedding_model_name: embeddingModel,
        },
        keyword_setting: { keyword_weight: 0.3 },
      },
    },
  };
  if (useMetadata) {
    knowledge.metadata_filtering_mode = 'manual';
    knowledge.metadata_filtering_conditions = {
      logical_operator: 'and',
      conditions: [
        {
          name: fieldName,
          comparison_operator: 'is',
          value: '{{#start.source_id#}}',
        },
      ],
    };
  } else {
    knowledge.metadata_filtering_mode = 'disabled';
  }
  return {
    nodes: [
      {
        id: 'start',
        type: 'custom',
        position: { x: 80, y: 200 },
        data: { title: 'Start', type: 'start', variables },
      },
      {
        id: 'knowledge',
        type: 'custom',
        position: { x: 420, y: 200 },
        data: knowledge,
      },
      {
        id: 'end',
        type: 'custom',
        position: { x: 780, y: 200 },
        data: {
          title: 'End',
          type: 'end',
          outputs: [
            { variable: 'result', value_selector: ['knowledge', 'result'] },
          ],
        },
      },
    ],
    edges: [
      {
        id: 'edge-start-knowledge',
        source: 'start',
        target: 'knowledge',
        type: 'custom',
      },
      {
        id: 'edge-knowledge-end',
        source: 'knowledge',
        target: 'end',
        type: 'custom',
      },
    ],
    viewport: { x: 0, y: 0, zoom: 0.7 },
  };
}

function cookies(session) {
  return (session.cookies || [])
    .map((item) => item.name + '=' + item.value)
    .join('; ');
}

function csrfHeaders(session) {
  const item = (session.cookies || []).find(
    (cookie) => cookie.name === 'csrf_token',
  );
  return item ? { 'X-CSRF-Token': item.value } : {};
}

async function consoleRequest(session, route, method = 'GET', body) {
  const base = (
    process.env.DIFY_BASE_URL ||
    session.base_url ||
    'http://localhost:15101'
  ).replace(/\/+$/, '');
  let response;
  try {
    response = await fetch(base + '/console/api' + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies(session),
        ...csrfHeaders(session),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    throw new Error(
      'Dify console request returned no HTTP response: ' +
        String(error?.name || 'network error'),
    );
  }
  const text = await response.text();
  let value = null;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = null;
  }
  if (!response.ok) {
    const error = new Error(
      'Dify console HTTP ' + response.status + ' at ' + route,
    );
    error.code = value?.code;
    throw error;
  }
  return value;
}

function unwrap(value) {
  if (value && value.data && !value.id && !value.graph && !value.result)
    return value.data;
  return value;
}

function appList(value) {
  return Array.isArray(value)
    ? value
    : Array.isArray(value?.data)
      ? value.data
      : [];
}

async function findWorkflowApp(session, name) {
  const list = await consoleRequest(
    session,
    '/apps?mode=workflow&limit=100&page=1',
  );
  return appList(list).find((item) => item.name === name) ?? null;
}

async function createOrReuseApp(session, scope, localState) {
  const name = 'Echo Dify formal retrieval ' + scope;
  if (localState.app_id) return { id: localState.app_id, name };
  const existing = await findWorkflowApp(session, name);
  if (existing?.id) {
    localState.app_id = existing.id;
    localState.app_name = name;
    return { id: existing.id, name };
  }

  const intentFile = path.join(
    privateWorkflowRoot,
    scope + '.workflow-create-intent.json',
  );
  if (await fileExists(intentFile)) {
    throw new Error(
      'workflow creation outcome is uncertain; no POST retry will be attempted for ' +
        scope,
    );
  }
  await writeJsonAtomic(intentFile, {
    scope,
    app_name: name,
    status: 'create_pending',
    created_at: new Date().toISOString(),
  });
  let value;
  try {
    value = unwrap(
      await consoleRequest(session, '/apps', 'POST', {
        name,
        description:
          'Frozen retrieval-only workflow; no answer-generation node.',
        mode: 'workflow',
      }),
    );
  } catch (error) {
    await writeJsonAtomic(intentFile, {
      scope,
      app_name: name,
      status: 'create_uncertain',
      error_name: error?.name || 'request_error',
      updated_at: new Date().toISOString(),
    });
    throw error;
  }
  const id = value?.id || value?.app?.id;
  if (!id) {
    await writeJsonAtomic(intentFile, {
      scope,
      app_name: name,
      status: 'create_uncertain',
      updated_at: new Date().toISOString(),
    });
    throw new Error(
      'workflow creation POST returned no id; no retry will be attempted',
    );
  }
  await fs.rm(intentFile, { force: true });
  localState.app_id = id;
  localState.app_name = name;
  return { id, name };
}

async function getOrCreateWorkflowKey(session, scope, appId, localState) {
  if (localState.app_key) return localState.app_key;
  const intentFile = path.join(
    privateWorkflowRoot,
    scope + '.workflow-key-intent.json',
  );
  if (await fileExists(intentFile)) {
    throw new Error(
      'workflow app key creation outcome is uncertain; it is masked by Dify and will not be recreated',
    );
  }
  await writeJsonAtomic(intentFile, {
    scope,
    app_id: appId,
    status: 'key_create_pending',
    created_at: new Date().toISOString(),
  });
  let value;
  try {
    value = unwrap(
      await consoleRequest(session, '/apps/' + appId + '/api-keys', 'POST', {}),
    );
  } catch (error) {
    await writeJsonAtomic(intentFile, {
      scope,
      app_id: appId,
      status: 'key_create_uncertain',
      error_name: error?.name || 'request_error',
      updated_at: new Date().toISOString(),
    });
    throw error;
  }
  if (!value?.token) {
    await writeJsonAtomic(intentFile, {
      scope,
      app_id: appId,
      status: 'key_create_uncertain',
      updated_at: new Date().toISOString(),
    });
    throw new Error(
      'workflow app key response was masked or incomplete; no POST retry will be attempted',
    );
  }
  localState.app_key = value.token;
  await writeJsonAtomic(
    path.join(privateWorkflowRoot, scope + '.json'),
    localState,
  );
  await fs.rm(intentFile, { force: true });
  return localState.app_key;
}

async function syncWorkflow(session, appId, graph) {
  let draft = {};
  try {
    draft = unwrap(
      await consoleRequest(session, '/apps/' + appId + '/workflows/draft'),
    );
  } catch (error) {
    if (error.code !== 'draft_workflow_not_exist') throw error;
  }
  await consoleRequest(session, '/apps/' + appId + '/workflows/draft', 'POST', {
    graph,
    features: {},
    hash: draft?.hash ?? null,
    _is_collaborative: false,
    environment_variable_patch: {
      environment_variables: [],
      deleted_environment_variable_ids: [],
    },
    conversation_variables: [],
  });
  await consoleRequest(
    session,
    '/apps/' + appId + '/workflows/publish',
    'POST',
    {
      marked_name: 'frozen-retrieval',
      marked_comment: 'Query-only workflow; no answer-generation node.',
    },
  );
}

async function ensureWorkflow(scope, indexState, useMetadata) {
  const sessionResult = await loadDifySession({ sessionFile });
  const session = sessionResult.session;
  await fs.mkdir(privateWorkflowRoot, { recursive: true });
  const localFile = path.join(privateWorkflowRoot, scope + '.json');
  const localState = (await fileExists(localFile))
    ? await readJson(localFile)
    : {};
  const app = await createOrReuseApp(session, scope, localState);
  const fieldName = useMetadata ? metadataFieldName(indexState.raw) : null;
  const graph = workflowGraph(indexState.datasetId, useMetadata, fieldName);
  const graphHash = hashJson(graph);
  if (localState.graph_hash !== graphHash) {
    await syncWorkflow(session, app.id, graph);
    localState.graph_hash = graphHash;
    localState.graph = graph;
    localState.dataset_id = indexState.datasetId;
    localState.updated_at = new Date().toISOString();
    await writeJsonAtomic(localFile, localState);
  }
  const published = unwrap(
    await consoleRequest(session, '/apps/' + app.id + '/workflows/publish'),
  );
  assert.deepEqual(
    published.graph,
    graph,
    'Remote published workflow differs from frozen retrieval graph',
  );
  await writeJsonAtomic(
    path.join(journalRoot, scope + '.published-workflow.json'),
    {
      app_id: app.id,
      graph_hash: hashJson(published.graph),
      graph: published.graph,
    },
  );
  const appKey = await getOrCreateWorkflowKey(
    session,
    scope,
    app.id,
    localState,
  );
  localState.app_id = app.id;
  localState.app_name = app.name;
  localState.dataset_id = indexState.datasetId;
  localState.graph_hash = graphHash;
  await writeJsonAtomic(localFile, localState);
  return { appId: app.id, appKey, graph, graphHash };
}

function resultList(response) {
  const data = response?.data ?? response;
  const status = data?.status;
  if (status && status !== 'succeeded')
    throw new Error('Dify workflow status is not succeeded');
  const list = data?.outputs?.result;
  if (!Array.isArray(list))
    throw new Error('Dify workflow response has no outputs.result array');
  if (list.length > fixedReturnLimit)
    throw new Error('Dify returned more than the frozen top-60 limit');
  return list;
}

function normalizeFullResult(result, indexState) {
  const metadata = result?.metadata ?? {};
  const documentId = String(metadata.document_id ?? '');
  const source = indexState.documents.byDocument.get(documentId);
  if (!source)
    throw new Error('Dify result document_id has no source_id mapping');
  const metadataScope = metadata.doc_metadata?.scope;
  if (metadataScope != null && String(metadataScope) !== source.source_id) {
    throw new Error(
      'Dify result metadata scope differs from its source mapping',
    );
  }
  const text = typeof result?.content === 'string' ? result.content : null;
  if (text === null) throw new Error('Dify result content is not text');
  const nativeId = String(metadata.segment_id ?? '');
  if (!nativeId) throw new Error('Dify result has no native segment_id');
  const score = Number(metadata.score ?? result.score);
  if (!Number.isFinite(score))
    throw new Error('Dify result score is not finite');
  return {
    id: hashJson([source.source_id, text]).slice(0, 32),
    native_id: nativeId,
    document_id: documentId,
    source_id: source.source_id,
    path: source.path,
    text,
    score,
  };
}

function normalizeFixedResult(result, segmentMap) {
  const metadata = result?.metadata ?? {};
  const nativeId = String(metadata.segment_id ?? '');
  const mapped = segmentMap.bySegment.get(nativeId);
  if (!mapped)
    throw new Error('Dify fixed-unit segment_id has no official unit mapping');
  const score = Number(metadata.score ?? result.score);
  if (!Number.isFinite(score))
    throw new Error('Dify fixed-unit score is not finite');
  return { unit_id: mapped.unit_id, score };
}

function workflowRequestBody(question, query, scope, useMetadata) {
  const inputs = { query: query.text };
  if (useMetadata) {
    if (!question.source_id) throw new Error('QASPER question lacks source_id');
    inputs.source_id = question.source_id;
  }
  return {
    inputs,
    response_mode: 'blocking',
    user: 'echo-dify-frozen-' + scope,
  };
}

async function workflowHttp(workflow, body, timeoutMs = requestTimeoutMs) {
  const base = (process.env.DIFY_BASE_URL || 'http://localhost:15101').replace(
    /\/+$/,
    '',
  );
  const url = base + '/v1/workflows/run';
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + workflow.appKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      url,
      method: 'POST',
      request_headers: {
        'Content-Type': 'application/json',
        Authorization: '[REDACTED]',
      },
      request_body: body,
      response_status: null,
      response_headers: {},
      response_body_raw: null,
      transport_error: String(error?.name || 'network error'),
      elapsed_ms: Date.now() - started,
    };
  }
  const responseBody = await response.text();
  const responseHeaders = {};
  for (const [name, value] of response.headers) {
    responseHeaders[name] =
      name.toLowerCase() === 'set-cookie' ? '[REDACTED]' : value;
  }
  return {
    url,
    method: 'POST',
    request_headers: {
      'Content-Type': 'application/json',
      Authorization: '[REDACTED]',
    },
    request_body: body,
    response_status: response.status,
    response_headers: responseHeaders,
    response_body_raw: responseBody,
    transport_error: null,
    elapsed_ms: Date.now() - started,
  };
}

function nativeFileFor(scope, questionId, queryId) {
  const key = hashJson([questionId, queryId]).slice(0, 32);
  return path.join(nativeRoot, scope, key + '.json');
}

function journalKey(questionId, queryId) {
  return hashJson([questionId, queryId]);
}

async function loadJournal(file) {
  const latest = new Map();
  if (!(await fileExists(file))) return latest;
  for await (const event of readJsonl(file)) {
    if (!event.key || !event.status)
      throw new Error('invalid query checkpoint event');
    latest.set(event.key, event);
  }
  return latest;
}

async function readNative(scope, question, query, fingerprint) {
  const file = nativeFileFor(scope, question.id, query.id);
  if (!(await fileExists(file))) return null;
  const record = await readJson(file);
  if (
    record.run_fingerprint !== fingerprint ||
    record.question_id !== question.id ||
    record.query_id !== query.id
  ) {
    throw new Error('native HTTP receipt binding mismatch; refusing resume');
  }
  const raw = record.raw_http;
  if (record.ok !== true || !raw?.response_body_raw) {
    throw new Error(
      'native HTTP receipt is failed or incomplete; refusing retry',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.response_body_raw);
  } catch {
    throw new Error('native HTTP response body is not valid JSON');
  }
  resultList(parsed);
  return { record, parsed };
}

async function performSubquery(
  scope,
  question,
  query,
  useMetadata,
  workflow,
  fingerprint,
  journal,
  journalFile,
) {
  const existing = await readNative(scope, question, query, fingerprint);
  if (existing) return existing;
  const key = journalKey(question.id, query.id);
  if (journal.has(key)) {
    throw new Error(
      'prior Dify POST is pending, failed, or uncertain for question ' +
        question.id +
        ' query ' +
        query.id +
        '; no blind retry will be attempted',
    );
  }
  const body = workflowRequestBody(question, query, scope, useMetadata);
  await appendJsonLineDurable(journalFile, {
    key,
    question_id: question.id,
    query_id: query.id,
    status: 'pending',
    request_sha256: hashJson(body),
    query_chars: query.text.length,
    at: new Date().toISOString(),
  });
  journal.set(key, {
    key,
    question_id: question.id,
    query_id: query.id,
    status: 'pending',
  });
  const raw = await workflowHttp(workflow, body);
  let parsed = null;
  if (raw.response_body_raw !== null) {
    try {
      parsed = JSON.parse(raw.response_body_raw);
    } catch {
      parsed = null;
    }
  }
  let ok =
    raw.response_status >= 200 && raw.response_status < 300 && parsed !== null;
  if (ok) {
    try {
      resultList(parsed);
    } catch {
      ok = false;
    }
  }
  const record = {
    version: 1,
    run_fingerprint: fingerprint,
    question_id: question.id,
    query_id: query.id,
    query_chars: query.text.length,
    raw_http: raw,
    ok,
    saved_at: new Date().toISOString(),
  };
  const nativeFile = nativeFileFor(scope, question.id, query.id);
  await writeJsonAtomic(nativeFile, record);
  const status = ok
    ? 'completed'
    : raw.response_status === null
      ? 'uncertain'
      : 'failed';
  await appendJsonLineDurable(journalFile, {
    key,
    question_id: question.id,
    query_id: query.id,
    status,
    native_file: path.relative(runtimeRoot, nativeFile),
    at: new Date().toISOString(),
  });
  journal.set(key, {
    key,
    question_id: question.id,
    query_id: query.id,
    status,
  });
  if (!ok) {
    throw new Error(
      'Dify workflow POST failed or is uncertain for question ' +
        question.id +
        ' query ' +
        query.id +
        '; receipt saved and no retry will be attempted',
    );
  }
  return { record, parsed };
}

function serializeRanking(query, response, indexState, fixedMap) {
  const results = resultList(response);
  if (fixedMap) {
    const mapped = results.map((item) => normalizeFixedResult(item, fixedMap));
    const unitIds = new Set();
    const ranked = mapped.map((item, index) => {
      if (unitIds.has(item.unit_id))
        throw new Error('Dify returned an official unit more than once');
      unitIds.add(item.unit_id);
      return { unit_id: item.unit_id, rank: index + 1, score: item.score };
    });
    return { query_id: query.id, results: ranked };
  }
  return {
    query_id: query.id,
    results: results.map((item) => normalizeFullResult(item, indexState)),
  };
}

async function loadOutputIds(file) {
  const ids = new Map();
  if (!(await fileExists(file))) return ids;
  for await (const row of readJsonl(file)) {
    if (!row || row.id === undefined || typeof row.scope !== 'string') {
      throw new Error(
        'invalid product output row; refusing to count or skip it',
      );
    }
    const id = String(row.id);
    if (ids.has(id)) throw new Error('duplicate parent output id: ' + id);
    ids.set(id, true);
  }
  return ids;
}

async function writeRunReceiptOnce(file, receipt) {
  if (await fileExists(file)) {
    const existing = await readJson(file);
    if (
      existing.status !== 'completed' ||
      existing.run_fingerprint !== receipt.run_fingerprint ||
      existing.output_sha256 !== receipt.output_sha256 ||
      existing.parent_questions !== receipt.parent_questions
    ) {
      throw new Error(
        'existing run receipt differs from this frozen run; refusing overwrite',
      );
    }
    return;
  }
  let handle;
  try {
    handle = await fs.open(file, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return writeRunReceiptOnce(file, receipt);
  }
  try {
    await handle.writeFile(JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function buildRunReceipt(
  scope,
  fingerprint,
  freeze,
  manifest,
  info,
  scopeReceipt,
  outputFile,
  count,
  completedAt,
) {
  const nativeFiles = [];
  for (const question of await loadQueryRows(info.queryFile)) {
    for (const query of question.queries) {
      const file = nativeFileFor(scope, question.id, query.id);
      nativeFiles.push({
        question_id: question.id,
        query_id: query.id,
        path: file,
        sha256: await hashFile(file),
      });
    }
  }
  return {
    version: 1,
    status: 'completed',
    scope,
    native_files: nativeFiles,
    runtime_snapshots: await Promise.all(
      ['.native-dataset.json', '.published-workflow.json'].map(
        async (suffix) => {
          const file = path.join(journalRoot, scope + suffix);
          return { path: file, sha256: await hashFile(file) };
        },
      ),
    ),
    run_fingerprint: fingerprint,
    freeze_sha256: freeze.sha256,
    corpus_manifest_sha256: manifest.sha256,
    corpus_sha256: info.corpus.sha256,
    query_sha256: info.queries.sha256,
    query_index_receipt_file: scopeReceipt.file,
    query_index_receipt_sha256: scopeReceipt.sha256,
    scope_execution_files: [...scopeReceipt.pins.values()].map((item) => ({
      path: item.file,
      sha256: item.sha256,
    })),
    output_file: outputFile,
    output_sha256: await hashFile(outputFile),
    parent_questions: count,
    completed_at: completedAt,
  };
}

async function runScope(scope) {
  safeScope(scope);
  const manifest = await loadManifest();
  const info = scopeInfo(manifest.value, scope);
  const fixed = isFixedScope(info);
  const corpusMap = await loadCorpusMap(info);
  const questions = await loadQueryRows(info.queryFile);
  const expectedQuestions = Number.isInteger(info.questions)
    ? info.questions
    : info.parent_questions;
  if (
    !Number.isInteger(expectedQuestions) ||
    questions.length !== expectedQuestions
  ) {
    throw new Error('query parent count differs from manifest');
  }
  if (scope === 'qasper') {
    for (const question of questions) {
      if (!question.source_id || !corpusMap.has(question.source_id)) {
        throw new Error('QASPER source_id is missing from corpus');
      }
    }
  }
  const indexState = await loadIndexState(scope, info, corpusMap);
  const fixedMap = fixed
    ? await loadFixedSegmentMap(scope, corpusMap, indexState)
    : null;
  const scopeReceipt = await loadScopeIndexReceipt(
    scope,
    info,
    indexState,
    fixedMap,
    corpusMap,
  );
  const freeze = await validateFreeze(
    options.freezeFile,
    manifest,
    info,
    scope,
    indexState,
    fixedMap,
    scopeReceipt,
  );
  const nativeConfig = await validateNativeDataset(
    indexState,
    freeze.freeze.conditions.dify,
  );
  await writeJsonAtomic(
    path.join(journalRoot, scope + '.native-dataset.json'),
    nativeConfig,
  );
  const fieldName =
    scope === 'qasper' ? metadataFieldName(indexState.raw) : null;
  const graphHash = hashJson(
    workflowGraph(indexState.datasetId, scope === 'qasper', fieldName),
  );
  const fingerprint = hashJson({
    freeze_sha256: freeze.sha256,
    manifest_sha256: manifest.sha256,
    scope,
    corpus_sha256: info.corpus.sha256,
    query_sha256: info.queries.sha256,
    index_state_sha256: indexState.sha256,
    segment_map_sha256: fixedMap?.sha256 ?? null,
    query_index_receipt_sha256: scopeReceipt.sha256,
    workflow_graph_sha256: graphHash,
    native_dataset_config_sha256: hashJson(nativeConfig),
    packing: fixed ? null : packing,
  });

  const outputFile = path.join(outputRoot, scope + '.jsonl');
  const journalFile = path.join(journalRoot, scope + '.jsonl');
  const metaFile = path.join(journalRoot, scope + '.meta.json');
  const receiptFile = path.join(outputRoot, scope + '.receipt.json');
  await fs.mkdir(path.join(nativeRoot, scope), { recursive: true });
  const outputExists = await fileExists(outputFile);
  const metaExists = await fileExists(metaFile);
  if (outputExists && (await fs.stat(outputFile)).size && !metaExists) {
    throw new Error(
      'existing output has no matching checkpoint metadata; refusing reuse',
    );
  }
  let meta;
  if (metaExists) {
    meta = await readJson(metaFile);
    if (
      meta.run_fingerprint !== fingerprint ||
      meta.scope !== scope ||
      meta.expected_questions !== questions.length
    ) {
      throw new Error(
        'existing Dify checkpoint belongs to different frozen inputs',
      );
    }
  } else {
    meta = {
      version: 1,
      scope,
      run_fingerprint: fingerprint,
      freeze_sha256: freeze.sha256,
      query_index_receipt_file: scopeReceipt.file,
      query_index_receipt_sha256: scopeReceipt.sha256,
      scope_execution_files: [...scopeReceipt.pins.values()].map((item) => ({
        path: item.file,
        sha256: item.sha256,
      })),
      expected_questions: questions.length,
      status: 'in_progress',
      started_at: new Date().toISOString(),
    };
    await writeJsonAtomic(metaFile, meta);
  }
  const outputIds = await loadOutputIds(outputFile);
  const validIds = new Set(questions.map((question) => question.id));
  for (const id of outputIds.keys()) {
    if (!validIds.has(id))
      throw new Error(
        'existing output contains an id absent from frozen queries',
      );
  }
  if (meta.status === 'completed') {
    if (outputIds.size !== questions.length)
      throw new Error('completed checkpoint has missing parent outputs');
    const receipt = await buildRunReceipt(
      scope,
      fingerprint,
      freeze,
      manifest,
      info,
      scopeReceipt,
      outputFile,
      outputIds.size,
      meta.completed_at,
    );
    await writeRunReceiptOnce(receiptFile, receipt);
    process.stdout.write(
      JSON.stringify({
        scope,
        status: 'completed',
        questions: questions.length,
        reused: true,
        receipt: receiptFile,
      }) + '\n',
    );
    return;
  }
  const journal = await loadJournal(journalFile);
  const workflow = await ensureWorkflow(scope, indexState, scope === 'qasper');
  if (workflow.graphHash !== graphHash)
    throw new Error('workflow graph changed after freeze validation');

  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  const output = await fs.open(outputFile, 'a', 0o600);
  let newlyCompleted = 0;
  try {
    for (const question of questions) {
      if (outputIds.has(question.id)) {
        for (const query of question.queries) {
          if (!(await readNative(scope, question, query, fingerprint))) {
            throw new Error(
              'parent output exists without its native query receipt',
            );
          }
        }
        continue;
      }
      const started = Date.now();
      const rankedQueries = [];
      for (const query of question.queries) {
        const receipt = await performSubquery(
          scope,
          question,
          query,
          scope === 'qasper',
          workflow,
          fingerprint,
          journal,
          journalFile,
        );
        rankedQueries.push(
          serializeRanking(query, receipt.parsed, indexState, fixedMap),
        );
      }
      assert.deepEqual(
        rankedQueries.map((row) => row.query_id),
        question.queries.map((row) => row.id),
        'ranked query order must match the frozen question',
      );
      let packed = {};
      if (fixed) {
        assert.equal(
          rankedQueries.length,
          1,
          'Official fixed task must have one query',
        );
        packed = {
          rankings: rankedQueries[0].results.map((item, index) => ({
            id: item.unit_id,
            rank: index + 1,
            score: item.score,
          })),
        };
      } else {
        packed = packProductEvidence(
          {
            id: question.id,
            text: question.text,
            queries: question.queries,
            ...(question.source_id ? { source_id: question.source_id } : {}),
          },
          rankedQueries,
          packing,
        );
      }
      const row = {
        id: question.id,
        scope,
        ranked_queries: rankedQueries,
        ...packed,
        elapsed_ms: Date.now() - started,
      };
      await output.write(JSON.stringify(row) + '\n');
      await output.sync();
      outputIds.set(question.id, true);
      await appendJsonLineDurable(journalFile, {
        key: hashJson([question.id, 'parent-output']),
        question_id: question.id,
        status: 'completed',
        output_id: question.id,
        at: new Date().toISOString(),
      });
      newlyCompleted += 1;
      process.stdout.write(
        JSON.stringify({
          scope,
          completed: outputIds.size,
          total: questions.length,
          newly_completed: newlyCompleted,
        }) + '\n',
      );
    }
  } finally {
    await output.close();
  }
  if (outputIds.size !== questions.length)
    throw new Error('scope ended with missing parent outputs');
  meta.status = 'completed';
  meta.completed_at = new Date().toISOString();
  meta.completed_questions = outputIds.size;
  await writeJsonAtomic(metaFile, meta);
  const runReceipt = await buildRunReceipt(
    scope,
    fingerprint,
    freeze,
    manifest,
    info,
    scopeReceipt,
    outputFile,
    outputIds.size,
    meta.completed_at,
  );
  await writeRunReceiptOnce(receiptFile, runReceipt);
  process.stdout.write(
    JSON.stringify({
      scope,
      status: 'completed',
      questions: outputIds.size,
      output: outputFile,
      native_http: path.join(nativeRoot, scope),
      receipt: receiptFile,
      run_fingerprint: fingerprint,
    }) + '\n',
  );
}

async function finishProbeFromRaw(pendingFile, rawFile, privateWorkflow) {
  if (!(await fileExists(rawFile))) return false;
  const raw = await readJson(rawFile);
  const expectedQuery =
    'PARENT_SENTINEL_ALPHA ' + 'workflow-long-query-padding '.repeat(12);
  if (
    raw.request_body?.inputs?.query !== expectedQuery ||
    raw.response_status === null ||
    raw.response_status < 200 ||
    raw.response_status >= 300
  ) {
    throw new Error(
      'prior isolated probe receipt is not a successful matching response; no retry will be attempted',
    );
  }
  const parsed = JSON.parse(raw.response_body_raw || 'null');
  const results = resultList(parsed);
  const matching = results.some(
    (item) =>
      typeof item?.content === 'string' &&
      item.content.includes('PARENT_SENTINEL_ALPHA'),
  );
  const receipt = {
    version: 1,
    purpose: 'synthetic isolated Dify workflow adapter probe',
    app_id: privateWorkflow.app_id,
    dataset_id: privateWorkflow.dataset_id,
    query_chars: expectedQuery.length,
    http_status: raw.response_status,
    workflow_status: (parsed?.data ?? parsed)?.status ?? null,
    result_count: results.length,
    sentinel_match: matching,
    elapsed_ms: raw.elapsed_ms,
    raw_http_file: rawFile,
    completed_at: new Date().toISOString(),
  };
  await writeJsonAtomic(
    path.join(runtimeRoot, 'probe-adapter-receipt.json'),
    receipt,
  );
  await writeJsonAtomic(pendingFile, { ...receipt, status: 'completed' });
  return true;
}

async function isolatedProbe() {
  const receiptFile = path.join(runtimeRoot, 'probe-adapter-receipt.json');
  if (await fileExists(receiptFile)) {
    const receipt = await readJson(receiptFile);
    process.stdout.write(
      JSON.stringify({
        status: 'already-completed',
        query_chars: receipt.query_chars,
        result_count: receipt.result_count,
        sentinel_match: receipt.sentinel_match,
      }) + '\n',
    );
    return;
  }
  const pendingFile = path.join(runtimeRoot, 'probe-adapter-pending.json');
  const rawFile = path.join(runtimeRoot, 'probe-adapter-http.json');
  const privateWorkflow = await readJson(probePrivateFile);
  if (
    !privateWorkflow.app_id ||
    !privateWorkflow.app_key ||
    !privateWorkflow.dataset_id
  ) {
    throw new Error('existing isolated workflow/app key binding is incomplete');
  }
  if (await fileExists(pendingFile)) {
    if (await finishProbeFromRaw(pendingFile, rawFile, privateWorkflow))
      return isolatedProbe();
    throw new Error(
      'isolated workflow POST is pending or uncertain; refusing to run it again',
    );
  }
  const query =
    'PARENT_SENTINEL_ALPHA ' + 'workflow-long-query-padding '.repeat(12);
  assert.equal(query.length, 358);
  const body = {
    inputs: { query, scope: 'keep' },
    response_mode: 'blocking',
    user: 'echo-dify-adapter-isolated-probe',
  };
  await writeJsonAtomic(pendingFile, {
    purpose: 'synthetic isolated Dify workflow probe',
    app_id: privateWorkflow.app_id,
    dataset_id: privateWorkflow.dataset_id,
    query_sha256: hash(query),
    query_chars: query.length,
    status: 'pending',
    created_at: new Date().toISOString(),
  });
  const raw = await workflowHttp(
    { appKey: privateWorkflow.app_key },
    body,
    180000,
  );
  await writeJsonAtomic(rawFile, raw);
  if (
    raw.response_status === null ||
    raw.response_status < 200 ||
    raw.response_status >= 300
  ) {
    throw new Error(
      'isolated workflow probe returned no successful HTTP response; no retry was attempted',
    );
  }
  const completed = await finishProbeFromRaw(
    pendingFile,
    rawFile,
    privateWorkflow,
  );
  if (!completed)
    throw new Error('isolated probe raw receipt could not be finalized');
  const receipt = await readJson(receiptFile);
  process.stdout.write(JSON.stringify(receipt) + '\n');
  if (!receipt.sentinel_match)
    throw new Error('probe completed but did not return the sentinel result');
}

async function selfTest() {
  const state = {
    documents: {
      'synthetic-source': {
        source_id: 'synthetic-source',
        document_id: 'synthetic-document',
        relative_path: 'synthetic.md',
        status: 'verified',
      },
    },
  };
  const indexState = { documents: normalizeDocuments(state) };
  const result = normalizeFullResult(
    {
      metadata: {
        document_id: 'synthetic-document',
        segment_id: 'synthetic-segment',
        score: 0.75,
      },
      content: 'synthetic evidence',
    },
    indexState,
  );
  assert.equal(
    result.id,
    hashJson(['synthetic-source', 'synthetic evidence']).slice(0, 32),
  );
  assert.equal(result.native_id, 'synthetic-segment');
  assert.equal(result.document_id, 'synthetic-document');
  const question = {
    id: 'synthetic-question',
    text: 'synthetic question',
    queries: [{ id: 'q0', text: 'synthetic query' }],
  };
  const packed = packProductEvidence(
    question,
    [{ query_id: 'q0', results: [result] }],
    packing,
  );
  assert.equal(packed.response.results.length, 1);
  assert.equal(packed.response.results[0].id, result.id);
  process.stdout.write(
    JSON.stringify({
      status: 'passed',
      scope: 'synthetic-only',
      packed_results: packed.response.results.length,
      live_requests: 0,
    }) + '\n',
  );
}

async function plan() {
  const manifest = await loadManifest();
  const scopes = options.scope
    ? [safeScope(options.scope)]
    : Object.keys(manifest.value.scopes || {});
  const rows = [];
  for (const scope of scopes) {
    const info = scopeInfo(manifest.value, scope);
    const questions = await loadQueryRows(info.queryFile);
    const stateFile = path.join(indexRoot, scope, 'state.json');
    let stateStatus = 'missing';
    let stateSha256 = null;
    if (await fileExists(stateFile)) {
      const state = await readJson(stateFile);
      stateStatus = state.status ?? 'unknown';
      stateSha256 = await hashFile(stateFile);
    }
    rows.push({
      scope,
      kind: info.kind,
      parent_questions: questions.length,
      query_inputs: questions.reduce(
        (sum, question) => sum + question.queries.length,
        0,
      ),
      documents: info.documents,
      state_status: stateStatus,
      state_sha256: stateSha256,
    });
  }
  process.stdout.write(
    JSON.stringify(
      {
        mode: 'plan-only',
        manifest_sha256: manifest.sha256,
        formal_freeze_present: await fileExists(options.freezeFile),
        scopes: rows,
      },
      null,
      2,
    ) + '\n',
  );
}

async function main() {
  if (!comparisonRoot && !options.help && !options.selfTest) {
    throw new Error(
      '--root <comparison-root> is required outside the isolated runtime directory',
    );
  }
  if (options.root && path.resolve(options.root) !== comparisonRoot)
    throw new Error('parsed root differs from selected comparison root');
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (options.selfTest) return selfTest();
  if (options.probe) return isolatedProbe();
  if (options.live) {
    if (!options.scope) throw new Error('--live requires exactly one --scope');
    return runScope(options.scope);
  }
  return plan();
}

main().catch((error) => {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
});
