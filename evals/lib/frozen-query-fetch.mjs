import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const hash = (text) => createHash('sha256').update(text).digest('hex');

// Task-local replay of REAL successful API responses. Never fabricates vectors.
// Replayed token usage is zero; provider "requests" still counts logical calls.
export function frozenQueryFetch({
  fetchFn,
  endpoint,
  model,
  dimensions,
  validate,
  seeds = [],
  offlineOnly = false,
  onCapture = async () => {},
  onUse = async () => {},
}) {
  const cache = new Map();
  for (const entry of seeds) {
    const body = entry.request;
    assert.equal(body.model, model);
    assert.equal(body.dimensions, dimensions);
    assert.equal(body.encoding_format, 'float');
    assert.ok(
      Array.isArray(body.input) &&
        body.input.length === 1 &&
        typeof body.input[0] === 'string',
    );
    assert.equal(entry.key, hash(endpoint + '\n' + JSON.stringify(body)));
    assert.equal(
      entry.vector_sha256,
      hash(JSON.stringify(entry.response.data)),
    );
    assert.ok(!cache.has(entry.key), 'Duplicate frozen query');
    const payload = structuredClone(entry.response);
    validate(payload, body.input.length);
    cache.set(
      entry.key,
      Promise.resolve({
        payload,
        vectorHash: entry.vector_sha256,
      }),
    );
  }
  let logical = 0,
    network = 0,
    reused = 0,
    inputChars = 0,
    tokens = 0,
    known = 0;
  return {
    stats: () => ({
      logical_requests: logical,
      network_requests: network,
      reused_responses: reused,
      network_input_chars: inputChars,
      network_reported_tokens: known === network ? tokens : null,
      response_keys: cache.size,
      seeded_responses: seeds.length,
    }),
    forRun(run, allowedTexts) {
      return async (url, options) => {
        assert.equal(String(url), endpoint);
        assert.equal(options?.method, 'POST');
        assert.equal(options?.redirect, 'error');
        const body = JSON.parse(options.body);
        assert.equal(body.model, model);
        assert.equal(body.dimensions, dimensions);
        assert.equal(body.encoding_format, 'float');
        assert.ok(Array.isArray(body.input) && body.input.length === 1);
        assert.ok(
          allowedTexts.has(body.input[0]),
          'Query not allowed for this run',
        );
        options.signal?.throwIfAborted();
        const key = hash(endpoint + '\n' + JSON.stringify(body));
        const hit = cache.has(key);
        assert.ok(
          hit || !offlineOnly,
          'Frozen query missing; network disabled',
        );
        logical++;
        if (hit) reused++;
        else {
          // Store the pending promise synchronously, so duplicate concurrent
          // queries do not become extra network calls. Failures remain failed.
          cache.set(
            key,
            (async () => {
              network++;
              inputChars += body.input[0].length;
              const response = await fetchFn(url, options);
              if (!response.ok) {
                await response.body?.cancel();
                throw new Error('Embedding API HTTP ' + response.status);
              }
              const payload = await response.json();
              validate(payload, body.input.length);
              const cost = payload.usage?.total_tokens;
              if (Number.isSafeInteger(cost) && cost >= 0) {
                tokens += cost;
                known++;
              }
              const vectorHash = hash(JSON.stringify(payload.data));
              await onCapture({
                key,
                request: body,
                response: payload,
                vector_sha256: vectorHash,
              });
              return { payload, vectorHash };
            })(),
          );
        }
        const saved = await cache.get(key);
        options.signal?.throwIfAborted();
        await onUse({
          run,
          request_sha256: key,
          vector_sha256: saved.vectorHash,
          reused: hit,
        });
        const returned = hit
          ? { ...saved.payload, usage: { total_tokens: 0 } }
          : saved.payload;
        return new Response(JSON.stringify(returned), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
    },
  };
}
