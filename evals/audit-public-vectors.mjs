import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runtimeContext } from './lib/public-runtime.mjs';
const root = path.resolve(process.argv[2] ?? ''),
  scope = process.argv[3];
assert.ok(
  process.argv[2] &&
    ['qasper', 'langchain', 'godot', 'du', 'all'].includes(scope),
);
const ctx = await runtimeContext(root);
const hash = (x) => createHash('sha256').update(x).digest('hex');
const { validateVectors } = await import(
  pathToFileURL(path.join(root, 'runtime/dist/embedding.js')).href
);
const db = ctx.cache;
try {
  const entries =
    scope === 'all'
      ? db
          .prepare(
            'SELECT e.* FROM entries e WHERE EXISTS(SELECT 1 FROM members m WHERE m.key=e.key) ORDER BY key',
          )
          .all()
      : db
          .prepare(
            'SELECT e.* FROM entries e JOIN members m USING(key) WHERE m.scope=? ORDER BY e.key',
          )
          .all(scope);
  assert.ok(entries.length > 0);
  const vectorDigest = createHash('sha256'),
    requestIds = new Set();
  for (const e of entries) {
    assert.ok(e.vector, 'Vector missing ' + e.key);
    assert.equal(
      e.key,
      hash(JSON.stringify([ctx.plan.fingerprint, e.purpose, e.input])),
    );
    assert.equal(hash(e.vector), e.vector_sha);
    assert.equal(e.vector.byteLength, 4096);
    requestIds.add(e.request_id);
    vectorDigest.update(
      JSON.stringify([e.key, e.vector_sha, e.request_id]) + '\n',
    );
  }
  const find = db.prepare('SELECT * FROM entries WHERE key=?');
  const attempt = db.prepare('SELECT * FROM attempts WHERE id=?');
  const rawDigest = createHash('sha256');
  let tokens = 0,
    unknownUsage = 0;
  for (const id of [...requestIds].sort((a, b) => a - b)) {
    const a = attempt.get(id);
    assert.equal(a.status, 'success');
    const keys = JSON.parse(a.keys_json);
    const raw = fs.readFileSync(path.join(root, a.response_file));
    const payload = JSON.parse(gunzipSync(raw).toString('utf8'));
    assert.equal(payload.model, ctx.plan.config.model);
    const sorted = [...payload.data].sort((a, b) => a.index - b.index);
    assert.equal(sorted.length, keys.length);
    sorted.forEach((v, i) => assert.equal(v.index, i));
    const vectors = validateVectors(
      sorted.map((v) => v.embedding),
      keys.length,
      1024,
    );
    let chars = 0;
    keys.forEach((key, i) => {
      const e = find.get(key);
      assert.equal(e.request_id, id);
      assert.equal(
        hash(Buffer.from(new Float32Array(vectors[i]).buffer)),
        e.vector_sha,
      );
      chars += e.input.length;
    });
    assert.equal(chars, a.input_chars);
    assert.equal(payload.usage?.total_tokens ?? null, a.tokens);
    if (a.tokens === null) unknownUsage++;
    else tokens += a.tokens;
    rawDigest.update(
      JSON.stringify([id, a.keys_json, hash(raw), a.tokens]) + '\n',
    );
  }
  const receipt = {
    scope,
    created: new Date().toISOString(),
    model: ctx.plan.config.model,
    dimensions: 1024,
    fingerprint: ctx.plan.fingerprint,
    active_inputs: entries.length,
    successful_requests_referenced: requestIds.size,
    known_tokens_for_referenced_requests: tokens,
    unknown_usage_successes: unknownUsage,
    inputs_vectors_request_ids_sha256: vectorDigest.digest('hex'),
    raw_response_chain_sha256: rawDigest.digest('hex'),
    checks: [
      'all inputs match fingerprint/purpose/text key',
      'all raw success models and dimensions match',
      'all cache vectors equal normalized raw API vectors',
      'all raw response indexes and counts match request keys',
      'all raw token usage and input character counts match ledger',
    ],
    usage: db
      .prepare(
        'SELECT status,count(*) attempts,sum(input_chars) input_chars,sum(tokens) reported_tokens FROM attempts GROUP BY status',
      )
      .all(),
    usage_note:
      'Global ledger snapshot; per-scope referenced request tokens may overlap other scopes; failed calls without reported tokens are unknown, not zero.',
  };
  if (scope === 'all') {
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM attempts WHERE status='inflight'")
        .get().n,
      0,
    );
    receipt.capture_policy_history_sha256 = hash(
      fs.readFileSync(path.join(root, 'capture-policy-history.jsonl')),
    );
  }
  fs.writeFileSync(
    path.join(root, 'analysis', scope + '-vector-audit.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  );
  console.log(JSON.stringify(receipt));
} finally {
  db.close();
}
