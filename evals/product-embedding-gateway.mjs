import assert from 'node:assert/strict';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createEmbeddingQueue } from './lib/product-embedding-queue.mjs';
import { decodeVerifiedVector } from './lib/product-vector-cache.mjs';
import { embeddingFingerprint, validateVectors } from '../dist/embedding.js';

const [profileFile, publicRoot, outArg, mode = 'cache-only'] =
  process.argv.slice(2);
assert.ok(
  profileFile && publicRoot && outArg,
  'Expected PROFILE PUBLIC_ROOT GATEWAY_DIR [cache-only|live]',
);
assert.ok(['cache-only', 'live'].includes(mode));
const out = path.resolve(outArg);
await fs.mkdir(out, { recursive: true });
const config = JSON.parse(await fs.readFile(profileFile, 'utf8'));
assert.equal(config.model, 'qwen3.7-text-embedding');
assert.equal(config.dimensions, 1024);
assert.equal(
  config.base_url,
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
);
assert.equal(config.document_prefix, '');
assert.equal(config.query_prefix, '');
assert.equal(config.batch_size, 8);
assert.equal(config.send_dimensions, true);
assert.equal(config.timeout_ms, 30000);
const fingerprint = embeddingFingerprint(config);
const endpoint = config.base_url + '/embeddings';
const secret = process.env[config.api_key_env];
if (mode === 'live')
  assert.ok(secret, 'Configured embedding credential is unavailable');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value) + '\n';
const tokenFile = path.join(out, 'gateway-token.txt');
let token;
try {
  token = await fs.readFile(tokenFile, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  token = randomBytes(32).toString('hex');
  await fs.writeFile(tokenFile, token, { flag: 'wx', mode: 0o600 });
}
const oldDb = new Database(path.join(publicRoot, 'vectors.sqlite'), {
  readonly: true,
  fileMustExist: true,
});
const oldGet = oldDb.prepare(
  'SELECT input,vector,vector_sha FROM entries WHERE key=?',
);
const db = new Database(path.join(out, 'vectors.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(
  'CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, input TEXT NOT NULL, vector BLOB NOT NULL, vector_sha TEXT NOT NULL, origin TEXT NOT NULL)',
);
const get = db.prepare('SELECT * FROM vectors WHERE key=?');
const put = db.prepare(
  'INSERT OR IGNORE INTO vectors (key,input,vector,vector_sha,origin) VALUES (?,?,?,?,?)',
);
const encode = (vector) => Buffer.from(new Float32Array(vector).buffer);
const inputKey = (text) => sha(JSON.stringify([fingerprint, text]));
let nextCall = 0;
let apiAttempts = 0;
let reportedTokens = 0;
let cacheHits = 0;
let calls = 0;

function cached(text) {
  const key = inputKey(text);
  const own = get.get(key);
  if (own) {
    assert.equal(own.input, text);
    assert.equal(sha(own.vector), own.vector_sha);
    return decodeVerifiedVector(own.vector, own.vector_sha, config.dimensions);
  }
  for (const purpose of ['document', 'query']) {
    const previousKey = sha(JSON.stringify([fingerprint, purpose, text]));
    const row = oldGet.get(previousKey);
    if (!row) continue;
    assert.equal(row.input, text);
    assert.equal(row.vector.length, 4096);
    assert.equal(sha(row.vector), row.vector_sha);
    const vector = decodeVerifiedVector(
      row.vector,
      row.vector_sha,
      config.dimensions,
    );
    put.run(
      key,
      text,
      row.vector,
      row.vector_sha,
      'frozen-public:' + previousKey,
    );
    return vector;
  }
}

async function remote(batch) {
  assert.equal(mode, 'live', 'New embedding disabled in cache-only mode');
  const request = {
    model: config.model,
    input: batch,
    encoding_format: 'float',
    dimensions: 1024,
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    if (Date.now() < nextCall)
      await new Promise((resolve) =>
        setTimeout(resolve, nextCall - Date.now()),
      );
    nextCall = Date.now() + 500;
    const id = `${Date.now()}-${randomBytes(6).toString('hex')}`;
    const start = performance.now();
    apiAttempts++;
    await fs.appendFile(
      path.join(out, 'attempts.jsonl'),
      json({
        id,
        attempt,
        phase: 'started',
        count: batch.length,
        input_chars: batch.reduce((n, s) => n + s.length, 0),
        input_sha256: batch.map(sha),
      }),
    );
    let status;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeout_ms),
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + secret,
        },
        body: JSON.stringify(request),
      });
      status = response.status;
      const body = await response.json();
      await fs.writeFile(
        path.join(out, 'responses', id + '.json'),
        json({
          endpoint,
          request,
          status,
          body,
          elapsed_ms: performance.now() - start,
        }),
        { flag: 'wx' },
      );
      await fs.appendFile(
        path.join(out, 'attempts.jsonl'),
        json({
          id,
          attempt,
          phase: 'finished',
          status,
          usage: body.usage ?? null,
        }),
      );
      if (!response.ok) {
        if ((status === 429 || status >= 500) && attempt < 4) {
          nextCall = Date.now() + Math.min(30000, 1000 * 2 ** attempt);
          continue;
        }
        throw new Error('Embedding upstream HTTP ' + status);
      }
      assert.equal(body.data?.length, batch.length);
      const ordered = new Array(batch.length);
      for (const row of body.data) {
        assert.ok(
          Number.isInteger(row.index) &&
            row.index >= 0 &&
            row.index < batch.length &&
            ordered[row.index] === undefined,
        );
        ordered[row.index] = row.embedding;
      }
      const vectors = validateVectors(ordered, batch.length, 1024);
      const usage = body.usage?.total_tokens;
      if (Number.isInteger(usage)) reportedTokens += usage;
      db.transaction(() =>
        vectors.forEach((vector, i) => {
          const bytes = encode(vector);
          put.run(
            inputKey(batch[i]),
            batch[i],
            bytes,
            sha(bytes),
            'api-response:' + id,
          );
        }),
      )();
      return;
    } catch (error) {
      await fs.appendFile(
        path.join(out, 'attempts.jsonl'),
        json({
          id,
          attempt,
          phase: 'error',
          status: status ?? null,
          name: error.name,
        }),
      );
      throw error;
    }
  }
}

const embeddings = createEmbeddingQueue({
  cached,
  remote,
  batchSize: config.batch_size,
  onHit: () => {
    cacheHits++;
  },
});

await fs.mkdir(path.join(out, 'responses'), { recursive: true });
const server = createServer(async (req, res) => {
  const respond = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.url === '/health')
    return respond(200, {
      status: 'ok',
      mode,
      model: config.model,
      dimensions: 1024,
      calls,
      cache_hits: cacheHits,
      api_attempts: apiAttempts,
      reported_tokens: reportedTokens,
    });
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + token);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return respond(401, { error: 'Unauthorized' });
  if (req.method === 'GET' && req.url === '/v1/models')
    return respond(200, {
      object: 'list',
      data: [{ id: config.model, object: 'model' }],
    });
  if (
    req.method !== 'POST' ||
    !['/v1/embeddings', '/embeddings'].includes(req.url)
  )
    return respond(404, { error: 'Unknown endpoint' });
  let length = 0;
  const parts = [];
  try {
    for await (const part of req) {
      length += part.length;
      assert.ok(length <= 16 * 1024 * 1024, 'Request too large');
      parts.push(part);
    }
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    assert.equal(body.model, config.model);
    assert.ok(body.dimensions === undefined || body.dimensions === 1024);
    assert.ok(
      body.encoding_format === undefined || body.encoding_format === 'float',
    );
    const inputs = typeof body.input === 'string' ? [body.input] : body.input;
    assert.ok(
      Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 2000,
    );
    assert.ok(
      inputs.every(
        (text) => typeof text === 'string' && text.trim().length > 0,
      ),
    );
    calls++;
    const started = performance.now();
    const vectors = await embeddings(inputs);
    await fs.appendFile(
      path.join(out, 'requests.jsonl'),
      json({
        at: new Date().toISOString(),
        model: config.model,
        dimensions: 1024,
        count: inputs.length,
        input_sha256: inputs.map(sha),
        input_chars: inputs.map((text) => text.length),
        elapsed_ms: performance.now() - started,
      }),
    );
    // Billing is recorded from actual API receipts, never invented for cache hits.
    respond(200, {
      object: 'list',
      model: config.model,
      data: vectors.map((embedding, index) => ({
        object: 'embedding',
        index,
        embedding,
      })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
      echo_gateway_usage:
        'see receipts; response token counters are not billing',
    });
  } catch (error) {
    await fs.appendFile(
      path.join(out, 'errors.jsonl'),
      json({
        at: new Date().toISOString(),
        type: error.name,
        message: error.message,
      }),
    );
    respond(502, { error: 'Embedding gateway failed; inspect local receipt' });
  }
});
server.listen(15109, '0.0.0.0', async () => {
  await fs.writeFile(
    path.join(out, 'state.json'),
    json({
      pid: process.pid,
      mode,
      endpoint,
      model: config.model,
      dimensions: 1024,
      fingerprint,
      vector_transform: 'unit-float32-v1',
      source_cache: path.join(publicRoot, 'vectors.sqlite'),
      port: 15109,
    }),
  );
  console.log(
    JSON.stringify({
      status: 'listening',
      port: 15109,
      mode,
      model: config.model,
      dimensions: 1024,
    }),
  );
});
