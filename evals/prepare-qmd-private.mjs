import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const [comparisonArg, qmdArg] = process.argv.slice(2);
assert.ok(
  comparisonArg && qmdArg,
  'Usage: node evals/prepare-qmd-private.mjs COMPARISON_ROOT QMD_ROOT',
);
const comparisonRoot = path.resolve(comparisonArg);
const qmdRoot = path.resolve(qmdArg);
const corpusRoot = path.join(comparisonRoot, 'corpus-v1');
const outputRoot = path.join(qmdRoot, 'private-data');
const scopes = ['A-test', 'B-test', 'C-test', 'D-test', 'mixed-test'];
const sha = (value) => createHash('sha256').update(value).digest('hex');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const readRows = async (file) =>
  (await fs.readFile(file, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));

const manifestFile = path.join(corpusRoot, 'manifest.json');
const manifestBytes = await fs.readFile(manifestFile);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const freeze = await readJson(path.join(comparisonRoot, 'freeze.json'));
assert.equal(freeze.status, 'frozen');
assert.equal(sha(manifestBytes), freeze.corpus_manifest_sha256);
assert.deepEqual(
  Object.keys(manifest.scopes)
    .filter((name) => scopes.includes(name))
    .sort(),
  [...scopes].sort(),
);
await assert.rejects(fs.stat(outputRoot), { code: 'ENOENT' });
await fs.mkdir(outputRoot, { recursive: true });

const records = [];
for (const scope of scopes) {
  const info = manifest.scopes[scope];
  assert.equal(info.kind, 'full-document');
  for (const input of [info.corpus, info.queries, info.labels]) {
    assert.ok(input.path && input.sha256);
    assert.equal(sha(await fs.readFile(input.path)), input.sha256);
  }
  const documents = await readRows(info.corpus.path);
  const questions = await readRows(info.queries.path);
  const base = path.join(outputRoot, scope);
  const paths = new Set();
  const mapped = [];
  for (const source of documents) {
    assert.match(source.id, /^[A-Za-z0-9_-]+$/);
    assert.match(source.collection_id, /^[A-Za-z0-9_-]+$/);
    assert.equal(path.extname(source.relative_path).toLowerCase(), '.md');
    assert.equal(sha(source.text), source.text_sha256);
    const file = path.resolve(base, source.collection_id, source.relative_path);
    assert.ok(
      file.startsWith(base + path.sep),
      'Source path escapes QMD collection',
    );
    const key = file.toLowerCase();
    assert.ok(!paths.has(key), 'Duplicate QMD source path');
    paths.add(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source.text, { encoding: 'utf8', flag: 'wx' });
    assert.equal(sha(await fs.readFile(file)), source.text_sha256);
    mapped.push({
      source_id: source.id,
      collection_id: source.collection_id,
      relative_path: source.relative_path,
      qmd_relative_path: path.relative(base, file).replaceAll('\\', '/'),
      text_sha256: source.text_sha256,
    });
  }
  records.push({
    scope,
    corpus_sha256: info.corpus.sha256,
    queries_sha256: info.queries.sha256,
    labels_sha256: info.labels.sha256,
    documents: documents.length,
    questions: questions.length,
    files: mapped,
  });
  console.log(
    `${scope}: ${documents.length} Markdown files, ${questions.length} questions`,
  );
}
const privateQuestions = records.reduce((sum, row) => sum + row.questions, 0);
assert.equal(privateQuestions, 200);
const output = {
  schema: 'echo-qmd-private-preparation-v1',
  comparison_root: comparisonRoot,
  corpus_manifest_sha256: sha(manifestBytes),
  qmd_root: qmdRoot,
  private_questions: privateQuestions,
  scopes: records,
};
await fs.writeFile(
  path.join(qmdRoot, 'private-preparation.json'),
  JSON.stringify(output, null, 2) + '\n',
  { encoding: 'utf8', flag: 'wx' },
);
