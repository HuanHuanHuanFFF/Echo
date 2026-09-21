import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] ?? ''),
  target = process.argv[3];
assert.ok(process.argv[2] && ['qasper', 'final'].includes(target));
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const artifact = (p) => {
  const fd = fs.openSync(path.join(root, p), 'r'),
    h = createHash('sha256'),
    b = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0)
      h.update(b.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return {
    file: p,
    bytes: fs.statSync(path.join(root, p)).size,
    sha256: h.digest('hex'),
  };
};
const list = (dir, filter = () => true) =>
  fs
    .readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) =>
      path
        .relative(root, path.join(e.parentPath, e.name))
        .replaceAll('\\', '/'),
    )
    .filter(filter)
    .sort();
const common = [
  'download-manifest.json',
  'conversion-manifest.json',
  'prepared/audit.json',
  'embedding-plan.json',
  ...list('reference', (p) => !p.endsWith('.pyc')),
  'runtime/package-lock.json',
  ...list('runtime/dist'),
];
const qasperFiles = [
  'data/qasper-dev.jsonl',
  'prepared/qasper-docs.jsonl',
  'prepared/qasper-queries.jsonl',
  ...list('qasper', (p) => !p.endsWith('-wal') && !p.endsWith('-shm')),
  ...list(
    'analysis',
    (p) =>
      p.includes('qasper') && (p.endsWith('.json') || p.endsWith('.jsonl')),
  ),
];
const receipt = {
  status:
    target === 'qasper' ? 'qasper_executed_reviewed' : 'all_executed_reviewed',
  created: new Date().toISOString(),
  environment: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    icu: process.versions.icu,
    v8: process.versions.v8,
  },
  external_root: root,
  conditions: {
    qasper: ['heading/RRF30', 'structure1.0.1/RRF30', 'structure1.0.1/RRF10'],
    fixed: ['RRF30', 'RRF10'],
  },
  embedding_plan_note:
    'Historical registration snapshot; config/input hashes remain binding. Usage and scheduler fields are not final. Actual scheduling is in capture-policy-history.jsonl plus final ledger/vector audit.',
  implementation: fs
    .readdirSync('evals', { recursive: true, withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        (e.name.endsWith('.mjs') || e.name.endsWith('.py')) &&
        e.name.includes('public'),
    )
    .map((e) => {
      const file = path.join(e.parentPath, e.name);
      return {
        file: file.replaceAll('\\', '/'),
        sha256: createHash('sha256')
          .update(fs.readFileSync(file))
          .digest('hex'),
      };
    }),
  historical_receipts_note:
    'Dated QASPER/fixed original receipts are preserved historical snapshots. Current adapter replay is separately bound; current implementation hashes do not claim to be the original capture driver.',
  analysis: read('analysis/qasper-analysis.json'),
  official_qasper: read('analysis/qasper-official-score.json'),
  vector_audit: read('analysis/qasper-vector-audit.json'),
  artifacts: [...new Set([...common, ...qasperFiles])].map(artifact),
};
if (target === 'final') {
  assert.ok(!fs.existsSync(path.join(root, 'capture.lock')));
  receipt.fixed = {};
  for (const scope of ['langchain', 'godot', 'du']) {
    receipt.fixed[scope] = read('analysis/' + scope + '-official-score.json');
    receipt.artifacts.push(
      ...list(
        'fixed',
        (p) =>
          p.startsWith('fixed/' + scope) &&
          !p.endsWith('-shm') &&
          !p.endsWith('-wal'),
      ).map(artifact),
    );
  }
  receipt.final_vector_audit = read('analysis/all-vector-audit.json');
  assert.equal(
    receipt.final_vector_audit.all_success_attempts_referenced,
    true,
  );
  for (const [scope, documents] of Object.entries({
    langchain: 49505,
    godot: 25477,
    du: 100001,
  })) {
    const binding = receipt.final_vector_audit.fixed_index_bindings[scope];
    assert.equal(binding.documents, documents);
    assert.equal(binding.official_text_and_cache_vector_equal, true);
  }
  receipt.attempt_bound_audit = read(
    'analysis/capture-attempt-bound-audit.json',
  );
  assert.equal(receipt.attempt_bound_audit.no_inflight, true);
  receipt.independent_reviews = read('analysis/public-final-reviews.json');
  assert.equal(receipt.independent_reviews.status, 'passed');
  assert.equal(
    new Set(receipt.independent_reviews.reviewers.map((r) => r.agent)).size,
    2,
  );
  for (const review of receipt.independent_reviews.reviewers)
    assert.equal(review.status, 'passed');
  receipt.execution_counts = {
    unique_parent_questions: 3307,
    primary_retrieval_executions: 7619,
    additional_fixed_conformance_executions: 48,
    scoring_replays_are_not_additional_questions: true,
  };
  for (const [scope, count] of Object.entries({
    langchain: 203,
    godot: 99,
    du: 2000,
  }))
    for (const condition of ['rrf30', 'rrf10'])
      assert.equal(receipt.fixed[scope].results[condition].questions, count);
  receipt.raw_api_response_binding =
    'Original gzip response files stay outside Git. Their paths are retained in the bound vectors.sqlite attempts ledger; all successful responses were re-read and bound by final_vector_audit.raw_response_chain_sha256. The chain is used instead of listing 23278 individual files here.';
  receipt.scoring_replay = read('analysis/scoring-replay/verification.json');
  receipt.artifacts.push(
    ...[
      'vectors.sqlite',
      'capture-policy-history.jsonl',
      ...list('data'),
      ...list(
        'analysis',
        (p) =>
          !p.includes('qasper') &&
          (p.endsWith('.json') || p.endsWith('.jsonl')),
      ),
      ...list('repro'),
    ].map(artifact),
  );
  assert.ok(
    !fs.existsSync(path.join(root, 'vectors.sqlite-wal')) ||
      fs.statSync(path.join(root, 'vectors.sqlite-wal')).size === 0,
    'Final vector WAL is not empty',
  );
}
const dest =
  target === 'qasper'
    ? 'docs/evals/2026-09-19-public-qasper.manifest.json'
    : 'docs/evals/2026-09-20-public-full-results.manifest.json';
fs.writeFileSync(dest, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ dest, artifacts: receipt.artifacts.length }));
