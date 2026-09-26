import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { jsonLines } from './prepare-product-comparison.mjs';
import {
  durableCreate,
  assertKnownDocuments,
} from './lib/product-index-intent.mjs';
import { mapReturnedText } from './lib/product-evidence.mjs';

const [rootArg, scope] = process.argv.slice(2);
assert.ok(rootArg && scope, 'Expected PRODUCT_ROOT SCOPE');
const root = path.resolve(rootArg);
const freeze = JSON.parse(
  await fs.readFile(path.join(root, 'index-freeze.json'), 'utf8'),
);
assert.equal(freeze.status, 'index-inputs-frozen');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const manifestBytes = await fs.readFile(
  path.join(root, 'corpus-v1/manifest.json'),
);
assert.equal(digest(manifestBytes), freeze.corpus_manifest_sha256);
const manifest = JSON.parse(manifestBytes);
const info = manifest.scopes[scope];
assert.ok(
  info && info.kind !== 'official-fixed-unit',
  'This entry imports full Markdown documents only',
);
assert.equal(digest(await fs.readFile(info.corpus.path)), info.corpus.sha256);
const privateSession = JSON.parse(
  await fs.readFile(
    path.join(root, 'dify-runtime/private-session.json'),
    'utf8',
  ),
);
assert.ok(privateSession.service_api_key);
const out = path.join(root, 'indexes/dify', scope);
await fs.mkdir(out, { recursive: true });
const stateFile = path.join(out, 'state.json');
let state = await fs
  .readFile(stateFile, 'utf8')
  .then(JSON.parse)
  .catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return {
      scope,
      corpus_sha256: info.corpus.sha256,
      documents: {},
      status: 'pending',
    };
  });
assert.equal(state.corpus_sha256, info.corpus.sha256);
async function save() {
  const temporary = stateFile + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n');
  await fs.rename(temporary, stateFile);
}
async function call(route, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:15101/v1' + route, {
    method,
    signal: AbortSignal.timeout(240000),
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + privateSession.service_api_key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) {
    await fs.appendFile(
      path.join(out, 'errors.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        route,
        method,
        status: response.status,
        error: value,
      }) + '\n',
    );
    throw new Error('Dify HTTP ' + response.status + ' at ' + route);
  }
  return value;
}
const config = freeze.dify;
if (!state.dataset_id) {
  const created = await durableCreate(
    state,
    'dataset_create_intent',
    save,
    () =>
      call('/datasets', 'POST', {
        name: 'echo-comparison-' + scope + '-v1',
        description:
          'Frozen complete corpus for retrieval-only product comparison.',
        permission: 'only_me',
        indexing_technique: 'high_quality',
        embedding_model: config.model,
        embedding_model_provider: config.provider,
        retrieval_model: config.retrieval_model,
      }),
  );
  state.dataset_id = created.id;
  state.created_at = new Date().toISOString();
  assert.ok(state.dataset_id);
  await save();
}
if (scope === 'qasper' && !state.metadata_field) {
  const field = await durableCreate(state, 'metadata_create_intent', save, () =>
    call(`/datasets/${state.dataset_id}/metadata`, 'POST', {
      type: 'string',
      name: 'scope',
    }),
  );
  state.metadata_field = field.data ?? field;
  assert.ok(state.metadata_field.id);
  await save();
}
for await (const source of jsonLines(info.corpus.path)) {
  const intent = state.document_create_intents?.[source.id];
  if (!state.documents[source.id] && intent?.status === 'completed') {
    const created = intent.result;
    assert.ok(created.document?.id && created.batch);
    state.documents[source.id] = {
      document_id: created.document.id,
      batch: created.batch,
      source_id: source.id,
      relative_path: source.relative_path,
      text_sha256: source.text_sha256,
      status: 'submitted',
    };
    await save();
  }
}
const remoteDocuments = [];
for (let page = 1; ; page++) {
  const response = await call(
    '/datasets/' + state.dataset_id + '/documents?limit=100&page=' + page,
  );
  remoteDocuments.push(...response.data);
  if (!response.has_more || !response.data.length) break;
}
assertKnownDocuments(
  remoteDocuments,
  Object.values(state.documents).map((item) => item.document_id),
);
state.status = 'indexing';
await save();
let completed = 0;
const started = performance.now();
for await (const source of jsonLines(info.corpus.path)) {
  let item = state.documents[source.id];
  if (item?.status === 'verified') {
    completed++;
    continue;
  }
  if (!item) {
    state.document_create_intents ??= {};
    const created = await durableCreate(
      state.document_create_intents,
      source.id,
      save,
      () =>
        call(`/datasets/${state.dataset_id}/document/create-by-text`, 'POST', {
          name: source.relative_path.slice(-255),
          text: source.text,
          indexing_technique: 'high_quality',
          doc_form: 'hierarchical_model',
          process_rule: config.process_rule,
          retrieval_model: config.retrieval_model,
          embedding_model: config.model,
          embedding_model_provider: config.provider,
        }),
    );
    item = state.documents[source.id] = {
      document_id: created.document.id,
      batch: created.batch,
      source_id: source.id,
      relative_path: source.relative_path,
      text_sha256: source.text_sha256,
      status: 'submitted',
    };
    await save();
  }
  assert.equal(item.text_sha256, source.text_sha256);
  const deadline = Date.now() + 30 * 60 * 1000;
  while (true) {
    const report = await call(
      `/datasets/${state.dataset_id}/documents/${encodeURIComponent(item.batch)}/indexing-status`,
    );
    const status =
      report.data.find((row) => row.id === item.document_id) ?? report.data[0];
    assert.ok(status);
    if (status.indexing_status === 'completed') break;
    if (status.indexing_status === 'error') {
      item.status = 'error';
      item.error = status.error;
      await save();
      throw new Error('Dify document indexing failed; see local state');
    }
    assert.ok(Date.now() < deadline, 'Dify document indexing timeout');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (state.metadata_field)
    await call(`/datasets/${state.dataset_id}/documents/metadata`, 'POST', {
      operation_data: [
        {
          document_id: item.document_id,
          metadata_list: [
            { id: state.metadata_field.id, name: 'scope', value: source.id },
          ],
          partial_update: false,
        },
      ],
    });
  const segments = [];
  for (let page = 1; ; page++) {
    const result = await call(
      `/datasets/${state.dataset_id}/documents/${item.document_id}/segments?limit=100&page=${page}`,
    );
    segments.push(...result.data);
    if (!result.has_more || result.data.length === 0) break;
  }
  assert.ok(segments.length, 'Document produced no index segments');
  const mappings = segments.map((segment) => ({
    id: segment.id,
    mapping: mapReturnedText(segment.content, source),
  }));
  const gaps = mappings.filter((row) => row.mapping.status !== 'mapped').length;
  await fs.writeFile(
    path.join(out, source.id + '.segments.json'),
    JSON.stringify(
      {
        source_id: source.id,
        source_text_sha256: source.text_sha256,
        document_id: item.document_id,
        segments,
        mappings,
      },
      null,
      2,
    ) + '\n',
  );
  item.status = 'verified';
  item.segments = segments.length;
  item.mapping_gaps = gaps;
  await save();
  completed++;
  console.log(
    JSON.stringify({
      scope,
      completed,
      total: info.documents,
      parent_segments: segments.length,
      mapping_gaps: gaps,
      elapsed_ms: Math.round(performance.now() - started),
    }),
  );
}
assert.equal(completed, info.documents);
assert.equal(Object.keys(state.documents).length, info.documents);
state.status = 'indexed-awaiting-final-audit';
state.completed_at = new Date().toISOString();
state.mapping_gaps = Object.values(state.documents).reduce(
  (sum, row) => sum + row.mapping_gaps,
  0,
);
await save();
console.log(
  JSON.stringify({
    scope,
    status: state.status,
    documents: completed,
    mapping_gaps: state.mapping_gaps,
  }),
);
