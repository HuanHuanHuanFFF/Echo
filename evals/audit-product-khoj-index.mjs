import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import { jsonLines } from './prepare-product-comparison.mjs';
import { writeIndexReceipt } from './lib/product-index-receipt.mjs';
import { mapKhojCompiled } from './lib/khoj-evidence.mjs';
import { decodeVerifiedVector } from './lib/product-vector-cache.mjs';

const [rootArg, scope] = process.argv.slice(2);
assert.ok(rootArg && scope);
const root = path.resolve(rootArg);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const manifest = await read(path.join(root, 'corpus-v1/manifest.json'));
const frozen = await read(path.join(root, 'index-freeze.json'));
assert.equal(
  hash(await fs.readFile(path.join(root, 'corpus-v1/manifest.json'))),
  frozen.corpus_manifest_sha256,
);
const info = manifest.scopes[scope];
assert.ok(info);
const fixed = info.kind === 'official-fixed-unit';
assert.equal(hash(await fs.readFile(info.corpus.path)), info.corpus.sha256);
const directory = path.join(root, 'indexes/khoj', scope);
const indexFile = path.join(
  directory,
  fixed ? 'index-fixed-scope-receipt.json' : 'index-native-scope-receipt.json',
);
const indexed = await read(indexFile);
assert.equal(indexed.status, 'indexed');
assert.equal(indexed.inputs.corpus_sha256, info.corpus.sha256);
assert.match(indexed.username, /^echo-compare-[a-z0-9-]+$/);
const sources = new Map();
const extraArtifacts = [];
let vectorFile = path.join(root, 'embedding-gateway/vectors.sqlite');
if (fixed) {
  const corpus = new Map();
  for await (const source of jsonLines(info.corpus.path)) {
    assert.ok(!corpus.has(source.id));
    corpus.set(source.id, source);
  }
  const prepared = path.join(
    root,
    'khoj-runtime/input',
    'fixed-' + scope + '.jsonl',
  );
  assert.equal(
    hash(await fs.readFile(prepared)),
    indexed.indexed.input_jsonl_sha256,
  );
  const seen = new Set();
  for await (const entry of jsonLines(prepared)) {
    const source = corpus.get(entry.unit_id);
    assert.ok(source && !seen.has(entry.unit_id));
    seen.add(entry.unit_id);
    assert.equal(entry.raw, source.text);
    assert.equal(entry.compiled, source.text);
    assert.ok(!sources.has(entry.corpus_id));
    sources.set(entry.corpus_id, {
      ...source,
      relative_path: entry.file,
      expected_native_id: entry.corpus_id,
    });
  }
  assert.equal(seen.size, info.documents);
  const publicRoot = path.resolve(root, '..', 'public-benchmarks-2026-09-19');
  const planFile = path.join(publicRoot, 'embedding-plan.json');
  const plan = await read(planFile);
  assert.equal(plan.fingerprint, frozen.model.fingerprint);
  vectorFile = path.join(publicRoot, 'vectors.sqlite');
  extraArtifacts.push(prepared, planFile, vectorFile);
} else {
  for await (const source of jsonLines(info.corpus.path)) {
    assert.ok(!sources.has(source.relative_path));
    sources.set(source.relative_path, source);
  }
}
const vectors = new Database(vectorFile, {
  readonly: true,
  fileMustExist: true,
});
const cached = vectors.prepare(
  fixed
    ? "SELECT vector,vector_sha FROM entries WHERE key=? AND input=? AND purpose='document'"
    : 'SELECT vector,vector_sha FROM vectors WHERE key=? AND input=?',
);
const sql =
  "BEGIN READ ONLY; SELECT replace(encode(convert_to(json_build_object('entry_id',e.id,'native_id',e.corpus_id,'file',e.file_path,'entry',e.raw,'compiled',e.compiled,'heading',e.heading,'vector',e.embeddings::text)::text,'UTF8'),'base64'),chr(10),'') FROM database_entry e JOIN database_khojuser u ON e.user_id=u.id WHERE u.username='" +
  indexed.username +
  "'; COMMIT;";
const child = spawn(
  'docker',
  [
    'exec',
    'khoj-product-comparison-database-1',
    'psql',
    '-X',
    '-q',
    '-U',
    'khoj',
    '-d',
    'khoj',
    '-Atc',
    sql,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let stderr = '';
child.stderr.on('data', (part) => {
  stderr += part.toString();
});
const exited = new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', resolve);
});
const stamp = Date.now();
const snapshotFile = path.join(
  directory,
  'native-evidence-' + stamp + '.jsonl',
);
const snapshot = await fs.open(snapshotFile, 'wx');
const lines = readline.createInterface({
  input: child.stdout,
  crlfDelay: Infinity,
});
const audit = {
  status: 'verified',
  scope,
  corpus_sha256: info.corpus.sha256,
  documents: 0,
  entries: 0,
  cache_vectors_matched: 0,
  max_vector_delta: 0,
  mapping_gaps: [],
  vector_gaps: [],
  dimensions: 1024,
};
const seenFiles = new Set();
const seenIds = new Set();
const corpusIds = new Set();
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    let native;
    try {
      native = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
    } catch {
      throw new Error(
        'Invalid framed native database row at index ' + audit.entries,
      );
    }
    const sourceKey = fixed ? native.native_id : native.file;
    const source = sources.get(sourceKey);
    assert.ok(source, 'Native index has a file outside frozen corpus');
    assert.ok(
      !seenIds.has(native.entry_id),
      'Duplicate native database entry ID',
    );
    seenIds.add(native.entry_id);
    corpusIds.add(native.native_id);
    seenFiles.add(sourceKey);
    let mapped;
    if (fixed) {
      assert.equal(native.native_id, source.expected_native_id);
      assert.equal(native.file, source.relative_path);
      assert.equal(native.compiled, source.text);
      assert.equal(native.entry, source.text);
      mapped = { status: 'mapped', spans: [[0, source.text.length]] };
    } else mapped = mapKhojCompiled(native.compiled, source, native);
    if (!['mapped', 'metadata-only'].includes(mapped.status))
      audit.mapping_gaps.push({
        native_id: native.native_id,
        status: mapped.status,
        source_id: source.id,
      });
    const vector = JSON.parse(native.vector);
    assert.ok(
      vector.length === 1024 && vector.every(Number.isFinite),
      'Invalid native embedding',
    );
    const record = cached.get(
      hash(
        JSON.stringify(
          fixed
            ? [frozen.model.fingerprint, 'document', native.compiled]
            : [frozen.model.fingerprint, native.compiled],
        ),
      ),
      native.compiled,
    );
    if (!record) {
      audit.vector_gaps.push({
        native_id: native.native_id,
        reason: 'compiled-input-not-in-gateway-cache',
      });
    } else {
      const reference = decodeVerifiedVector(
        record.vector,
        record.vector_sha,
        1024,
      );
      const delta = Math.max(
        ...vector.map((value, i) => Math.abs(value - reference[i])),
      );
      audit.max_vector_delta = Math.max(audit.max_vector_delta, delta);
      if (delta > 1e-6)
        audit.vector_gaps.push({
          native_id: native.native_id,
          reason: 'vector-differs-from-bound-input',
          max_delta: delta,
        });
      else audit.cache_vectors_matched++;
    }
    const { vector: ignored, ...evidence } = native;
    await snapshot.write(
      JSON.stringify({
        ...evidence,
        source_id: source.id,
        mapping: mapped,
        vector_sha256: hash(Buffer.from(new Float32Array(vector).buffer)),
      }) + '\n',
    );
    audit.entries++;
  }
  assert.equal(
    await exited,
    0,
    'Native database read failed: ' + stderr.slice(-500),
  );
} finally {
  await snapshot.close();
  vectors.close();
}
audit.documents = seenFiles.size;
audit.distinct_corpus_ids = corpusIds.size;
if (fixed) {
  assert.equal(audit.entries, info.documents);
  assert.equal(corpusIds.size, info.documents);
}
audit.model_fingerprint = frozen.model.fingerprint;
audit.missing_source_ids = [...sources.entries()]
  .filter(([file]) => !seenFiles.has(file))
  .map(([, source]) => source.id);
if (
  audit.mapping_gaps.length ||
  audit.vector_gaps.length ||
  audit.missing_source_ids.length
)
  audit.status = 'failed';
const auditFile = path.join(directory, 'native-audit-' + stamp + '.json');
await fs.writeFile(auditFile, JSON.stringify(audit, null, 2) + '\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    scope,
    status: audit.status,
    documents: audit.documents,
    entries: audit.entries,
    mapping_gaps: audit.mapping_gaps.length,
    vector_gaps: audit.vector_gaps.length,
  }),
);
assert.equal(
  audit.status,
  'verified',
  'Native index audit failed; inspect local receipt',
);
await writeIndexReceipt({
  root,
  product: 'khoj',
  scope,
  info,
  modelFingerprint: frozen.model.fingerprint,
  artifacts: [indexFile, snapshotFile, auditFile, ...extraArtifacts],
  audits: [
    { kind: fixed ? 'fixed-evidence' : 'native-evidence', path: auditFile },
  ],
  fixed,
});
