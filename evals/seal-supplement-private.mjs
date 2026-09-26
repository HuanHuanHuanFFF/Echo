import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.echo/supplement-2026-09-26');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = async (file) => sha(await fs.readFile(file));
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const save = async (name, value) =>
  fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
const verification = await read(path.join(root, 'verification.json'));
const summary = await read(path.join(root, 'summary.json'));
const audit = await read(path.join(root, 'audit.json'));
assert.equal(audit.status, 'independently-rescored');
assert.equal(audit.checked_questions, 600);
assert.equal(audit.checked_native_gets, 1178);
assert.equal(audit.checked_host_reads, 577);
assert.equal(audit.summary_sha256, await hash(path.join(root, 'summary.json')));
assert.equal(
  audit.verification_sha256,
  await hash(path.join(root, 'verification.json')),
);
assert.equal(
  await hash('docs/evals/2026-09-26-echo-qmd-supplement-summary.json'),
  await hash(path.join(root, 'summary.json')),
);
const freeze = {
  status: 'policy-committed-before-reads',
  policy_commit: '0b840ef',
  policy_sha256: verification.policy_sha256,
  runner_sha256: verification.script_sha256,
  first_corpus_manifest_sha256: verification.corpus_manifest_sha256,
  budget_utf16_chars: 20000,
  first_files_by_saved_rank: 3,
  backtrack_lines: 5,
  max_lines_per_read: 80,
  qmd_get_extra_safety_chars: 1024,
  retrieval_calls_added: 0,
  embedding_calls_added: 0,
  rerank_calls_added: 0,
};
await save('freeze.json', freeze);
const files = [
  'verification.json',
  'summary.json',
  'audit.json',
  'freeze.json',
  ...['echo', 'rrf', 'rerank'].flatMap((mode) =>
    ['A-test', 'B-test', 'C-test', 'D-test', 'mixed-test'].map(
      (scope) => `${mode}-${scope}.jsonl`,
    ),
  ),
];
const comparisonRoot =
  'E:/幻/Documents/八股-Echo测试/2026-09-22-product-comparison';
const qmdRoot = 'E:/幻/Documents/八股-Echo测试/2026-09-25-qmd-comparison';
const scopes = ['A-test', 'B-test', 'C-test', 'D-test', 'mixed-test'];
const originalReceipts = [
  path.join(qmdRoot, 'private-preparation.json'),
  path.join(qmdRoot, 'download-manifest.json'),
  ...scopes.map((scope) =>
    path.join(comparisonRoot, 'runs/echo', `${scope}-receipt.json`),
  ),
  ...['rrf', 'rerank'].flatMap((mode) =>
    scopes.map((scope) =>
      path.join(qmdRoot, 'runs-mcp', mode, `${scope}.receipt.json`),
    ),
  ),
];
const manifest = {
  status: 'complete',
  contains_private_raw_text: true,
  files: Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [file, await hash(path.join(root, file))]),
    ),
  ),
  input_sha256: {
    ...verification.input_sha256,
    ...Object.fromEntries(
      await Promise.all(
        originalReceipts.map(async (file) => [file, await hash(file)]),
      ),
    ),
  },
};
await save('manifest.json', manifest);
const receipt = {
  status: 'complete-and-independently-audited',
  questions_per_condition: 200,
  conditions: ['echo', 'rrf', 'rerank'],
  freeze_sha256: await hash(path.join(root, 'freeze.json')),
  manifest_sha256: await hash(path.join(root, 'manifest.json')),
  verification_sha256: await hash(path.join(root, 'verification.json')),
  summary_sha256: await hash(path.join(root, 'summary.json')),
  audit_sha256: await hash(path.join(root, 'audit.json')),
  published_aggregate_sha256: await hash(
    'docs/evals/2026-09-26-echo-qmd-supplement-summary.json',
  ),
  published_report_sha256: await hash(
    'docs/evals/2026-09-26-echo-qmd-supplement-results.md',
  ),
};
await save('receipt.json', receipt);
console.log(JSON.stringify(receipt));
