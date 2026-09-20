import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2]);
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const hash = (p) =>
  createHash('sha256')
    .update(fs.readFileSync(path.join(root, p)))
    .digest('hex');
const result = {
  created: new Date().toISOString(),
  status: 'replay_equal_to_preserved_original_scores',
  scopes: {},
  bindings: {},
};
for (const scope of ['qasper', 'langchain', 'godot']) {
  const oldFile = 'analysis/' + scope + '-official-score.json',
    newFile = 'analysis/scoring-replay/' + scope + '-official-score.json',
    old = read(oldFile),
    fresh = read(newFile);
  assert.deepEqual(
    fresh[scope === 'qasper' ? 'summary' : 'results'],
    old[scope === 'qasper' ? 'summary' : 'results'],
  );
  const files = [oldFile, newFile];
  let count = 0;
  if (scope === 'qasper') {
    const a = 'analysis/qasper-official-per-question.jsonl',
      b = 'analysis/scoring-replay/qasper-official-per-question.jsonl';
    assert.equal(
      fs.readFileSync(path.join(root, a), 'utf8'),
      fs.readFileSync(path.join(root, b), 'utf8'),
    );
    files.push(a, b);
    count = 3015;
  } else {
    for (const k of [30, 10]) {
      const a = 'analysis/' + scope + '-rrf' + k + '-per-question.json',
        b =
          'analysis/scoring-replay/' +
          scope +
          '-rrf' +
          k +
          '-per-question.json';
      assert.deepEqual(read(a), read(b));
      files.push(a, b);
      count += Object.keys(read(a)).length;
    }
    const a = 'analysis/' + scope + '-paired-analysis.json',
      b = 'analysis/scoring-replay/' + scope + '-paired-analysis.json';
    const {
      bindings: _bindings,
      implementation: _implementation,
      ...paired
    } = read(b);
    assert.deepEqual(paired, read(a));
    files.push(a, b);
  }
  for (const file of files) result.bindings[file] = hash(file);
  result.scopes[scope] = {
    per_question_rows: count,
    all_scores_equal: true,
    paired_equal: scope === 'qasper' ? null : true,
    current_implementation: fresh.implementation,
  };
}
const dest = path.join(root, 'analysis/scoring-replay/verification.json');
fs.writeFileSync(dest, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, scopes: result.scopes }));
