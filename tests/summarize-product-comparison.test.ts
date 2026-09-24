import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

const {
  POST_RUN_RECEIPT_NAME,
  PRODUCT_RUN_SCOPES,
  privateEvidenceSummaryFromRows,
  scoreNames,
  summarizeProductComparison,
  validatePostRunScoreReceipt,
  validatePrivateEvidenceSummary,
  validateQasperEvidenceSummary,
} = await import(
  pathToFileURL(path.resolve('evals/summarize-product-comparison.mjs')).href
);

const roots: string[] = [];
const conditions = ['echo', 'dify', 'khoj-dense', 'khoj-rerank'];
const scoreFiles = [
  'A-test.jsonl',
  'B-test.jsonl',
  'C-test.jsonl',
  'D-test.jsonl',
  'mixed-test.jsonl',
  'qasper.jsonl',
  'evidence-summary.json',
  'langchain-official-per-query.json',
  'godot-official-per-query.json',
  'du-official-per-query.json',
  'qasper-official-per-query.json',
  'official-public-summary.json',
];

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function makeIncompleteRoot(root: string): Promise<string> {
  const scopes = {
    'A-test': { questions: 50, answerable: 48, facts: 125 },
    'B-test': { questions: 35, answerable: 35, facts: 65 },
    'C-test': { questions: 25, answerable: 25, facts: 46 },
    'D-test': { questions: 30, answerable: 30, facts: 58 },
    'mixed-test': { questions: 60, answerable: 58, facts: 109 },
    qasper: { questions: 1005 },
    langchain: { questions: 203 },
    godot: { questions: 99 },
    du: { questions: 2000 },
  };
  const manifestBytes = Buffer.from(JSON.stringify({ scopes }));
  const indexBytes = Buffer.from('{}\n');
  const scoringInputPath = path.join(root, 'scoring-input.fixture.json');
  const scoringInputBytes = Buffer.from('{\"fixture\":true}\n');
  await fs.mkdir(path.join(root, 'corpus-v1'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'corpus-v1', 'manifest.json'),
    manifestBytes,
  );
  await fs.writeFile(path.join(root, 'index-freeze.json'), indexBytes);
  await fs.writeFile(scoringInputPath, scoringInputBytes);
  await fs.writeFile(
    path.join(root, 'freeze.json'),
    JSON.stringify({
      status: 'frozen',
      corpus_manifest_sha256: hash(manifestBytes),
      index_freeze: { sha256: hash(indexBytes) },
      scoring_inputs: {
        fixture: { path: scoringInputPath, sha256: hash(scoringInputBytes) },
      },
      packing: { topk: 10, source_cap: 6, max_context_chars: 20000 },
      conditions: Object.fromEntries(
        conditions.map((condition) => [condition, { fixed_return_limit: 10 }]),
      ),
    }),
  );

  for (const condition of conditions.filter((name) => name !== 'dify')) {
    const directory = path.join(root, 'scores', condition);
    await fs.mkdir(directory, { recursive: true });
    await Promise.all([
      ...scoreFiles.map((name) => fs.writeFile(path.join(directory, name), '')),
      fs.writeFile(path.join(directory, POST_RUN_RECEIPT_NAME), '{}\n'),
    ]);
  }
  return scoringInputPath;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('product comparison summary readiness', () => {
  it('stays pending and writes no report when one condition is missing', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'comparison-summary-'),
    );
    roots.push(root);
    await makeIncompleteRoot(root);

    const result = await summarizeProductComparison(root);

    expect(result).toMatchObject({
      status: 'pending',
      reasons: [
        {
          code: 'score_files_missing',
          missing_count: scoreFiles.length + 1,
        },
      ],
    });
    expect(result.reasons[0].sample).toContain('dify/A-test.jsonl');
    await expect(fs.access(path.join(root, 'analysis'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('stays pending when a pinned scoring input hash changes', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'comparison-summary-input-'),
    );
    roots.push(root);
    const input = await makeIncompleteRoot(root);
    await fs.writeFile(input, '{\"fixture\":false}\n');

    const result = await summarizeProductComparison(root);

    expect(result).toMatchObject({
      status: 'pending',
      reasons: [{ code: 'scoring_inputs_invalid:1' }],
    });
    await expect(fs.access(path.join(root, 'analysis'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects private per-query rows moved from another condition', () => {
    const makeRow = (covered: number) => ({
      no_answer: false,
      returned: 1,
      request_response_chars: 20,
      by_k: Object.fromEntries(
        [1, 3, 5, 10].map((k) => [
          k,
          {
            covered,
            expected: 1,
            complete: covered === 1,
            hit: covered === 1,
            rr: covered,
          },
        ]),
      ),
    });
    const echoRows = [makeRow(1)];
    const difyRows = [makeRow(0)];
    const echoSummary = privateEvidenceSummaryFromRows(echoRows);
    expect(Object.hasOwn(echoSummary, 'facts')).toBe(false);

    expect(() => validatePrivateEvidenceSummary(echoSummary, difyRows)).toThrow(
      'private_evidence_summary_mismatch',
    );
  });

  it('rejects a QASPER evidence summary that differs from per-query rows', () => {
    const rows = [
      {
        eligible: true,
        strict_complete: true,
        strict_coverage: 1,
        request_response_chars: 20,
      },
      {
        eligible: false,
        strict_complete: false,
        strict_coverage: null,
        request_response_chars: 40,
      },
    ];
    const summary = {
      questions: 2,
      strict_eligible: 1,
      complete: 1,
      strict_coverage: 1,
      mean_context_chars: 30,
    };

    expect(validateQasperEvidenceSummary(summary, rows)).toMatchObject({
      eligible: 1,
      complete: 1,
      coverage: 1,
      context: 30,
    });
    expect(() =>
      validateQasperEvidenceSummary(
        { ...summary, mean_context_chars: 20 },
        rows,
      ),
    ).toThrow('qasper_evidence_summary_mismatch');
  });

  it('rejects a swapped score file even when aggregate scores could match', () => {
    const scoreHashes = Object.fromEntries(
      scoreNames().map((name: string) => [name, hash(Buffer.from(name))]),
    );
    const runReceipts = Object.fromEntries(
      PRODUCT_RUN_SCOPES.map((scope: string) => [
        scope,
        {
          path: `runs/echo/${scope}-receipt.json`,
          sha256: 'c'.repeat(64),
        },
      ]),
    );
    const scoringCode = {
      'evals/score-product-evidence.mjs': 'd'.repeat(64),
      'evals/score-product-public.py': 'e'.repeat(64),
    };
    const expected = {
      condition: 'echo',
      freezeSha: 'a'.repeat(64),
      manifestSha: 'b'.repeat(64),
      scoreHashes,
      runReceipts,
      scoringCode,
      writerSha: 'f'.repeat(64),
    };
    const receipt = {
      version: 1,
      status: 'post-run-score-files-bound',
      condition: expected.condition,
      freeze_sha256: expected.freezeSha,
      manifest_sha256: expected.manifestSha,
      score_files: scoreHashes,
      run_receipts: runReceipts,
      scoring_code_sha256: scoringCode,
      writer_sha256: expected.writerSha,
      created_at: '2026-09-24T00:00:00.000Z',
    };

    expect(validatePostRunScoreReceipt(receipt, expected)).toBe(true);
    const swappedScoreHashes = {
      ...scoreHashes,
      'A-test.jsonl': hash(Buffer.from('other-condition-score-bytes')),
    };
    expect(() =>
      validatePostRunScoreReceipt(receipt, {
        ...expected,
        scoreHashes: swappedScoreHashes,
      }),
    ).toThrow('score_provenance_receipt_mismatch');
  });
});
