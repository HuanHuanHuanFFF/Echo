import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2]);
const { openDatabase } = await import(
  pathToFileURL(path.join(root, 'runtime/dist/database.js')).href
);
const db = openDatabase(path.join(root, 'vectors.sqlite'), { readOnly: true });
try {
  const counts = new Map();
  let attempts = 0,
    maximum = 0;
  for (const r of db
    .prepare('SELECT id,keys_json,status FROM attempts ORDER BY id')
    .iterate()) {
    const keys = JSON.parse(r.keys_json);
    assert.ok(keys.length > 0 && keys.length <= 8);
    assert.equal(new Set(keys).size, keys.length);
    assert.notEqual(r.status, 'inflight');
    for (const k of keys) {
      const value = (counts.get(k) ?? 0) + 1;
      counts.set(k, value);
      maximum = Math.max(maximum, value);
    }
    attempts++;
  }
  assert.ok(maximum <= 12);
  const result = {
    attempts,
    unique_inputs: counts.size,
    max_attempts_per_input: maximum,
    configured_upper_bound: 12,
    no_inflight: true,
    all_requests_at_most_8_unique_inputs: true,
  };
  fs.writeFileSync(
    path.join(root, 'analysis/capture-attempt-bound-audit.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
