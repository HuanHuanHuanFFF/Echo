import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { validateVectors } from '../dist/embedding.js';
import { fileSha256 } from './lib/product-freeze.mjs';
import { loadFrozenPrivateVectors } from './lib/product-private-vectors.mjs';

const [rootArg, publicArg] = process.argv.slice(2);
assert.ok(rootArg && publicArg, 'Expected PRODUCT_ROOT PUBLIC_ROOT');
const root = path.resolve(rootArg);
const publicRoot = path.resolve(publicArg);
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const indexFile = path.join(root, 'index-freeze.json');
const frozen = await read(indexFile);
const planFile = path.join(publicRoot, 'embedding-plan.json');
const plan = await read(planFile);
assert.equal(plan.fingerprint, frozen.model.fingerprint);
const seed = await read(
  path.join(root, 'embedding-gateway/private-query-seed-20260924.json'),
);
const capturePlan = await read(seed.plan.path);
const privateRoot = path.resolve(path.dirname(seed.plan.path), '../..');
const captureSources = {
  driver: fileURLToPath(new URL('./run-final-four-arms.mjs', import.meta.url)),
  replay: fileURLToPath(
    new URL('./lib/frozen-query-fetch.mjs', import.meta.url),
  ),
  guard: path.join(privateRoot, 'query-fetch-guard-final.mjs'),
};
for (const [role, file] of Object.entries(captureSources))
  assert.equal(
    await fileSha256(file),
    capturePlan.code[role],
    'Private capture producer changed: ' + role,
  );
const privateVectors = await loadFrozenPrivateVectors(seed, {
  model: frozen.model.name,
  dimensions: frozen.model.dimensions,
  endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
});
const privateHashes = new Map(
  [...privateVectors].map(([text, vector]) => [
    text,
    hash(
      Buffer.from(
        new Float32Array(validateVectors([vector], 1, 1024)[0]).buffer,
      ),
    ),
  ]),
);
const directory = path.join(root, 'model-provenance', String(Date.now()));
await fs.mkdir(directory, { recursive: true });
const snapshot = path.join(directory, 'cache.sqlite');
const live = new Database(path.join(root, 'embedding-gateway/vectors.sqlite'), {
  readonly: true,
  fileMustExist: true,
});
try {
  await live.backup(snapshot, { progress: ({ totalPages }) => totalPages });
} finally {
  live.close();
}
const cache = new Database(snapshot, { readonly: true, fileMustExist: true });
const publicCacheFile = path.join(publicRoot, 'vectors.sqlite');
const publicCache = new Database(publicCacheFile, {
  readonly: true,
  fileMustExist: true,
});
const old = publicCache.prepare(
  'SELECT key,input,vector,vector_sha,purpose FROM entries WHERE key=?',
);
const apiCache = new Map();
const bindings = new Map();
const counts = { api: 0, public: 0, private: 0, total: 0 };
const streamHash = createHash('sha256');
async function pin(file) {
  const sha256 = await fileSha256(file);
  bindings.set(file, { path: file, sha256 });
  return sha256;
}
try {
  for (const row of cache
    .prepare(
      'SELECT key,input,vector,vector_sha,origin FROM vectors ORDER BY key',
    )
    .iterate()) {
    assert.equal(
      row.key,
      hash(JSON.stringify([frozen.model.fingerprint, row.input])),
    );
    assert.equal(row.vector.length, 4096);
    assert.equal(hash(row.vector), row.vector_sha);
    if (row.origin.startsWith('frozen-public:')) {
      const key = row.origin.slice('frozen-public:'.length);
      const reference = old.get(key);
      assert.ok(reference, 'Frozen public origin missing');
      assert.equal(reference.input, row.input);
      assert.equal(
        key,
        hash(
          JSON.stringify([
            frozen.model.fingerprint,
            reference.purpose,
            row.input,
          ]),
        ),
      );
      assert.equal(hash(reference.vector), reference.vector_sha);
      assert.equal(reference.vector_sha, row.vector_sha);
      counts.public++;
    } else if (row.origin.startsWith('frozen-private-capture:')) {
      assert.equal(row.origin, 'frozen-private-capture:' + seed.report.sha256);
      assert.equal(
        privateHashes.get(row.input),
        row.vector_sha,
        'Private capture vector mismatch',
      );
      counts.private++;
    } else {
      assert.ok(
        row.origin.startsWith('api-response:'),
        'Unknown model cache origin',
      );
      const id = row.origin.slice('api-response:'.length);
      assert.match(id, /^[0-9]+-[a-f0-9]+$/);
      if (!apiCache.has(id)) {
        const file = path.join(
          root,
          'embedding-gateway/responses',
          id + '.json',
        );
        await pin(file);
        const response = await read(file);
        assert.equal(response.status, 200);
        assert.equal(
          response.endpoint,
          'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
        );
        assert.equal(response.request.model, frozen.model.name);
        assert.equal(response.request.dimensions, 1024);
        assert.equal(response.request.encoding_format, 'float');
        assert.equal(response.body.model, frozen.model.name);
        assert.ok(
          Array.isArray(response.request.input) &&
            response.request.input.length > 0,
        );
        assert.equal(response.body.data.length, response.request.input.length);
        const vectorHashes = new Map();
        const indexes = new Set();
        for (const item of response.body.data) {
          assert.ok(
            Number.isInteger(item.index) &&
              item.index >= 0 &&
              item.index < response.request.input.length &&
              !indexes.has(item.index),
          );
          indexes.add(item.index);
          const vector = validateVectors([item.embedding], 1, 1024)[0];
          const digest = hash(Buffer.from(new Float32Array(vector).buffer));
          const input = response.request.input[item.index];
          if (vectorHashes.has(input))
            assert.equal(vectorHashes.get(input), digest);
          vectorHashes.set(input, digest);
        }
        apiCache.set(id, vectorHashes);
      }
      assert.equal(
        apiCache.get(id).get(row.input),
        row.vector_sha,
        'Upstream response vector mismatch',
      );
      counts.api++;
    }
    streamHash.update(
      JSON.stringify([row.key, row.vector_sha, row.origin]) + '\n',
    );
    counts.total++;
    if (counts.total % 25000 === 0)
      console.log(JSON.stringify({ verified: counts.total }));
  }
} finally {
  cache.close();
  publicCache.close();
}
for (const file of [
  ...Object.values(captureSources),
  indexFile,
  planFile,
  publicCacheFile,
  seed.report.path,
  seed.plan.path,
  snapshot,
])
  await pin(file);
// Execution bindings use import URLs so Windows Unicode paths remain exact.

for (const relative of [
  './audit-product-model-provenance.mjs',
  './product-embedding-gateway.mjs',
  './lib/product-embedding-queue.mjs',
  './lib/product-vector-cache.mjs',
  './lib/product-private-vectors.mjs',
  './lib/product-freeze.mjs',
  '../dist/embedding.js',
  '../dist/identity.js',
])
  await pin(fileURLToPath(new URL(relative, import.meta.url)));
const report = {
  status: 'verified',
  created_at: new Date().toISOString(),
  model: frozen.model,
  fingerprint: frozen.model.fingerprint,
  counts,
  api_responses: apiCache.size,
  cache_records_sha256: streamHash.digest('hex'),
  artifacts: [...bindings.values()],
  new_api_calls: 0,
};
const target = path.join(directory, 'report.json');
await fs.writeFile(target, JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    status: report.status,
    counts,
    api_responses: report.api_responses,
    report: target,
    sha256: await fileSha256(target),
    new_api_calls: 0,
  }),
);

if (process.argv.includes('--final')) {
  const freezeFile = path.join(root, 'freeze.json');
  const currentFreeze = await read(freezeFile);
  assert.equal(currentFreeze.status, 'frozen');
  assert.deepEqual(currentFreeze.model, frozen.model);
  await fs.writeFile(
    path.join(root, 'model-provenance/final.json'),
    JSON.stringify(
      {
        status: 'verified',
        freeze_sha256: await fileSha256(freezeFile),
        report: { path: target, sha256: await fileSha256(target) },
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
}
