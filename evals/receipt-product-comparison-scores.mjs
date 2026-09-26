import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProductRuns } from './lib/product-run-integrity.mjs';
import {
  FROZEN_CONDITIONS,
  POST_RUN_RECEIPT_NAME,
  PRODUCT_RUN_SCOPES,
  pinnedScoringCode,
  productRunReceiptPath,
  scoreNames,
} from './summarize-product-comparison.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

function requireThat(value, message) {
  if (!value) throw new Error('score receipt: ' + message);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeReceipt(root, condition) {
  requireThat(FROZEN_CONDITIONS.includes(condition), 'unsupported condition');
  const freezeFile = path.join(root, 'freeze.json');
  const manifestFile = path.join(root, 'corpus-v1', 'manifest.json');
  const freezeBytes = await fs.readFile(freezeFile);
  const manifestBytes = await fs.readFile(manifestFile);
  const freeze = JSON.parse(freezeBytes.toString('utf8'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const freezeSha = hash(freezeBytes);
  const manifestSha = hash(manifestBytes);
  requireThat(freeze.status === 'frozen', 'global freeze is not frozen');
  requireThat(
    freeze.corpus_manifest_sha256 === manifestSha,
    'manifest does not match global freeze',
  );
  const verification = await verifyProductRuns({
    root,
    condition,
    scopes: PRODUCT_RUN_SCOPES,
  });
  requireThat(
    verification.scopes.reduce((sum, item) => sum + item.questions, 0) === 3507,
    'run verification does not cover 3507 questions',
  );

  const scoreDirectory = path.join(root, 'scores', condition);
  const evidenceSummary = await readJson(
    path.join(scoreDirectory, 'evidence-summary.json'),
  );
  const publicSummary = await readJson(
    path.join(scoreDirectory, 'official-public-summary.json'),
  );
  requireThat(
    evidenceSummary.condition === condition &&
      evidenceSummary.status ===
        'strict-evidence-scored-awaiting-official-public-score',
    'evidence summary condition/status mismatch',
  );
  requireThat(
    publicSummary.condition === condition &&
      publicSummary.status === 'official-public-scored',
    'official public summary condition/status mismatch',
  );

  const scoreFiles = {};
  for (const name of scoreNames())
    scoreFiles[name] = hash(await fs.readFile(path.join(scoreDirectory, name)));

  const runReceipts = {};
  for (const scope of PRODUCT_RUN_SCOPES) {
    const file = productRunReceiptPath(root, condition, scope);
    runReceipts[scope] = {
      path: path.relative(root, file).replaceAll('\\', '/'),
      sha256: hash(await fs.readFile(file)),
    };
  }

  const scoringCode = await pinnedScoringCode(freeze);
  const receipt = {
    version: 1,
    status: 'post-run-score-files-bound',
    condition,
    freeze_sha256: freezeSha,
    manifest_sha256: manifestSha,
    run_receipts: runReceipts,
    score_files: scoreFiles,
    scoring_code_sha256: {
      'evals/score-product-evidence.mjs':
        scoringCode['evals/score-product-evidence.mjs'],
      'evals/score-product-public.py':
        scoringCode['evals/score-product-public.py'],
    },
    writer_sha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
    created_at: new Date().toISOString(),
  };
  const target = path.join(scoreDirectory, POST_RUN_RECEIPT_NAME);
  await fs.writeFile(target, JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  });
  return {
    status: receipt.status,
    condition,
    run_receipts: Object.keys(runReceipts).length,
    score_files: Object.keys(scoreFiles).length,
    receipt_sha256: hash(Buffer.from(JSON.stringify(receipt, null, 2) + '\n')),
  };
}

const [rootArgument, condition] = process.argv.slice(2);
if (!rootArgument || !condition) {
  process.stderr.write(
    'Usage: node evals/receipt-product-comparison-scores.mjs ROOT CONDITION\n',
  );
  process.exitCode = 2;
} else {
  try {
    const root = path.resolve(rootArgument);
    const result = await writeReceipt(root, condition);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : 'score receipt failed') + '\n',
    );
    process.exitCode = 1;
  }
}
