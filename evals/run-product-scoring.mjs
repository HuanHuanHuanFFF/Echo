import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFinalModelProvenance } from './lib/product-model-provenance.mjs';
import { verifyProductRuns } from './lib/product-run-integrity.mjs';
import {
  CONDITIONS,
  INVOCATION_RECEIPT_NAME,
  POST_RUN_RECEIPT_NAME,
  PRODUCT_RUN_SCOPES,
  readProductRunArtifactBindings,
  resolveFrozenPublicRoot,
  scoreNames,
  validatePostRunScoreReceipt,
  validateScoringInputs,
  pinnedScoringCode,
} from './summarize-product-comparison.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const validScorerNames = [
  'evals/score-product-evidence.mjs',
  'evals/score-product-public.py',
];

function requireThat(value, message) {
  if (!value) throw new Error('product score orchestration: ' + message);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function assertEmptyScoreDirectory(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  requireThat(entries.length === 0, 'score directory is not empty');
  return true;
}

async function execute(executable, args, cwd, stage) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) =>
      resolve({ exit_code: exitCode, signal }),
    );
  });
  requireThat(
    result.exit_code === 0 && result.signal === null,
    stage +
      ' failed with exit=' +
      String(result.exit_code) +
      ' signal=' +
      String(result.signal),
  );
  return {
    executable,
    args,
    cwd,
    exit_code: result.exit_code,
    signal: result.signal,
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function digest(file) {
  return hash(await fs.readFile(file));
}

async function verifyAllScopes(root, condition) {
  const result = await verifyProductRuns({
    root,
    condition,
    scopes: PRODUCT_RUN_SCOPES,
  });
  const questionCount = result.scopes.reduce(
    (sum, scope) => sum + scope.questions,
    0,
  );
  requireThat(
    result.scopes.length === PRODUCT_RUN_SCOPES.length &&
      questionCount === 3507,
    'run verification must cover all nine scopes and 3507 questions',
  );
  return result;
}

function sameRunArtifacts(left, right) {
  return PRODUCT_RUN_SCOPES.every((scope) => {
    const a = left[scope];
    const b = right[scope];
    return (
      a?.receipt_path === b?.receipt_path &&
      a?.receipt_sha256 === b?.receipt_sha256 &&
      a?.result_path === b?.result_path &&
      a?.result_sha256 === b?.result_sha256
    );
  });
}

async function requireExactFiles(directory, expectedNames) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();
  const expected = [...expectedNames].sort();
  requireThat(
    JSON.stringify(actualNames) === JSON.stringify(expected) &&
      entries.every((entry) => entry.isFile()),
    'score output file set differs from expected',
  );
}

async function runProductScoring(
  rootArgument,
  condition,
  publicRootArgument,
  pythonArgument,
) {
  requireThat(
    CONDITIONS.includes(condition),
    'this release scores only echo and dify',
  );
  requireThat(
    rootArgument && publicRootArgument && pythonArgument,
    'expected ROOT CONDITION PUBLIC_ROOT PYTHON_EXECUTABLE',
  );

  const root = path.resolve(rootArgument);
  const publicRoot = path.resolve(publicRootArgument);
  const pythonExecutable = path.resolve(pythonArgument);
  const scoreDirectory = path.join(root, 'scores', condition);

  await assertEmptyScoreDirectory(scoreDirectory);
  const publicStat = await fs.stat(publicRoot);
  const pythonStat = await fs.stat(pythonExecutable);
  requireThat(publicStat.isDirectory(), 'public root is not a directory');
  requireThat(pythonStat.isFile(), 'Python executable path is not a file');

  const freezeBytes = await fs.readFile(path.join(root, 'freeze.json'));
  const manifestBytes = await fs.readFile(
    path.join(root, 'corpus-v1', 'manifest.json'),
  );
  const freeze = JSON.parse(freezeBytes.toString('utf8'));
  requireThat(freeze.status === 'frozen', 'global freeze is not frozen');
  requireThat(
    hash(manifestBytes) === freeze.corpus_manifest_sha256,
    'corpus manifest differs from freeze',
  );
  requireThat(
    Object.hasOwn(freeze.conditions ?? {}, condition),
    'selected condition is absent from the frozen plan',
  );
  requireThat(
    pathKey(resolveFrozenPublicRoot(freeze.scoring_inputs)) ===
      pathKey(publicRoot),
    'public root does not match frozen scoring input paths',
  );
  await validateScoringInputs(freeze.scoring_inputs);
  const scoringCode = await pinnedScoringCode(freeze);
  const scorerHashes = Object.fromEntries(
    validScorerNames.map((name) => [name, scoringCode[name]]),
  );
  const freezeSha = hash(freezeBytes);
  const manifestSha = hash(manifestBytes);
  const executorSha = hash(await fs.readFile(fileURLToPath(import.meta.url)));
  const receiptWriterPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'receipt-product-comparison-scores.mjs',
  );
  const receiptWriterSha = hash(await fs.readFile(receiptWriterPath));

  const preRun = await verifyAllScopes(root, condition);
  const beforeArtifacts = await readProductRunArtifactBindings(root, condition);
  await verifyFinalModelProvenance(root);

  await fs.mkdir(scoreDirectory, { recursive: true });
  await assertEmptyScoreDirectory(scoreDirectory);

  const nodeExecutable = process.execPath;
  const commands = {};
  commands.evidence = await execute(
    nodeExecutable,
    ['evals/score-product-evidence.mjs', root, condition, publicRoot],
    repositoryRoot,
    'evidence scorer',
  );
  commands.official_public = await execute(
    pythonExecutable,
    ['evals/score-product-public.py', root, publicRoot, condition],
    repositoryRoot,
    'official public scorer',
  );

  const postRun = await verifyAllScopes(root, condition);
  const afterArtifacts = await readProductRunArtifactBindings(root, condition);
  requireThat(
    postRun.freeze_sha256 === preRun.freeze_sha256 &&
      sameRunArtifacts(beforeArtifacts, afterArtifacts),
    'run receipts or raw results changed during scoring',
  );
  await requireExactFiles(scoreDirectory, scoreNames());

  commands.post_run_receipt = await execute(
    nodeExecutable,
    ['evals/receipt-product-comparison-scores.mjs', root, condition],
    repositoryRoot,
    'post-run receipt writer',
  );

  const scoreHashes = {};
  for (const name of scoreNames())
    scoreHashes[name] = await digest(path.join(scoreDirectory, name));
  const postRunReceiptPath = path.join(scoreDirectory, POST_RUN_RECEIPT_NAME);
  const postRunReceiptBytes = await fs.readFile(postRunReceiptPath);
  const postRunReceiptSha = hash(postRunReceiptBytes);
  const postRunReceipt = JSON.parse(postRunReceiptBytes.toString('utf8'));
  validatePostRunScoreReceipt(postRunReceipt, {
    condition,
    freezeSha,
    manifestSha,
    scoreHashes,
    runReceipts: Object.fromEntries(
      PRODUCT_RUN_SCOPES.map((scope) => {
        const item = afterArtifacts[scope];
        return [
          scope,
          { path: item.receipt_path, sha256: item.receipt_sha256 },
        ];
      }),
    ),
    scoringCode,
    writerSha: receiptWriterSha,
  });
  await requireExactFiles(scoreDirectory, [
    ...scoreNames(),
    POST_RUN_RECEIPT_NAME,
  ]);

  const invocationReceipt = {
    version: 1,
    status: 'scoring-invocation-complete',
    condition,
    freeze_sha256: freezeSha,
    manifest_sha256: manifestSha,
    executor_sha256: executorSha,
    receipt_writer_sha256: receiptWriterSha,
    node_executable: nodeExecutable,
    python_executable: pythonExecutable,
    public_root: publicRoot,
    commands,
    scoring_code_sha256: scorerHashes,
    run_artifacts: afterArtifacts,
    score_files_sha256: scoreHashes,
    post_run_receipt_sha256: postRunReceiptSha,
    created_at: new Date().toISOString(),
  };
  const invocationPath = path.join(scoreDirectory, INVOCATION_RECEIPT_NAME);
  await fs.writeFile(
    invocationPath,
    JSON.stringify(invocationReceipt, null, 2) + '\n',
    { flag: 'wx' },
  );
  await requireExactFiles(scoreDirectory, [
    ...scoreNames(),
    POST_RUN_RECEIPT_NAME,
    INVOCATION_RECEIPT_NAME,
  ]);
  return {
    status: invocationReceipt.status,
    condition,
    scopes: PRODUCT_RUN_SCOPES.length,
    questions: 3507,
    score_files: scoreNames().length,
    receipt_sha256: hash(
      Buffer.from(JSON.stringify(invocationReceipt, null, 2) + '\n'),
    ),
  };
}

const [rootArgument, condition, publicRootArgument, pythonArgument] =
  process.argv.slice(2);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) {
  if (!rootArgument || !condition || !publicRootArgument || !pythonArgument) {
    process.stderr.write(
      'Usage: node evals/run-product-scoring.mjs ROOT echo|dify PUBLIC_ROOT PYTHON_EXECUTABLE\n',
    );
    process.exitCode = 2;
  } else {
    try {
      const result = await runProductScoring(
        rootArgument,
        condition,
        publicRootArgument,
        pythonArgument,
      );
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (error) {
      process.stderr.write(
        (error instanceof Error ? error.message : 'product score failed') +
          '\n',
      );
      process.exitCode = 1;
    }
  }
}

export { runProductScoring };
