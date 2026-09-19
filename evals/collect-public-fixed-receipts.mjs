import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2]);
const read = (file) =>
  JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const hash = (file) => {
  const h = createHash('sha256'),
    fd = fs.openSync(path.join(root, file), 'r'),
    b = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0)
      h.update(b.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
};
const receipt = {
  created: new Date().toISOString(),
  status: 'partial_execution',
  results: {},
  pending: [],
  artifacts: {},
  reference: read('reference/freshstack-leaderboard-receipt.json'),
  usage_note:
    'Per-scope referenced tokens can overlap; final global attempts ledger is authoritative. Registration plan usage is historical.',
};
for (const scope of ['langchain', 'godot', 'du']) {
  const scoreFile = 'analysis/' + scope + '-official-score.json',
    pairedFile = 'analysis/' + scope + '-paired-analysis.json',
    vectorFile = 'analysis/' + scope + '-vector-audit.json',
    runFile = 'fixed/' + scope + '-run-receipt.json';
  if (
    ![scoreFile, pairedFile, vectorFile, runFile].every((p) =>
      fs.existsSync(path.join(root, p)),
    )
  ) {
    receipt.pending.push(scope);
    continue;
  }
  const score = read(scoreFile);
  for (const [file, expected] of Object.entries(score.bindings))
    assert.equal(hash(file), expected, 'Score binding mismatch: ' + file);
  assert.equal(
    score.results.rrf30.questions,
    { langchain: 203, godot: 99, du: 2000 }[scope],
  );
  assert.equal(score.results.rrf10.questions, score.results.rrf30.questions);
  receipt.results[scope] = {
    official: score,
    paired: read(pairedFile),
    vector_audit: read(vectorFile),
    run_receipt: read(runFile),
  };
  for (const file of [scoreFile, pairedFile, vectorFile, runFile])
    receipt.artifacts[file] = hash(file);
}
const probe = 'analysis/langchain-parallel-conformance.json';
if (fs.existsSync(path.join(root, probe))) {
  receipt.parallel_conformance = read(probe);
  receipt.artifacts[probe] = hash(probe);
}
if (!receipt.pending.length) receipt.status = 'all_executed_review_pending';
fs.writeFileSync(
  'docs/evals/2026-09-20-public-fixed.manifest.json',
  JSON.stringify(
    receipt,
    (k, v) => (['win_ids', 'loss_ids'].includes(k) ? undefined : v),
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    completed: Object.keys(receipt.results),
    pending: receipt.pending,
  }),
);
