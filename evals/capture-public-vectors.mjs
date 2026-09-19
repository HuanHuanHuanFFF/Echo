import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { jsonLines, lastRowsById } from './prepare-public-benchmarks.mjs';
const hash = (x) => createHash('sha256').update(x).digest('hex');
const root = path.resolve(process.argv[2] ?? '');
const phase = process.argv[3],
  scope = process.argv[4] ?? 'qasper';
assert.ok(process.argv[2] && ['register', 'capture', 'status'].includes(phase));
const runtime = path.join(root, 'runtime/dist');
const { openDatabase } = await import(
  pathToFileURL(path.join(runtime, 'database.js')).href
);
const { embeddingFingerprint, validateVectors } = await import(
  pathToFileURL(path.join(runtime, 'embedding.js')).href
);
const cfg = {
  provider: 'http',
  base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.7-text-embedding',
  dimensions: 1024,
  api_key_env: 'CHROMA_OPENAI_API_KEY',
  timeout_ms: 30000,
  batch_size: 8,
  document_prefix: '',
  query_prefix: '',
  send_dimensions: true,
};
const fingerprint = embeddingFingerprint(cfg);
const maxAttempts = 12,
  concurrency = 2;
let nextRequestAt = 0,
  cooldownUntil = 0;
async function pace(input) {
  const when = Math.max(Date.now(), nextRequestAt, cooldownUntil);
  const estimatedTokens = input.reduce((n, t) => n + t.length * 0.4, 0);
  nextRequestAt =
    when + Math.max(1000, Math.ceil((estimatedTokens / 12000) * 1000));
  while (Date.now() < Math.max(when, cooldownUntil))
    await new Promise((r) =>
      setTimeout(
        r,
        Math.min(30000, Math.max(when, cooldownUntil) - Date.now()),
      ),
    );
}
const db = openDatabase(path.join(root, 'vectors.sqlite'));
db.exec(
  'CREATE TABLE IF NOT EXISTS entries(key TEXT PRIMARY KEY,purpose TEXT NOT NULL,input TEXT NOT NULL,vector BLOB,vector_sha TEXT,request_id INTEGER); CREATE TABLE IF NOT EXISTS members(scope TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(scope,key)); CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,started TEXT NOT NULL,keys_json TEXT NOT NULL,input_chars INTEGER NOT NULL,status TEXT NOT NULL,tokens INTEGER,response_file TEXT,error TEXT); CREATE TABLE IF NOT EXISTS info(key TEXT PRIMARY KEY,value TEXT NOT NULL);',
);
const existing = db
  .prepare("SELECT value FROM info WHERE key='fingerprint'")
  .get();
if (existing) assert.equal(existing.value, fingerprint);
else
  db.prepare('INSERT INTO info VALUES (?,?)').run('fingerprint', fingerprint);
const keyFor = (purpose, input) =>
  hash(JSON.stringify([fingerprint, purpose, input]));
const insert = db.prepare(
  'INSERT OR IGNORE INTO entries(key,purpose,input) VALUES (?,?,?)',
);
const membership = db.prepare('INSERT OR IGNORE INTO members VALUES (?,?)');
function add(group, purpose, text) {
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
  const key = keyFor(purpose, text);
  insert.run(key, purpose, text);
  membership.run(group, key);
}
const status = () => ({
  scopes: db
    .prepare(
      'SELECT scope,count(*) texts,sum(e.vector IS NOT NULL) ready FROM members m JOIN entries e USING(key) GROUP BY scope',
    )
    .all(),
  usage: db
    .prepare(
      "SELECT count(*) attempts,sum(input_chars) input_chars,sum(tokens) reported_tokens,sum(status='success') succeeded,sum(status!='success') failed_or_inflight FROM attempts",
    )
    .get(),
});
try {
  if (phase === 'register') {
    for (const name of ['heading', 'structure']) {
      db.exec('BEGIN');
      try {
        for await (const c of jsonLines(
          path.join(root, 'prepared', name + '-chunks.jsonl'),
        ))
          add('qasper', 'document', c.input);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
    for await (const q of jsonLines(
      path.join(root, 'prepared/qasper-queries.jsonl'),
    ))
      add('qasper', 'query', q.text.trim());
    for (const name of ['langchain', 'godot']) {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM members WHERE scope=?').run(name);
        for (const c of (
          await lastRowsById(
            path.join(root, 'data/freshstack-' + name + '-corpus.jsonl'),
          )
        ).values())
          add(name, 'document', c.text);
        for await (const q of jsonLines(
          path.join(root, 'data/freshstack-' + name + '-queries.jsonl'),
        ))
          add(name, 'query', (q.query_title + ' ' + q.query_text).trim());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
    db.exec('BEGIN');
    try {
      for await (const c of jsonLines(path.join(root, 'data/du-corpus.jsonl')))
        add('du', 'document', c.text);
      for await (const q of jsonLines(path.join(root, 'data/du-queries.jsonl')))
        add('du', 'query', q.text.trim());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const inventory = db
      .prepare(
        'SELECT purpose,count(*) texts,sum(length(input)) chars FROM entries e WHERE EXISTS(SELECT 1 FROM members m WHERE m.key=e.key) GROUP BY purpose',
      )
      .all();
    await fs.writeFile(
      path.join(root, 'embedding-plan.json'),
      JSON.stringify(
        {
          fingerprint,
          config: cfg,
          inventory,
          input_chars_unit:
            'Unicode code points in inventory; UTF-16 code units in request ledger',
          prepared_sha256: hash(
            await fs.readFile(path.join(root, 'prepared/audit.json')),
          ),
          conversion_sha256: hash(
            await fs.readFile(path.join(root, 'conversion-manifest.json')),
          ),
          ...status(),
          max_attempts_per_input: maxAttempts,
          concurrency,
          input_policy:
            'Full published text; no silent truncation; benchmark 2048-token leaderboards are reference only.',
          new_baseline_model: false,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(JSON.stringify({ inventory, ...status() }));
  } else if (phase === 'status') console.log(JSON.stringify(status()));
  else {
    assert.ok(['qasper', 'langchain', 'godot', 'du'].includes(scope));
    const plan = JSON.parse(
      await fs.readFile(path.join(root, 'embedding-plan.json'), 'utf8'),
    );
    assert.equal(plan.fingerprint, fingerprint);
    assert.equal(
      plan.prepared_sha256,
      hash(await fs.readFile(path.join(root, 'prepared/audit.json'))),
    );
    assert.equal(
      plan.conversion_sha256,
      hash(await fs.readFile(path.join(root, 'conversion-manifest.json'))),
    );
    await fs.appendFile(
      path.join(root, 'capture-policy-history.jsonl'),
      JSON.stringify({
        started: new Date().toISOString(),
        scope,
        maxAttempts,
        concurrency,
        min_start_interval_ms: 1000,
        estimated_tokens_per_second: 12000,
        quota_cooldown_ms: 15000,
        reason: 'TPM quota recovery; past attempts retained',
        script_sha256: hash(await fs.readFile(new URL(import.meta.url))),
      }) + '\n',
    );
    const key = process.env[cfg.api_key_env];
    assert.ok(key, 'Embedding key missing');
    const lock = path.join(root, 'capture.lock');
    const nonce = randomUUID();
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, nonce }), {
      flag: 'wx',
    });
    try {
      const rows = db
        .prepare(
          'SELECT e.key,e.purpose,e.input FROM entries e JOIN members m USING(key) WHERE m.scope=? AND e.vector IS NULL ORDER BY e.purpose,e.rowid',
        )
        .all(scope);
      // Retries from interrupted prior runs count toward the same per-input bound.
      const history = new Map();
      for (const a of db.prepare('SELECT keys_json FROM attempts').all())
        for (const k of JSON.parse(a.keys_json))
          history.set(k, (history.get(k) ?? 0) + 1);
      for (const r of rows)
        assert.ok(
          (history.get(r.key) ?? 0) < maxAttempts,
          'Retry budget exhausted for an input',
        );
      for (const r of rows) assert.equal(r.key, keyFor(r.purpose, r.input));
      const groups = [];
      for (const purpose of ['document', 'query']) {
        const selected = rows.filter((r) => r.purpose === purpose);
        for (let i = 0; i < selected.length; i += 8)
          groups.push(selected.slice(i, i + 8));
      }
      await fs.mkdir(path.join(root, 'api-responses'), { recursive: true });
      let cursor = 0,
        done = 0,
        fatal = null;
      const start = db.prepare(
        'INSERT INTO attempts(started,keys_json,input_chars,status) VALUES (?,?,?,?)',
      );
      const finish = db.prepare(
        'UPDATE attempts SET status=?,tokens=?,response_file=?,error=? WHERE id=?',
      );
      const cache = db.prepare(
        'UPDATE entries SET vector=?,vector_sha=?,request_id=? WHERE key=?',
      );
      const save = db.transaction((batch, vectors, id) => {
        batch.forEach((r, i) => {
          const bytes = Buffer.from(new Float32Array(vectors[i]).buffer);
          cache.run(bytes, hash(bytes), id, r.key);
        });
      });
      async function batchRun(batch) {
        const tries = Math.min(
          ...batch.map((r) => maxAttempts - (history.get(r.key) ?? 0)),
        );
        for (let n = 0; n < tries; n++) {
          const input = batch.map((r) => r.input);
          await pace(input);
          const id = Number(
            start.run(
              new Date().toISOString(),
              JSON.stringify(batch.map((r) => r.key)),
              input.reduce((s, t) => s + t.length, 0),
              'inflight',
            ).lastInsertRowid,
          );
          let retry = false;
          try {
            const response = await fetch(cfg.base_url + '/embeddings', {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(cfg.timeout_ms),
              headers: {
                'content-type': 'application/json',
                Authorization: 'Bearer ' + key,
              },
              body: JSON.stringify({
                model: cfg.model,
                input,
                dimensions: cfg.dimensions,
                encoding_format: 'float',
              }),
            });
            const raw = await response.text();
            const responseFile = 'api-responses/' + id + '.json.gz';
            await fs.writeFile(path.join(root, responseFile), gzipSync(raw), {
              flag: 'wx',
            });
            if (!response.ok) {
              retry = response.status === 429 || response.status >= 500;
              if (response.status === 429)
                cooldownUntil = Math.max(
                  cooldownUntil,
                  Date.now() +
                    Math.max(
                      15000,
                      Math.min(
                        60000,
                        Number(response.headers.get('retry-after') ?? 0) * 1000,
                      ),
                    ),
                );
              finish.run(
                'http_' + response.status,
                null,
                responseFile,
                null,
                id,
              );
              throw Error('Embedding HTTP ' + response.status);
            }
            const payload = JSON.parse(raw);
            assert.equal(payload.data.length, batch.length);
            const sorted = [...payload.data].sort((a, b) => a.index - b.index);
            sorted.forEach((v, i) => assert.equal(v.index, i));
            const vectors = validateVectors(
              sorted.map((v) => v.embedding),
              batch.length,
              1024,
            );
            const tokens = Number.isSafeInteger(payload.usage?.total_tokens)
              ? payload.usage.total_tokens
              : null;
            db.transaction(() => {
              save(batch, vectors, id);
              finish.run('success', tokens, responseFile, null, id);
            })();
            return;
          } catch (e) {
            const row = db
              .prepare('SELECT status FROM attempts WHERE id=?')
              .get(id);
            if (row.status === 'inflight') {
              finish.run(
                'failed',
                null,
                null,
                String(e.message).slice(0, 200),
                id,
              );
              retry = e.name === 'TimeoutError' || e.name === 'TypeError';
            }
            if (!retry || n === tries - 1) throw e;
            await new Promise((r) =>
              setTimeout(r, Math.min(30000, 1500 * 2 ** n)),
            );
          }
        }
      }
      async function worker() {
        while (!fatal) {
          const i = cursor++;
          if (i >= groups.length) return;
          try {
            await batchRun(groups[i]);
            done++;
            if (done % 20 === 0 || done === groups.length)
              console.log(
                JSON.stringify({
                  scope,
                  completed_batches: done,
                  total_batches: groups.length,
                  ...status().usage,
                }),
              );
          } catch (e) {
            fatal = e;
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (fatal) throw fatal;
      console.log(JSON.stringify({ scope, completed: true, ...status() }));
    } finally {
      const state = JSON.parse(await fs.readFile(lock, 'utf8'));
      assert.equal(state.nonce, nonce);
      await fs.unlink(lock);
    }
  }
} finally {
  db.close();
}
