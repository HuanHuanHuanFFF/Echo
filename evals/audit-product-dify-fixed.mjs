import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { jsonLines } from './prepare-product-comparison.mjs';
import { auditDifyVectors } from './lib/product-dify-vector-audit.mjs';
import { writeIndexReceipt } from './lib/product-index-receipt.mjs';
import { assertKnownDocuments } from './lib/product-index-intent.mjs';
const [rootArg, scope] = process.argv.slice(2);
assert.ok(rootArg && scope);
const root = path.resolve(rootArg);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const manifestFile = path.join(root, 'corpus-v1/manifest.json');
const manifest = await read(manifestFile);
const frozen = await read(path.join(root, 'index-freeze.json'));
assert.equal(
  hash(await fs.readFile(manifestFile)),
  frozen.corpus_manifest_sha256,
);
const info = manifest.scopes[scope];
assert.equal(info?.kind, 'official-fixed-unit');
assert.equal(hash(await fs.readFile(info.corpus.path)), info.corpus.sha256);
const directory = path.join(root, 'indexes/dify', scope);
const stateFile = path.join(directory, 'state.json');
const state = await read(stateFile);
assert.equal(state.status, 'segments-verified-awaiting-vector-audit');
assert.equal(state.corpus_sha256, info.corpus.sha256);
assert.equal(state.committed_units, info.documents);
const mapFile = path.join(directory, 'segment-map.jsonl');
const corpus = new Map();
for await (const row of jsonLines(info.corpus.path)) {
  assert.ok(!corpus.has(row.id));
  corpus.set(row.id, row.text_sha256);
}
const mapping = new Map();
for await (const row of jsonLines(mapFile)) {
  assert.ok(!mapping.has(row.segment_id));
  assert.equal(row.text_sha256, corpus.get(row.unit_id));
  mapping.set(row.segment_id, row);
}
assert.equal(corpus.size, info.documents);
assert.equal(mapping.size, info.documents);
assert.equal(
  new Set([...mapping.values()].map((row) => row.unit_id)).size,
  info.documents,
);
const session = await read(
  path.join(root, 'dify-runtime/private-session.json'),
);
async function get(route) {
  const response = await fetch('http://127.0.0.1:15101/v1' + route, {
    headers: { authorization: 'Bearer ' + session.service_api_key },
    signal: AbortSignal.timeout(120000),
  });
  assert.ok(response.ok, 'Native read failed: ' + response.status);
  return response.json();
}
const documents = [];
for (let page = 1; ; page++) {
  const value = await get(
    '/datasets/' + state.dataset_id + '/documents?limit=100&page=' + page,
  );
  documents.push(...value.data);
  if (!value.has_more || !value.data.length) break;
}
const documentId = state.documents.container.document_id;
assertKnownDocuments(documents, [documentId]);
const stamp = Date.now();
const mappingFile = path.join(
  directory,
  'fixed-mapping-audit-' + stamp + '.json',
);
const physical = await auditDifyVectors(
  root,
  state.dataset_id,
  'fixed',
  frozen.model.fingerprint,
  mapFile,
);
const vectorFile = path.join(
  directory,
  'model-vector-audit-' + stamp + '.json',
);
await fs.writeFile(
  vectorFile,
  JSON.stringify(physical.report, null, 2) + '\n',
  { flag: 'wx' },
);
assert.equal(physical.exit_code, 0);
assert.equal(physical.report.status, 'verified');
assert.equal(physical.report.matched_model_vectors, info.documents);
assert.equal(physical.report.source_segment_contract_matched, info.documents);
const result = {
  status: 'verified',
  scope,
  corpus_sha256: info.corpus.sha256,
  dataset_id: state.dataset_id,
  documents: info.documents,
  unit_kind: 'official-fixed-unit',
  native_documents: 1,
  exact_texts: physical.report.source_segment_contract_matched,
  segment_map_sha256: hash(await fs.readFile(mapFile)),
};
await fs.writeFile(mappingFile, JSON.stringify(result, null, 2) + '\n', {
  flag: 'wx',
});

await writeIndexReceipt({
  root,
  product: 'dify',
  scope,
  info,
  modelFingerprint: frozen.model.fingerprint,
  artifacts: [stateFile, mapFile, path.join(directory, 'audit.json')],
  audits: [
    { kind: 'fixed-segments', path: mappingFile },
    { kind: 'model-vectors', path: vectorFile },
  ],
  fixed: true,
});
console.log(
  JSON.stringify({
    scope,
    status: 'index-verified-for-queries',
    units: info.documents,
  }),
);
