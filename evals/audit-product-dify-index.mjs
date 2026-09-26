import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeIndexReceipt } from './lib/product-index-receipt.mjs';
import { auditDifyVectors } from './lib/product-dify-vector-audit.mjs';
import { jsonLines } from './prepare-product-comparison.mjs';
import { assertKnownDocuments } from './lib/product-index-intent.mjs';
import { mapDifyPartition } from './lib/dify-evidence.mjs';

const [rootArg, scope] = process.argv.slice(2);
assert.ok(rootArg && scope, 'Expected PRODUCT_ROOT SCOPE');
const root = path.resolve(rootArg);
const dir = path.join(root, 'indexes/dify', scope);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const manifest = await read(path.join(root, 'corpus-v1/manifest.json'));
const frozen = await read(path.join(root, 'index-freeze.json'));
assert.equal(
  sha(await fs.readFile(path.join(root, 'corpus-v1/manifest.json'))),
  frozen.corpus_manifest_sha256,
);
const info = manifest.scopes[scope];
assert.ok(
  info && info.kind !== 'official-fixed-unit',
  'Full-document audit only',
);
const stateFile = path.join(dir, 'state.json');
const state = await read(stateFile);
assert.equal(state.status, 'indexed-awaiting-final-audit');
assert.equal(state.corpus_sha256, info.corpus.sha256);
assert.equal(sha(await fs.readFile(info.corpus.path)), info.corpus.sha256);
const files = [stateFile];
const session = await read(
  path.join(root, 'dify-runtime/private-session.json'),
);
const allRemoteDocuments = [];
for (let page = 1; ; page++) {
  const response = await fetch(
    'http://127.0.0.1:15101/v1/datasets/' +
      state.dataset_id +
      '/documents?limit=100&page=' +
      page,
    {
      headers: { authorization: 'Bearer ' + session.service_api_key },
      signal: AbortSignal.timeout(60000),
    },
  );
  assert.ok(response.ok);
  const value = await response.json();
  allRemoteDocuments.push(...value.data);
  if (!value.has_more || !value.data.length) break;
}
assertKnownDocuments(
  allRemoteDocuments,
  Object.values(state.documents).map((item) => item.document_id),
);
const audit = {
  status: 'verified',
  scope,
  corpus_sha256: info.corpus.sha256,
  dataset_id: state.dataset_id,
  documents: 0,
  segments: 0,
  partition_verified: 0,
  mapping_gaps: [],
  created_at: new Date().toISOString(),
};
for await (const source of jsonLines(info.corpus.path)) {
  const file = path.join(dir, source.id + '.segments.json');
  const stored = await read(file);
  assert.equal(stored.source_id, source.id);
  assert.equal(stored.source_text_sha256, source.text_sha256);
  assert.equal(stored.document_id, state.documents[source.id].document_id);
  const live = [];
  for (let page = 1; ; page++) {
    const response = await fetch(
      'http://127.0.0.1:15101/v1/datasets/' +
        state.dataset_id +
        '/documents/' +
        stored.document_id +
        '/segments?limit=100&page=' +
        page,
      {
        headers: { authorization: 'Bearer ' + session.service_api_key },
        signal: AbortSignal.timeout(60000),
      },
    );
    assert.ok(
      response.ok,
      'Dify native segment read failed: ' + response.status,
    );
    const value = await response.json();
    live.push(...value.data);
    if (!value.has_more || value.data.length === 0) break;
  }
  const contract = (rows) =>
    rows
      .map((row) => ({
        id: row.id,
        position: row.position,
        content: row.content,
        index_node_id: row.index_node_id,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    contract(live),
    contract(stored.segments),
    'Native parent segments changed',
  );
  assert.ok(
    live.every((row) => row.status === 'completed' && row.enabled),
    'Unavailable parent segment',
  );
  const mapped = mapDifyPartition(stored.segments, source);
  if (mapped.partition_verified) audit.partition_verified++;
  for (const row of mapped.mappings)
    if (row.mapping.status !== 'mapped')
      audit.mapping_gaps.push({
        source_id: source.id,
        native_id: row.id,
        status: row.mapping.status,
      });
  audit.documents++;
  audit.segments += live.length;
  files.push(file);
}
assert.equal(audit.documents, info.documents);
assert.equal(Object.keys(state.documents).length, info.documents);
if (audit.mapping_gaps.length) audit.status = 'mapping-gaps-require-review';
const stamp = Date.now();
const mappingFile = path.join(dir, 'mapping-audit-' + stamp + '.json');
await fs.writeFile(mappingFile, JSON.stringify(audit, null, 2) + '\n', {
  flag: 'wx',
});
assert.equal(
  audit.status,
  'verified',
  'Mapping gaps must be reviewed before queries',
);
const physical = await auditDifyVectors(
  root,
  state.dataset_id,
  'hierarchical',
  frozen.model.fingerprint,
);
const physicalFile = path.join(dir, 'vector-audit-' + stamp + '.json');
await fs.writeFile(
  physicalFile,
  JSON.stringify(physical.report, null, 2) + '\n',
  { flag: 'wx' },
);
assert.equal(physical.exit_code, 0, 'Physical/model vector audit failed');
assert.equal(physical.report.status, 'verified');
assert.equal(
  physical.report.matched_model_vectors,
  physical.report.expected_vectors,
);
files.push(mappingFile, physicalFile);
await writeIndexReceipt({
  root,
  product: 'dify',
  scope,
  info,
  modelFingerprint: frozen.model.fingerprint,
  artifacts: files,
  audits: [
    { kind: 'full-document-mapping', path: mappingFile },
    { kind: 'model-vectors', path: physicalFile },
  ],
  fixed: false,
});
console.log(
  JSON.stringify({
    scope,
    status: 'index-verified-for-queries',
    documents: audit.documents,
    segments: audit.segments,
  }),
);
