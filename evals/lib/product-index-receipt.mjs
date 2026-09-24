import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSha256, verifyExecutionFiles } from './product-freeze.mjs';

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export function requiredAuditors(product, fixed) {
  const shared = [
    'evals/lib/product-index-receipt.mjs',
    'evals/lib/product-freeze.mjs',
    'evals/prepare-product-comparison.mjs',
  ];
  if (product === 'dify')
    return [
      ...shared,
      fixed
        ? 'evals/audit-product-dify-fixed.mjs'
        : 'evals/audit-product-dify-index.mjs',
      'evals/audit-product-dify-vectors.py',
      'evals/lib/product-dify-vector-audit.mjs',
      'evals/lib/product-index-intent.mjs',
      ...(fixed
        ? ['evals/product-dify-fixed-index.mjs']
        : [
            'evals/lib/dify-evidence.mjs',
            'evals/lib/product-evidence.mjs',
            'evals/lib/product-index-intent.mjs',
          ]),
    ].map((file) => path.join(repository, file));
  assert.equal(product, 'khoj');
  return [
    ...shared,
    'evals/audit-product-khoj-index.mjs',
    'evals/lib/khoj-evidence.mjs',
    'evals/lib/product-evidence.mjs',
    'evals/lib/product-vector-cache.mjs',
    ...(fixed ? ['evals/import-product-khoj-fixed.py'] : []),
  ].map((file) => path.join(repository, file));
}

export async function writeIndexReceipt({
  root,
  product,
  scope,
  info,
  modelFingerprint,
  artifacts,
  audits,
  fixed,
}) {
  const files = [
    ...new Set([
      ...artifacts,
      ...audits.map((item) => item.path),
      ...requiredAuditors(product, fixed),
    ]),
  ];
  const bindings = await Promise.all(
    files.map(async (file) => ({ path: file, sha256: await fileSha256(file) })),
  );
  const byPath = new Map(
    bindings.map((item) => [path.resolve(item.path), item]),
  );
  const receipt = {
    version: 2,
    status: 'frozen',
    product,
    scope,
    corpus_sha256: info.corpus.sha256,
    model_fingerprint: modelFingerprint,
    created_at: new Date().toISOString(),
    audits: audits.map((item) => ({
      kind: item.kind,
      ...byPath.get(path.resolve(item.path)),
    })),
    execution_files: bindings,
  };
  const file = path.join(
    root,
    'indexes',
    product,
    scope,
    'query-index-receipt.json',
  );
  try {
    await fs.access(file);
    // No formal run has consumed a receipt before the global query freeze.
    // Keep earlier preflight receipts by content hash when strengthening audits.
    await fs.access(path.join(root, 'freeze.json')).then(
      () => {
        throw new Error(
          'Cannot revise an index receipt after global query freeze',
        );
      },
      (error) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    const previousSha = await fileSha256(file);
    const archive = path.join(
      path.dirname(file),
      'query-index-receipt-prior-' + previousSha + '.json',
    );
    try {
      await fs.copyFile(file, archive, 1);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert.equal(await fileSha256(archive), previousSha);
    }
    await fs.unlink(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(file, JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  return receipt;
}

export async function validateIndexReceipt({
  root,
  product,
  scope,
  info,
  modelFingerprint,
}) {
  const file = path.join(
    root,
    'indexes',
    product,
    scope,
    'query-index-receipt.json',
  );
  const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(
    receipt.version,
    2,
    'Index receipt must include model audits and auditor code',
  );
  assert.equal(receipt.status, 'frozen');
  assert.equal(receipt.product, product);
  assert.equal(receipt.scope, scope);
  assert.equal(receipt.corpus_sha256, info.corpus.sha256);
  assert.equal(receipt.model_fingerprint, modelFingerprint);
  const fixed = info.kind === 'official-fixed-unit';
  await verifyExecutionFiles(
    root,
    receipt.execution_files,
    requiredAuditors(product, fixed),
  );
  const pins = new Map(
    receipt.execution_files.map((item) => [
      path.resolve(root, item.path),
      item.sha256,
    ]),
  );
  const audits = new Map();
  for (const item of receipt.audits) {
    const target = path.resolve(root, item.path);
    assert.equal(pins.get(target), item.sha256);
    assert.equal(await fileSha256(target), item.sha256);
    assert.ok(!audits.has(item.kind));
    audits.set(item.kind, JSON.parse(await fs.readFile(target, 'utf8')));
  }
  if (product === 'dify') {
    const state = JSON.parse(
      await fs.readFile(
        path.join(root, 'indexes/dify', scope, 'state.json'),
        'utf8',
      ),
    );
    const mapping = audits.get(
      fixed ? 'fixed-segments' : 'full-document-mapping',
    );
    assert.equal(mapping?.status, 'verified');
    assert.equal(mapping.scope, scope);
    assert.equal(mapping.corpus_sha256, info.corpus.sha256);
    assert.equal(mapping.dataset_id, state.dataset_id);
    assert.equal(mapping.documents, info.documents);
    if (!fixed) assert.equal(mapping.mapping_gaps.length, 0);
    const vectors = audits.get('model-vectors');
    assert.equal(vectors?.status, 'verified');
    assert.equal(vectors.dataset_id, state.dataset_id);
    assert.equal(vectors.dimensions, 1024);
    assert.equal(vectors.model_cache_fingerprint, modelFingerprint);
    assert.ok(vectors.expected_vectors > 0);
    assert.equal(vectors.actual_vectors, vectors.expected_vectors);
    assert.equal(vectors.matched_model_vectors, vectors.expected_vectors);
    assert.equal(vectors.missing.length, 0);
    assert.equal(vectors.problems.length, 0);
    if (fixed) {
      assert.equal(vectors.expected_vectors, info.documents);
      assert.equal(vectors.source_segment_contract_matched, info.documents);
      assert.equal(mapping.exact_texts, info.documents);
    }
  } else {
    const audit = audits.get(fixed ? 'fixed-evidence' : 'native-evidence');
    assert.equal(audit?.status, 'verified');
    assert.equal(audit.scope, scope);
    assert.equal(audit.corpus_sha256, info.corpus.sha256);
    assert.equal(audit.model_fingerprint, modelFingerprint);
    assert.equal(audit.documents, info.documents);
    assert.ok(audit.entries > 0);
    if (fixed) assert.equal(audit.entries, info.documents);
    assert.equal(audit.cache_vectors_matched, audit.entries);
    for (const key of ['mapping_gaps', 'vector_gaps', 'missing_source_ids'])
      assert.equal(audit[key].length, 0);
  }
  return { path: file, sha256: await fileSha256(file), receipt };
}
