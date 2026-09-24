import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONDITIONS = ['echo', 'dify'];
export const FROZEN_CONDITIONS = ['echo', 'dify', 'khoj-dense', 'khoj-rerank'];
const PRIVATE_LAYOUT = [
  { scope: 'A-test', questions: 50, answerable: 48, facts: 125 },
  { scope: 'B-test', questions: 35, answerable: 35, facts: 65 },
  { scope: 'C-test', questions: 25, answerable: 25, facts: 46 },
  { scope: 'D-test', questions: 30, answerable: 30, facts: 58 },
  { scope: 'mixed-test', questions: 60, answerable: 58, facts: 109 },
];
const FIXED_LAYOUT = [
  { scope: 'langchain', questions: 203 },
  { scope: 'godot', questions: 99 },
  { scope: 'du', questions: 2000 },
];
export const EVIDENCE_SCOPES = [
  ...PRIVATE_LAYOUT.map((item) => item.scope),
  'qasper',
];
export const PUBLIC_SCOPES = ['langchain', 'godot', 'du', 'qasper'];
export const PRODUCT_RUN_SCOPES = [
  ...EVIDENCE_SCOPES,
  ...FIXED_LAYOUT.map((item) => item.scope),
];
export const POST_RUN_RECEIPT_NAME = 'post-run-receipt.json';
export const INVOCATION_RECEIPT_NAME = 'invocation-receipt.json';
const KS = [1, 3, 5, 10];
const FIXED_METRICS = ['nDCG@10', 'Recall@10', 'MRR@10', 'Hit@10'];
const TOTAL_QUESTIONS = 3507;
const QASPER_QUESTIONS = 1005;
const QASPER_ELIGIBLE = 800;
const EVIDENCE_STATUS = 'strict-evidence-scored-awaiting-official-public-score';
const SCORING_EXECUTION_FILES = [
  'evals/score-product-evidence.mjs',
  'evals/score-product-public.py',
  'evals/verify-product-run.mjs',
  'evals/prepare-product-comparison.mjs',
  'evals/lib/product-evidence.mjs',
  'evals/lib/dify-evidence.mjs',
  'evals/lib/khoj-evidence.mjs',
  'evals/lib/product-run-integrity.mjs',
  'evals/lib/product-freeze.mjs',
  'evals/lib/product-index-receipt.mjs',
];

const hash = (value) => createHash('sha256').update(value).digest('hex');
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const close = (a, b, epsilon = 1e-8) =>
  typeof a === 'number' &&
  Number.isFinite(a) &&
  typeof b === 'number' &&
  Number.isFinite(b) &&
  Math.abs(a - b) <= epsilon;
const mean = (values) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
const round = (value) =>
  value === null || value === undefined
    ? null
    : Math.round(value * 1_000_000) / 1_000_000;
const within01 = (value) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
const pending = (reasons) => ({ status: 'pending', reasons });

async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

export async function validateScoringInputs(scoringInputs) {
  if (!isRecord(scoringInputs) || Object.keys(scoringInputs).length === 0)
    throw new Error('scoring_inputs_missing');
  const entries = Object.entries(scoringInputs);
  let next = 0;
  let invalid = 0;
  const worker = async () => {
    while (next < entries.length) {
      const [, binding] = entries[next++];
      if (
        !isRecord(binding) ||
        typeof binding.path !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(String(binding.sha256 ?? ''))
      ) {
        invalid++;
        continue;
      }
      try {
        if (
          (await fileHash(path.resolve(binding.path))).toLowerCase() !==
          binding.sha256.toLowerCase()
        )
          invalid++;
      } catch {
        invalid++;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(8, entries.length) }, () => worker()),
  );
  if (invalid) throw new Error('scoring_inputs_invalid:' + invalid);
  return entries.length;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function json(bytes, name) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('invalid_json:' + name);
  }
}

function jsonl(bytes, name) {
  const lines = bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
  try {
    return lines.map((line) => JSON.parse(line));
  } catch {
    throw new Error('invalid_jsonl:' + name);
  }
}

export function scoreNames() {
  return [
    ...EVIDENCE_SCOPES.map((scope) => scope + '.jsonl'),
    'evidence-summary.json',
    ...PUBLIC_SCOPES.map((scope) => scope + '-official-per-query.json'),
    'official-public-summary.json',
  ];
}

export function productRunReceiptPath(root, condition, scope) {
  return condition === 'dify'
    ? path.join(root, 'runs', 'dify', scope + '.receipt.json')
    : path.join(root, 'runs', condition, scope + '-receipt.json');
}

export async function readProductRunReceiptBindings(root, condition) {
  const bindings = {};
  for (const scope of PRODUCT_RUN_SCOPES) {
    const file = productRunReceiptPath(root, condition, scope);
    const bytes = await fs.readFile(file);
    bindings[scope] = {
      path: path.relative(root, file).replaceAll('\\', '/'),
      sha256: hash(bytes),
    };
  }
  return bindings;
}

export async function readProductRunArtifactBindings(root, condition) {
  const bindings = {};
  for (const scope of PRODUCT_RUN_SCOPES) {
    const receiptFile = productRunReceiptPath(root, condition, scope);
    const receiptBytes = await fs.readFile(receiptFile);
    const receipt = json(receiptBytes, scope + '-run-receipt');
    const resultValue =
      condition === 'dify' ? receipt.output_file : receipt.result?.path;
    const recordedSha =
      condition === 'dify' ? receipt.output_sha256 : receipt.result?.sha256;
    if (typeof resultValue !== 'string' || typeof recordedSha !== 'string')
      throw new Error('product_run_result_binding_missing:' + scope);
    const resultFile = path.isAbsolute(resultValue)
      ? path.resolve(resultValue)
      : path.resolve(root, resultValue);
    const expectedResult = path.resolve(
      root,
      'runs',
      condition,
      scope + '.jsonl',
    );
    const comparable = (value) =>
      process.platform === 'win32' ? value.toLowerCase() : value;
    if (comparable(resultFile) !== comparable(expectedResult))
      throw new Error('product_run_result_path_mismatch:' + scope);
    const resultSha = await fileHash(resultFile);
    if (resultSha.toLowerCase() !== recordedSha.toLowerCase())
      throw new Error('product_run_result_sha_mismatch:' + scope);
    bindings[scope] = {
      receipt_path: path.relative(root, receiptFile).replaceAll('\\', '/'),
      receipt_sha256: hash(receiptBytes),
      result_path: path.relative(root, resultFile).replaceAll('\\', '/'),
      result_sha256: resultSha,
    };
  }
  return bindings;
}

export function resolveFrozenPublicRoot(scoringInputs) {
  if (!isRecord(scoringInputs) || Object.keys(scoringInputs).length === 0)
    throw new Error('scoring_inputs_missing');
  const candidates = [];
  for (const [name, binding] of Object.entries(scoringInputs)) {
    const segments = name.split(/[\\/]/).filter(Boolean);
    if (
      !segments.length ||
      !isRecord(binding) ||
      typeof binding.path !== 'string' ||
      !path.isAbsolute(binding.path)
    )
      throw new Error('scoring_input_public_root_invalid');
    const inputPath = path.resolve(binding.path);
    const candidate = path.resolve(inputPath, ...segments.map(() => '..'));
    const derivedInput = path.resolve(candidate, ...segments);
    const comparable = (value) =>
      process.platform === 'win32' ? value.toLowerCase() : value;
    if (comparable(derivedInput) !== comparable(inputPath))
      throw new Error('scoring_input_public_root_invalid');
    candidates.push(candidate);
  }
  const first = candidates[0];
  const comparable = (value) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  if (
    candidates.some((candidate) => comparable(candidate) !== comparable(first))
  )
    throw new Error('scoring_input_public_root_mismatch');
  return first;
}

export function validateProductScoringInvocationReceipt(receipt, expected) {
  const sameKeys = (record, keys) =>
    isRecord(record) &&
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key));
  const validSha = (value) =>
    typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  const scorerNames = [
    'evals/score-product-evidence.mjs',
    'evals/score-product-public.py',
  ];
  const commandNames = ['evidence', 'official_public', 'post_run_receipt'];
  const commands = receipt?.commands;
  const nodeExecutable = receipt?.node_executable;
  const pythonExecutable = receipt?.python_executable;
  const validCommand = (command, executable, args) =>
    isRecord(command) &&
    command.executable === executable &&
    JSON.stringify(command.args) === JSON.stringify(args) &&
    command.cwd === expected.repoRoot &&
    command.exit_code === 0 &&
    command.signal === null;
  if (
    !isRecord(receipt) ||
    receipt.version !== 1 ||
    receipt.status !== 'scoring-invocation-complete' ||
    receipt.condition !== expected.condition ||
    receipt.freeze_sha256 !== expected.freezeSha ||
    receipt.manifest_sha256 !== expected.manifestSha ||
    !validSha(receipt.executor_sha256) ||
    receipt.executor_sha256 !== expected.executorSha ||
    !validSha(receipt.receipt_writer_sha256) ||
    receipt.receipt_writer_sha256 !== expected.receiptWriterSha ||
    !validSha(receipt.post_run_receipt_sha256) ||
    receipt.post_run_receipt_sha256 !== expected.postRunReceiptSha ||
    receipt.public_root !== expected.publicRoot ||
    !path.isAbsolute(nodeExecutable ?? '') ||
    !path.isAbsolute(pythonExecutable ?? '') ||
    !sameKeys(receipt.score_files_sha256, scoreNames()) ||
    !sameKeys(receipt.run_artifacts, PRODUCT_RUN_SCOPES) ||
    !sameKeys(receipt.scoring_code_sha256, scorerNames) ||
    !sameKeys(commands, commandNames)
  )
    throw new Error('scoring_invocation_receipt_mismatch');

  for (const name of scoreNames()) {
    if (
      !validSha(receipt.score_files_sha256[name]) ||
      receipt.score_files_sha256[name] !== expected.scoreHashes[name]
    )
      throw new Error('scoring_invocation_receipt_mismatch');
  }
  for (const scope of PRODUCT_RUN_SCOPES) {
    const actual = receipt.run_artifacts[scope];
    const frozen = expected.runArtifacts[scope];
    if (
      !isRecord(actual) ||
      actual.receipt_path !== frozen?.receipt_path ||
      actual.receipt_sha256 !== frozen?.receipt_sha256 ||
      actual.result_path !== frozen?.result_path ||
      actual.result_sha256 !== frozen?.result_sha256 ||
      !validSha(actual.receipt_sha256) ||
      !validSha(actual.result_sha256)
    )
      throw new Error('scoring_invocation_receipt_mismatch');
  }
  for (const name of scorerNames) {
    if (
      !validSha(receipt.scoring_code_sha256[name]) ||
      receipt.scoring_code_sha256[name] !== expected.scoringCode[name]
    )
      throw new Error('scoring_invocation_receipt_mismatch');
  }
  const root = expected.root;
  const publicRoot = expected.publicRoot;
  const expectedCommands = {
    evidence: [
      nodeExecutable,
      [
        'evals/score-product-evidence.mjs',
        root,
        expected.condition,
        publicRoot,
      ],
    ],
    official_public: [
      pythonExecutable,
      ['evals/score-product-public.py', root, publicRoot, expected.condition],
    ],
    post_run_receipt: [
      nodeExecutable,
      ['evals/receipt-product-comparison-scores.mjs', root, expected.condition],
    ],
  };
  if (
    Object.entries(expectedCommands).some(
      ([name, [executable, args]]) =>
        !validCommand(commands[name], executable, args),
    )
  )
    throw new Error('scoring_invocation_receipt_mismatch');
  if (!receipt.created_at || !Number.isFinite(Date.parse(receipt.created_at)))
    throw new Error('scoring_invocation_receipt_mismatch');
  return true;
}

export function validatePostRunScoreReceipt(receipt, expected) {
  const sameKeys = (record, keys) =>
    isRecord(record) &&
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key));
  const validSha = (value) =>
    typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  const scorerNames = [
    'evals/score-product-evidence.mjs',
    'evals/score-product-public.py',
  ];
  if (
    !isRecord(receipt) ||
    receipt.version !== 1 ||
    receipt.status !== 'post-run-score-files-bound' ||
    receipt.condition !== expected.condition ||
    receipt.freeze_sha256 !== expected.freezeSha ||
    receipt.manifest_sha256 !== expected.manifestSha ||
    !validSha(receipt.writer_sha256) ||
    receipt.writer_sha256 !== expected.writerSha ||
    !sameKeys(receipt.score_files, scoreNames()) ||
    !sameKeys(receipt.run_receipts, PRODUCT_RUN_SCOPES) ||
    !sameKeys(receipt.scoring_code_sha256, scorerNames)
  )
    throw new Error('score_provenance_receipt_mismatch');
  for (const name of scoreNames()) {
    if (
      !validSha(receipt.score_files[name]) ||
      receipt.score_files[name] !== expected.scoreHashes[name]
    )
      throw new Error('score_provenance_receipt_mismatch');
  }
  for (const scope of PRODUCT_RUN_SCOPES) {
    const actual = receipt.run_receipts[scope];
    const frozen = expected.runReceipts[scope];
    if (
      !isRecord(actual) ||
      actual.path !== frozen?.path ||
      !validSha(actual.sha256) ||
      actual.sha256 !== frozen.sha256
    )
      throw new Error('score_provenance_receipt_mismatch');
  }
  for (const name of scorerNames) {
    if (
      !validSha(receipt.scoring_code_sha256[name]) ||
      receipt.scoring_code_sha256[name] !== expected.scoringCode[name]
    )
      throw new Error('score_provenance_receipt_mismatch');
  }
  if (!receipt.created_at || !Number.isFinite(Date.parse(receipt.created_at)))
    throw new Error('score_provenance_receipt_mismatch');
  return true;
}

function validateManifest(manifest) {
  if (!isRecord(manifest?.scopes)) throw new Error('manifest_scope_shape');
  const required = [
    ...PRIVATE_LAYOUT.map((item) => item.scope),
    'qasper',
    ...FIXED_LAYOUT.map((item) => item.scope),
  ];
  const actual = Object.keys(manifest.scopes);
  if (
    actual.length !== required.length ||
    required.some((scope) => !Object.hasOwn(manifest.scopes, scope))
  )
    throw new Error('manifest_scope_set');
  for (const item of PRIVATE_LAYOUT) {
    const scope = manifest.scopes[item.scope];
    if (
      scope.questions !== item.questions ||
      scope.answerable !== item.answerable ||
      scope.facts !== item.facts
    )
      throw new Error('private_denominator:' + item.scope);
  }
  if (manifest.scopes.qasper.questions !== QASPER_QUESTIONS)
    throw new Error('qasper_denominator');
  for (const item of FIXED_LAYOUT) {
    if (manifest.scopes[item.scope].questions !== item.questions)
      throw new Error('fixed_denominator:' + item.scope);
  }
  const total = required.reduce(
    (sum, scope) => sum + manifest.scopes[scope].questions,
    0,
  );
  if (total !== TOTAL_QUESTIONS) throw new Error('total_question_denominator');
}

function idMap(rows, artifact) {
  const result = new Map();
  for (const row of rows) {
    if (!isRecord(row) || row.id === undefined || row.id === null)
      throw new Error('missing_row_id:' + artifact);
    const id = String(row.id);
    if (result.has(id)) throw new Error('duplicate_row_id:' + artifact);
    result.set(id, row);
  }
  return result;
}

function validateIds(expected, actual, artifact) {
  if (expected.length !== actual.size || expected.some((id) => !actual.has(id)))
    throw new Error('query_id_set_mismatch:' + artifact);
}

function compare(left, right) {
  if (typeof left === 'boolean' && typeof right === 'boolean')
    return left === right ? 0 : left ? 1 : -1;
  const delta = left - right;
  if (Math.abs(delta) <= 1e-12) return 0;
  return delta > 0 ? 1 : -1;
}

function paired(leftRows, rightRows, metric, options = {}) {
  const left = idMap(leftRows, 'pair-left');
  const right = idMap(rightRows, 'pair-right');
  if (left.size !== right.size || [...left.keys()].some((id) => !right.has(id)))
    throw new Error('paired_question_set_mismatch');
  let wins = 0;
  let losses = 0;
  let ties = 0;
  const deltas = [];
  const matrix = [
    [0, 0],
    [0, 0],
  ];
  for (const [id, leftRow] of left) {
    const rightRow = right.get(id);
    if (options.filter && !options.filter(leftRow, rightRow)) continue;
    const a = metric(leftRow);
    const b = metric(rightRow);
    const result = compare(a, b);
    if (result > 0) wins++;
    else if (result < 0) losses++;
    else ties++;
    if (typeof a === 'boolean' && typeof b === 'boolean') {
      matrix[a ? 0 : 1][b ? 0 : 1]++;
    } else {
      deltas.push(a - b);
    }
  }
  const output = { questions: wins + losses + ties, wins, losses, ties };
  if (deltas.length) output.mean_delta = round(mean(deltas));
  if (options.completeTable)
    output.complete_2x2 = {
      rows: ['echo_complete', 'echo_incomplete'],
      columns: ['opponent_complete', 'opponent_incomplete'],
      cells: matrix,
    };
  return output;
}

function pairedDifference(leftRows, rightRows, metric, options = {}) {
  const left = idMap(leftRows, 'pair-left');
  const right = idMap(rightRows, 'pair-right');
  if (left.size !== right.size || [...left.keys()].some((id) => !right.has(id)))
    throw new Error('paired_question_set_mismatch');
  const deltas = [];
  for (const [id, leftRow] of left) {
    const rightRow = right.get(id);
    if (options.filter && !options.filter(leftRow, rightRow)) continue;
    deltas.push(metric(leftRow) - metric(rightRow));
  }
  return { questions: deltas.length, mean_delta: round(mean(deltas)) };
}

function privateMetric(row, key, k) {
  const value = row.by_k[k];
  if (key === 'complete') return value.complete;
  if (key === 'hit') return value.hit;
  if (key === 'fact_coverage') return value.covered / value.expected;
  if (key === 'mrr') return value.rr;
  throw new Error('unknown_private_metric');
}

function privateReport(scope, rows, budgetMax) {
  const answerable = rows.filter((row) => !row.no_answer);
  const expected = PRIVATE_LAYOUT.find((item) => item.scope === scope);
  const expectedFacts =
    expected?.facts ??
    PRIVATE_LAYOUT.reduce((sum, item) => sum + item.facts, 0);
  const byK = {};
  for (const k of KS) {
    const covered = answerable.reduce(
      (sum, row) => sum + row.by_k[k].covered,
      0,
    );
    const facts = answerable.reduce(
      (sum, row) => sum + row.by_k[k].expected,
      0,
    );
    const complete = answerable.filter((row) => row.by_k[k].complete).length;
    const hit = answerable.filter((row) => row.by_k[k].hit).length;
    byK[k] = {
      complete: {
        count: complete,
        denominator: answerable.length,
        rate: round(complete / answerable.length),
      },
      facts: { covered, denominator: facts, rate: round(covered / facts) },
      hit: {
        count: hit,
        denominator: answerable.length,
        rate: round(hit / answerable.length),
      },
      mrr: round(mean(answerable.map((row) => row.by_k[k].rr))),
    };
  }
  const noAnswer = rows.filter((row) => row.no_answer);
  return {
    questions: rows.length,
    answerable: answerable.length,
    facts: expectedFacts,
    by_k: byK,
    no_answer: {
      count: noAnswer.length,
      nonempty: noAnswer.filter((row) => row.returned > 0).length,
    },
    mean_context_chars: round(
      mean(rows.map((row) => row.request_response_chars)),
    ),
    context_budget_max_chars: budgetMax,
  };
}

function qasperReport(evidenceRows, officialMap, budgetMax) {
  const eligible = evidenceRows.filter((row) => row.eligible);
  const officialRows = [...officialMap.values()];
  return {
    questions: evidenceRows.length,
    strict: {
      complete: eligible.filter((row) => row.strict_complete).length,
      denominator: eligible.length,
      coverage_mean: round(mean(eligible.map((row) => row.strict_coverage))),
      context_mean_chars: round(
        mean(evidenceRows.map((row) => row.request_response_chars)),
      ),
      context_budget_max_chars: budgetMax,
    },
    official_evidence_f1: {
      mean: round(mean(officialRows.map((row) => row['Evidence F1']))),
      denominator: officialRows.length,
    },
  };
}

export function privateEvidenceSummaryFromRows(rows) {
  const answerable = rows.filter((row) => !row.no_answer);
  const byK = Object.fromEntries(
    KS.map((k) => {
      const covered = answerable.reduce(
        (sum, row) => sum + row.by_k[k].covered,
        0,
      );
      const expectedFacts = answerable.reduce(
        (sum, row) => sum + row.by_k[k].expected,
        0,
      );
      return [
        k,
        {
          complete: answerable.filter((row) => row.by_k[k].complete).length,
          facts: covered,
          expected_facts: expectedFacts,
          hit: answerable.filter((row) => row.by_k[k].hit).length,
          mrr: mean(answerable.map((row) => row.by_k[k].rr)),
        },
      ];
    }),
  );
  return {
    questions: rows.length,
    answerable: answerable.length,
    by_k: byK,
    no_answer_nonempty: rows.filter((row) => row.no_answer && row.returned > 0)
      .length,
    mean_context_chars: mean(rows.map((row) => row.request_response_chars)),
  };
}

export function validatePrivateEvidenceSummary(summary, rows) {
  const actual = privateEvidenceSummaryFromRows(rows);
  if (
    !isRecord(summary) ||
    summary.questions !== actual.questions ||
    summary.answerable !== actual.answerable ||
    summary.no_answer_nonempty !== actual.no_answer_nonempty ||
    !close(summary.mean_context_chars, actual.mean_context_chars)
  )
    throw new Error('private_evidence_summary_mismatch');
  for (const k of KS) {
    const recorded = summary.by_k?.[k];
    const recomputed = actual.by_k[k];
    if (
      !isRecord(recorded) ||
      recorded.complete !== recomputed.complete ||
      recorded.facts !== recomputed.facts ||
      recorded.expected_facts !== recomputed.expected_facts ||
      recorded.hit !== recomputed.hit ||
      !close(recorded.mrr, recomputed.mrr)
    )
      throw new Error('private_evidence_summary_mismatch');
  }
  return actual;
}

export function validateQasperEvidenceSummary(summary, rows) {
  const eligible = rows.filter((row) => row.eligible);
  const complete = eligible.filter((row) => row.strict_complete).length;
  const coverage = mean(eligible.map((row) => row.strict_coverage));
  const context = mean(rows.map((row) => row.request_response_chars));
  if (
    !isRecord(summary) ||
    summary.questions !== rows.length ||
    summary.strict_eligible !== eligible.length ||
    summary.complete !== complete ||
    !close(summary.strict_coverage, coverage) ||
    !close(summary.mean_context_chars, context)
  )
    throw new Error('qasper_evidence_summary_mismatch');
  return { eligible: eligible.length, complete, coverage, context };
}

function fixedReport(scope, publicSummary, perQuery, limit) {
  const dataset = publicSummary.datasets[scope];
  const metrics = {};
  for (const name of Object.keys(dataset.metrics)) {
    metrics[name] = round(mean([...perQuery.values()].map((row) => row[name])));
  }
  return {
    questions: dataset.questions,
    candidate_limit: limit,
    observed_return_count: {
      min: dataset.return_count_min,
      max: dataset.return_count_max,
    },
    metrics,
  };
}

function validatePrivateRow(row, scope, budgetMax) {
  if (
    !isRecord(row) ||
    typeof row.no_answer !== 'boolean' ||
    !Number.isInteger(row.returned) ||
    row.returned < 0 ||
    !Number.isInteger(row.request_response_chars) ||
    row.request_response_chars < 0 ||
    row.request_response_chars > budgetMax ||
    !Array.isArray(row.mapping_failures)
  )
    throw new Error('private_row_shape:' + scope);
  for (const k of KS) {
    const value = row.by_k?.[k];
    if (
      !isRecord(value) ||
      !Number.isInteger(value.covered) ||
      !Number.isInteger(value.expected) ||
      value.covered < 0 ||
      value.expected < value.covered ||
      typeof value.complete !== 'boolean' ||
      typeof value.hit !== 'boolean' ||
      !within01(value.rr) ||
      value.complete !== (value.covered === value.expected) ||
      value.hit !== value.rr > 0
    )
      throw new Error('private_metric_shape:' + scope);
  }
}

function validateQasperRow(row, budgetMax) {
  if (
    !isRecord(row) ||
    typeof row.eligible !== 'boolean' ||
    !Array.isArray(row.mapping_failures) ||
    !Number.isInteger(row.request_response_chars) ||
    row.request_response_chars < 0 ||
    row.request_response_chars > budgetMax ||
    (row.eligible &&
      (typeof row.strict_complete !== 'boolean' ||
        !within01(row.strict_coverage)))
  )
    throw new Error('qasper_row_shape');
}

function validateOfficialRow(row, scope) {
  if (!isRecord(row)) throw new Error('official_row_shape:' + scope);
  if (scope === 'qasper') {
    if (!within01(row['Evidence F1']) || typeof row.eligible !== 'boolean')
      throw new Error('qasper_official_row_shape');
    return;
  }
  for (const name of FIXED_METRICS) {
    if (!within01(row[name])) throw new Error('fixed_metric_missing:' + scope);
  }
  if (scope !== 'du') {
    for (const name of ['alpha-nDCG@10', 'Coverage@10']) {
      if (!within01(row[name]))
        throw new Error('fixed_diversity_metric_missing:' + scope);
    }
  }
  for (const value of Object.values(row)) {
    if (typeof value === 'number' && !within01(value))
      throw new Error('fixed_metric_shape:' + scope);
  }
}
export async function pinnedScoringCode(freeze) {
  const files = Array.isArray(freeze.execution_files)
    ? freeze.execution_files
    : [];
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const result = {};
  for (const name of SCORING_EXECUTION_FILES) {
    const suffix = '/' + name;
    const candidates = files.filter(
      (entry) =>
        typeof entry.path === 'string' &&
        entry.path.replaceAll('\\', '/').endsWith(suffix) &&
        typeof entry.sha256 === 'string',
    );
    if (candidates.length !== 1)
      throw new Error('frozen_score_code_pin_missing:' + name);
    const bytes = await fs.readFile(path.join(projectRoot, name));
    const actual = hash(bytes);
    if (actual !== candidates[0].sha256)
      throw new Error('frozen_score_code_hash_mismatch:' + name);
    result[name] = actual;
  }
  return result;
}

async function readQueryIds(manifest, scopes) {
  const result = {};
  for (const scope of scopes) {
    const info = manifest.scopes[scope];
    if (!info.queries?.path || !info.queries?.sha256)
      throw new Error('query_manifest_missing:' + scope);
    const bytes = await fs.readFile(info.queries.path);
    if (hash(bytes) !== info.queries.sha256)
      throw new Error('query_manifest_hash_mismatch:' + scope);
    const rows = jsonl(bytes, 'queries/' + scope);
    const ids = rows.map((row) => String(row.id));
    if (ids.length !== info.questions || new Set(ids).size !== ids.length)
      throw new Error('query_manifest_count_mismatch:' + scope);
    result[scope] = ids;
  }
  return result;
}

function format(value) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(4);
}

function percent(value) {
  return value === null || value === undefined
    ? '—'
    : (100 * value).toFixed(2) + '%';
}

function renderMarkdown(summary) {
  const lines = [
    '# 产品检索对比成绩汇总',
    '',
    '\u672c\u62a5\u544a\u4ec5\u5305\u542b Echo \u4e0e Dify\u3002Khoj \u6d4b\u8bd5\u7531\u7528\u6237\u53d6\u6d88\uff0c\u5176\u90e8\u5206\u6570\u636e\u4e0d\u8ba1\u5165\u6210\u7ee9\uff1b\u56e0\u6b64\u672c\u62a5\u544a\u4e0d\u662f\u56db\u6761\u4ef6\u5168\u91cf\u7ed3\u679c\u3002',
    '本报告只汇总冻结后的逐题评分，不把两产品合成一个总分，也不据此选择最优条件。',
    '',
    '## 来源与覆盖',
    '',
    '| 项目 | SHA-256 / 数量 |',
    '| --- | --- |',
    '| freeze.json | ' + summary.provenance.freeze_sha256 + ' |',
    '| index-freeze.json | ' + summary.provenance.index_freeze_sha256 + ' |',
    '| corpus manifest | ' + summary.provenance.manifest_sha256 + ' |',
    '| 汇总脚本 | ' + summary.provenance.summarizer_sha256 + ' |',
    '| 唯一题目覆盖 | 每个条件 3507 题；私有200、QASPER1005、固定库2302 |',
    '| 映射缺口 | 0 |',
    '',
    '每个条件的12个评分输入文件SHA-256均记录在 summary.json 中。',
    '',
    '## 私有评测',
    '',
    '完整覆盖与Hit的分母是196道可回答题，事实覆盖分母是403个事实；无答案题4道单独记录。',
    '',
    '| 子集 | 条件 | 题数 | 完整@10 | 事实覆盖@10 | Hit@10 | MRR@10 | 上下文均值/预算字符 | 无答案非空 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const [scope, group] of Object.entries(summary.private.scopes)) {
    for (const condition of CONDITIONS) {
      const item = group.conditions[condition];
      const complete = item.by_k[10].complete;
      const facts = item.by_k[10].facts;
      const hit = item.by_k[10].hit;
      lines.push(
        '| ' +
          scope +
          ' | ' +
          condition +
          ' | ' +
          item.questions +
          ' | ' +
          complete.count +
          '/' +
          complete.denominator +
          ' (' +
          percent(complete.rate) +
          ') | ' +
          facts.covered +
          '/' +
          facts.denominator +
          ' (' +
          percent(facts.rate) +
          ') | ' +
          hit.count +
          '/' +
          hit.denominator +
          ' (' +
          percent(hit.rate) +
          ') | ' +
          format(item.by_k[10].mrr) +
          ' | ' +
          format(item.mean_context_chars) +
          '/' +
          item.context_budget_max_chars +
          ' | ' +
          item.no_answer.nonempty +
          '/' +
          item.no_answer.count +
          ' |',
      );
    }
  }
  lines.push(
    '',
    '## QASPER',
    '',
    '严格来源覆盖只在800道符合条件的题目上计算；官方 Evidence F1 在全部1005道题上计算，两者分母分开。',
    '',
    '| 条件 | 严格完整覆盖 | 严格覆盖均值 | 官方 Evidence F1 | 上下文均值/预算字符 |',
    '| --- | ---: | ---: | ---: | ---: |',
  );
  for (const condition of CONDITIONS) {
    const item = summary.qasper.conditions[condition];
    lines.push(
      '| ' +
        condition +
        ' | ' +
        item.strict.complete +
        '/' +
        item.strict.denominator +
        ' (' +
        percent(item.strict.complete / item.strict.denominator) +
        ') | ' +
        format(item.strict.coverage_mean) +
        ' | ' +
        format(item.official_evidence_f1.mean) +
        ' (n=' +
        item.official_evidence_f1.denominator +
        ') | ' +
        format(item.strict.context_mean_chars) +
        '/' +
        item.strict.context_budget_max_chars +
        ' |',
    );
  }
  lines.push(
    '',
    '## 固定公开库',
    '',
    '候选上限来自冻结配置；实际返回数量范围也一并列出。Du 的 alpha-nDCG 与 Coverage 不适用。',
    '',
    '| 数据库 | 条件 | 题数 | 候选上限 | 返回数范围 | nDCG@10 | alpha-nDCG@10 | Coverage@10 | Recall@10 | MRR@10 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const [scope, group] of Object.entries(summary.fixed)) {
    for (const condition of CONDITIONS) {
      const item = group.conditions[condition];
      lines.push(
        '| ' +
          scope +
          ' | ' +
          condition +
          ' | ' +
          item.questions +
          ' | ' +
          item.candidate_limit +
          ' | ' +
          item.observed_return_count.min +
          '–' +
          item.observed_return_count.max +
          ' | ' +
          format(item.metrics['nDCG@10']) +
          ' | ' +
          format(item.metrics['alpha-nDCG@10']) +
          ' | ' +
          format(item.metrics['Coverage@10']) +
          ' | ' +
          format(item.metrics['Recall@10']) +
          ' | ' +
          format(item.metrics['MRR@10']) +
          ' |',
      );
    }
  }
  lines.push(
    '',
    '## 逐题配对',
    '',
    'W/L/T 为 Echo 相对对照条件的逐题胜、负、平数量。数值指标同时报告 Echo 减对照的逐题均值差；完整覆盖表的行是 Echo，列是对照条件。',
    '',
    '### 私有完整覆盖@10 的 2×2',
    '',
    '| 对照条件 | 两者完整 | 仅Echo完整 | 仅对照完整 | 两者未完整 | W/L/T | 事实覆盖均值差@10 | 上下文均值差字符 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const condition of CONDITIONS.filter((name) => name !== 'echo')) {
    const pair = summary.paired.private.overall[condition];
    const cells = pair.complete_at_10.complete_2x2.cells;
    lines.push(
      '| ' +
        condition +
        ' | ' +
        cells[0][0] +
        ' | ' +
        cells[0][1] +
        ' | ' +
        cells[1][0] +
        ' | ' +
        cells[1][1] +
        ' | ' +
        pair.complete_at_10.wins +
        '/' +
        pair.complete_at_10.losses +
        '/' +
        pair.complete_at_10.ties +
        ' | ' +
        format(pair.fact_coverage_at_10.mean_delta) +
        ' | ' +
        format(pair.context_mean_chars.mean_delta) +
        ' |',
    );
  }
  lines.push(
    '',
    '### QASPER配对',
    '',
    '| 对照条件 | 官方F1 W/L/T | 官方F1均值差 | 严格覆盖 W/L/T | 严格覆盖均值差 | 上下文均值差字符 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const condition of CONDITIONS.filter((name) => name !== 'echo')) {
    const pair = summary.paired.qasper[condition];
    lines.push(
      '| ' +
        condition +
        ' | ' +
        pair.official_evidence_f1.wins +
        '/' +
        pair.official_evidence_f1.losses +
        '/' +
        pair.official_evidence_f1.ties +
        ' | ' +
        format(pair.official_evidence_f1.mean_delta) +
        ' | ' +
        pair.strict_coverage.wins +
        '/' +
        pair.strict_coverage.losses +
        '/' +
        pair.strict_coverage.ties +
        ' | ' +
        format(pair.strict_coverage.mean_delta) +
        ' | ' +
        format(pair.context_mean_chars.mean_delta) +
        ' |',
    );
  }
  lines.push(
    '',
    '### 固定库逐题配对',
    '',
    '每行均为 Echo 对照相应条件；各库和指标独立统计。',
    '',
    '| 数据库 | 对照条件 | 指标 | W/L/T | Echo减对照均值差 |',
    '| --- | --- | --- | ---: | ---: |',
  );
  for (const [scope, byOpponent] of Object.entries(summary.paired.fixed)) {
    for (const condition of CONDITIONS.filter((name) => name !== 'echo')) {
      for (const [metric, pair] of Object.entries(byOpponent[condition])) {
        lines.push(
          '| ' +
            scope +
            ' | ' +
            condition +
            ' | ' +
            metric +
            ' | ' +
            pair.wins +
            '/' +
            pair.losses +
            '/' +
            pair.ties +
            ' | ' +
            format(pair.mean_delta) +
            ' |',
        );
      }
    }
  }
  lines.push(
    '',
    '私有各子集、四档K值、QASPER及固定库的完整配对记录见 summary.json。题目ID、题干和证据正文不写入报告。',
    '',
  );
  return lines.join('\n');
}
async function summarizeProductComparison(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const freezePath = path.join(absoluteRoot, 'freeze.json');
  const manifestPath = path.join(absoluteRoot, 'corpus-v1', 'manifest.json');
  const indexPath = path.join(absoluteRoot, 'index-freeze.json');
  if (!(await exists(freezePath))) return pending([{ code: 'freeze_missing' }]);
  if (!(await exists(manifestPath)))
    return pending([{ code: 'manifest_missing' }]);
  if (!(await exists(indexPath)))
    return pending([{ code: 'index_freeze_missing' }]);

  let freezeBytes;
  let manifestBytes;
  let indexBytes;
  let freeze;
  let manifest;
  try {
    [freezeBytes, manifestBytes, indexBytes] = await Promise.all([
      fs.readFile(freezePath),
      fs.readFile(manifestPath),
      fs.readFile(indexPath),
    ]);
    freeze = json(freezeBytes, 'freeze.json');
    manifest = json(manifestBytes, 'corpus-v1/manifest.json');
  } catch (error) {
    return pending([
      {
        code:
          error instanceof Error && error.message.startsWith('invalid_json:')
            ? error.message
            : 'freeze_read_failed',
      },
    ]);
  }
  if (freeze.status !== 'frozen')
    return pending([{ code: 'freeze_not_frozen' }]);
  if (hash(manifestBytes) !== freeze.corpus_manifest_sha256)
    return pending([{ code: 'manifest_hash_mismatch' }]);
  if (!freeze.index_freeze || hash(indexBytes) !== freeze.index_freeze.sha256)
    return pending([{ code: 'index_freeze_hash_mismatch' }]);
  if (
    freeze.packing?.topk !== 10 ||
    freeze.packing?.source_cap !== 6 ||
    freeze.packing?.max_context_chars !== 20000
  )
    return pending([{ code: 'freeze_packing_mismatch' }]);
  try {
    validateManifest(manifest);
  } catch (error) {
    return pending([
      { code: error instanceof Error ? error.message : 'manifest_invalid' },
    ]);
  }
  const frozenConditions = freeze.conditions;
  if (
    !isRecord(frozenConditions) ||
    Object.keys(frozenConditions).length !== FROZEN_CONDITIONS.length ||
    FROZEN_CONDITIONS.some(
      (condition) => !Object.hasOwn(frozenConditions, condition),
    )
  )
    return pending([{ code: 'frozen_condition_set_mismatch' }]);

  let scoringInputsCount;
  try {
    scoringInputsCount = await validateScoringInputs(freeze.scoring_inputs);
  } catch (error) {
    return pending([
      {
        code: error instanceof Error ? error.message : 'scoring_inputs_invalid',
      },
    ]);
  }

  const required = [];
  for (const condition of CONDITIONS) {
    for (const name of scoreNames()) {
      required.push({
        condition,
        name,
        path: path.join(absoluteRoot, 'scores', condition, name),
      });
    }
    required.push({
      condition,
      name: POST_RUN_RECEIPT_NAME,
      path: path.join(absoluteRoot, 'scores', condition, POST_RUN_RECEIPT_NAME),
    });
    required.push({
      condition,
      name: INVOCATION_RECEIPT_NAME,
      path: path.join(
        absoluteRoot,
        'scores',
        condition,
        INVOCATION_RECEIPT_NAME,
      ),
    });
  }
  const missing = [];
  for (const file of required) {
    if (!(await exists(file.path)))
      missing.push(file.condition + '/' + file.name);
  }
  if (missing.length) {
    return pending([
      {
        code: 'score_files_missing',
        missing_count: missing.length,
        sample: missing.slice(0, 12),
      },
    ]);
  }

  const data = {};
  const scoreHashes = {};
  const postRunReceipts = {};
  const postRunReceiptHashes = {};
  const invocationReceipts = {};
  const invocationReceiptHashes = {};
  try {
    for (const condition of CONDITIONS) {
      data[condition] = {};
      scoreHashes[condition] = {};
      for (const name of scoreNames()) {
        const bytes = await fs.readFile(
          path.join(absoluteRoot, 'scores', condition, name),
        );
        scoreHashes[condition][name] = hash(bytes);
        data[condition][name] = name.endsWith('.jsonl')
          ? jsonl(bytes, condition + '/' + name)
          : json(bytes, condition + '/' + name);
      }
      const receiptBytes = await fs.readFile(
        path.join(absoluteRoot, 'scores', condition, POST_RUN_RECEIPT_NAME),
      );
      postRunReceiptHashes[condition] = hash(receiptBytes);
      postRunReceipts[condition] = json(
        receiptBytes,
        condition + '/' + POST_RUN_RECEIPT_NAME,
      );
      const invocationBytes = await fs.readFile(
        path.join(absoluteRoot, 'scores', condition, INVOCATION_RECEIPT_NAME),
      );
      invocationReceiptHashes[condition] = hash(invocationBytes);
      invocationReceipts[condition] = json(
        invocationBytes,
        condition + '/' + INVOCATION_RECEIPT_NAME,
      );
    }
  } catch (error) {
    return pending([
      {
        code:
          error instanceof Error &&
          /^(invalid_json|invalid_jsonl):/.test(error.message)
            ? error.message
            : 'score_file_read_failed',
      },
    ]);
  }

  let scoringCode;
  try {
    scoringCode = await pinnedScoringCode(freeze);
  } catch (error) {
    return pending([
      {
        code:
          error instanceof Error ? error.message : 'scoring_code_pin_failed',
      },
    ]);
  }

  let receiptWriterSha;
  let scoringOrchestratorSha;
  let runReceiptBindings;
  let runArtifactBindings;
  let frozenPublicRoot;
  try {
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const receiptWriterPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'receipt-product-comparison-scores.mjs',
    );
    const orchestratorPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'run-product-scoring.mjs',
    );
    receiptWriterSha = hash(await fs.readFile(receiptWriterPath));
    scoringOrchestratorSha = hash(await fs.readFile(orchestratorPath));
    frozenPublicRoot = resolveFrozenPublicRoot(freeze.scoring_inputs);
    runReceiptBindings = {};
    runArtifactBindings = {};
    for (const condition of CONDITIONS) {
      runArtifactBindings[condition] = await readProductRunArtifactBindings(
        absoluteRoot,
        condition,
      );
      runReceiptBindings[condition] = Object.fromEntries(
        PRODUCT_RUN_SCOPES.map((scope) => {
          const binding = runArtifactBindings[condition][scope];
          return [
            scope,
            { path: binding.receipt_path, sha256: binding.receipt_sha256 },
          ];
        }),
      );
    }
    for (const condition of CONDITIONS) {
      validatePostRunScoreReceipt(postRunReceipts[condition], {
        condition,
        freezeSha: hash(freezeBytes),
        manifestSha: hash(manifestBytes),
        scoreHashes: scoreHashes[condition],
        runReceipts: runReceiptBindings[condition],
        scoringCode,
        writerSha: receiptWriterSha,
      });
      validateProductScoringInvocationReceipt(invocationReceipts[condition], {
        condition,
        freezeSha: hash(freezeBytes),
        manifestSha: hash(manifestBytes),
        executorSha: scoringOrchestratorSha,
        receiptWriterSha,
        postRunReceiptSha: postRunReceiptHashes[condition],
        scoreHashes: scoreHashes[condition],
        runArtifacts: runArtifactBindings[condition],
        scoringCode,
        root: absoluteRoot,
        publicRoot: frozenPublicRoot,
        repoRoot: repositoryRoot,
      });
    }
  } catch (error) {
    return pending([
      {
        code:
          error instanceof Error
            ? error.message
            : 'score_provenance_receipt_invalid',
      },
    ]);
  }

  let queries;
  try {
    queries = await readQueryIds(manifest, [
      ...EVIDENCE_SCOPES,
      ...FIXED_LAYOUT.map((item) => item.scope),
    ]);
  } catch (error) {
    return pending([
      {
        code: error instanceof Error ? error.message : 'query_manifest_invalid',
      },
    ]);
  }

  const privateReports = {};
  const qasperEvidence = {};
  const qasperOfficial = {};
  const fixedOfficial = {};
  const fixedReports = {};
  let mappingGaps = 0;
  let validationError = null;
  try {
    for (const condition of CONDITIONS) {
      const evidenceSummary = data[condition]['evidence-summary.json'];
      const privateQuestionCount = PRIVATE_LAYOUT.reduce(
        (sum, item) => sum + item.questions,
        0,
      );
      if (
        !isRecord(evidenceSummary) ||
        evidenceSummary.condition !== condition ||
        evidenceSummary.status !== EVIDENCE_STATUS ||
        evidenceSummary.checks?.questions !==
          privateQuestionCount + QASPER_QUESTIONS ||
        evidenceSummary.checks?.budget_recomputed !==
          privateQuestionCount + QASPER_QUESTIONS
      )
        throw new Error('evidence_summary_status:' + condition);
      const checks = evidenceSummary.checks;
      if (
        !Number.isInteger(checks.selected_chunks) ||
        !Number.isInteger(checks.mapped_chunks) ||
        !Number.isInteger(checks.unmapped_chunks) ||
        checks.selected_chunks !== checks.mapped_chunks + checks.unmapped_chunks
      )
        throw new Error('mapping_check_shape:' + condition);
      let conditionMappingGaps = 0;
      const privateRows = [];

      for (const item of PRIVATE_LAYOUT) {
        const scope = item.scope;
        const rows = data[condition][scope + '.jsonl'];
        const rowsById = idMap(rows, condition + '/' + scope);
        validateIds(queries[scope], rowsById, condition + '/' + scope);
        for (const row of rows) {
          validatePrivateRow(row, scope, freeze.packing.max_context_chars);
          if (row.scope !== scope)
            throw new Error('scope_label_mismatch:' + scope);
          conditionMappingGaps += row.mapping_failures.length;
        }
        privateRows.push(...rows);
        const answerable = rows.filter((row) => !row.no_answer);
        if (
          rows.length !== item.questions ||
          answerable.length !== item.answerable
        )
          throw new Error('private_question_count:' + scope);
        if (
          answerable.some((row) => KS.some((k) => row.by_k[k].expected === 0))
        )
          throw new Error('answerable_without_facts:' + scope);
        for (const k of KS) {
          const expectedFacts = answerable.reduce(
            (sum, row) => sum + row.by_k[k].expected,
            0,
          );
          if (expectedFacts !== item.facts)
            throw new Error('private_fact_denominator:' + scope);
        }
        privateReports[scope] ||= {};
        privateReports[scope][condition] = privateReport(
          scope,
          rows.map((row) => ({
            no_answer: row.no_answer,
            returned: row.returned,
            request_response_chars: row.request_response_chars,
            by_k: row.by_k,
          })),
          freeze.packing.max_context_chars,
        );
      }
      validatePrivateEvidenceSummary(evidenceSummary.private, privateRows);

      const qasperRaw = data[condition]['qasper.jsonl'];
      const qasperMap = idMap(qasperRaw, condition + '/qasper');
      validateIds(queries.qasper, qasperMap, condition + '/qasper');
      for (const row of qasperRaw) {
        validateQasperRow(row, freeze.packing.max_context_chars);
        conditionMappingGaps += row.mapping_failures.length;
      }
      const eligibleRows = qasperRaw.filter((row) => row.eligible);
      if (
        qasperRaw.length !== QASPER_QUESTIONS ||
        eligibleRows.length !== QASPER_ELIGIBLE
      )
        throw new Error('qasper_eligible_denominator:' + condition);
      qasperEvidence[condition] = qasperRaw.map((row) => ({
        id: String(row.id),
        eligible: row.eligible,
        strict_complete: row.strict_complete,
        strict_coverage: row.strict_coverage,
        request_response_chars: row.request_response_chars,
      }));

      const publicSummary = data[condition]['official-public-summary.json'];
      if (
        !isRecord(publicSummary) ||
        publicSummary.condition !== condition ||
        publicSummary.status !== 'official-public-scored' ||
        !isRecord(publicSummary.datasets)
      )
        throw new Error('public_summary_status:' + condition);

      const qasperObject = data[condition]['qasper-official-per-query.json'];
      if (!isRecord(qasperObject)) throw new Error('qasper_official_shape');
      const qasperMapPublic = new Map(Object.entries(qasperObject));
      validateIds(
        queries.qasper,
        new Map([...qasperMapPublic].map(([id, row]) => [id, { id, ...row }])),
        condition + '/qasper-official',
      );
      for (const row of qasperMapPublic.values())
        validateOfficialRow(row, 'qasper');
      for (const [id, row] of qasperMap) {
        if (qasperMapPublic.get(id)?.eligible !== row.eligible)
          throw new Error('qasper_eligibility_mismatch:' + condition);
      }
      const qasperSummary = publicSummary.datasets.qasper;
      const qasperResult = qasperReport(
        qasperEvidence[condition],
        qasperMapPublic,
        freeze.packing.max_context_chars,
      );
      if (
        qasperSummary?.questions !== QASPER_QUESTIONS ||
        qasperSummary.missing_predictions !== 0 ||
        !close(
          qasperSummary['Evidence F1'],
          mean([...qasperMapPublic.values()].map((row) => row['Evidence F1'])),
        )
      )
        throw new Error('qasper_public_summary_mismatch:' + condition);
      try {
        validateQasperEvidenceSummary(evidenceSummary.qasper, qasperRaw);
      } catch {
        throw new Error('qasper_evidence_summary_mismatch:' + condition);
      }
      if (evidenceSummary.qasper.complete !== qasperResult.strict.complete)
        throw new Error('qasper_evidence_summary_mismatch:' + condition);
      qasperOfficial[condition] = qasperMapPublic;

      fixedOfficial[condition] = {};
      for (const item of FIXED_LAYOUT) {
        const scope = item.scope;
        const object = data[condition][scope + '-official-per-query.json'];
        if (!isRecord(object))
          throw new Error('fixed_per_query_shape:' + scope);
        const perQuery = new Map(Object.entries(object));
        validateIds(
          queries[scope],
          new Map([...perQuery].map(([id, row]) => [id, { id, ...row }])),
          condition + '/' + scope,
        );
        for (const row of perQuery.values()) validateOfficialRow(row, scope);
        const dataset = publicSummary.datasets[scope];
        const limit = frozenConditions[condition].fixed_return_limit;
        if (
          !dataset ||
          dataset.questions !== item.questions ||
          dataset.configured_return_limit !== limit ||
          !Number.isInteger(dataset.return_count_min) ||
          !Number.isInteger(dataset.return_count_max) ||
          dataset.return_count_min < 0 ||
          dataset.return_count_max > limit ||
          dataset.return_count_min > dataset.return_count_max
        )
          throw new Error('fixed_summary_denominator:' + scope);
        const requiredMetrics =
          scope === 'du'
            ? FIXED_METRICS
            : [...FIXED_METRICS, 'alpha-nDCG@10', 'Coverage@10'];
        if (requiredMetrics.some((name) => !within01(dataset.metrics?.[name])))
          throw new Error('fixed_summary_metrics:' + scope);
        for (const [name, expected] of Object.entries(dataset.metrics)) {
          const values = [...perQuery.values()].map((row) => row[name]);
          if (
            values.some((value) => !within01(value)) ||
            !close(mean(values), expected)
          )
            throw new Error('fixed_metric_mean_mismatch:' + scope);
        }
        fixedOfficial[condition][scope] = perQuery;
        fixedReports[scope] ||= {};
        fixedReports[scope][condition] = fixedReport(
          scope,
          publicSummary,
          perQuery,
          limit,
        );
      }
      const selectedChunks =
        privateRows.reduce((sum, row) => sum + row.returned, 0) +
        qasperRaw.reduce((sum, row) => sum + row.returned, 0);
      if (
        conditionMappingGaps !== checks.unmapped_chunks ||
        checks.selected_chunks !== selectedChunks ||
        checks.mapped_chunks !== selectedChunks - conditionMappingGaps
      )
        throw new Error('mapping_gap_count_mismatch:' + condition);
      mappingGaps += checks.unmapped_chunks;
    }
  } catch (error) {
    validationError =
      error instanceof Error ? error.message : 'score_validation_failed';
  }

  const reasons = [];
  if (mappingGaps) reasons.push({ code: 'mapping_gaps', count: mappingGaps });
  if (validationError)
    reasons.push({ code: 'score_validation_failed', detail: validationError });
  if (reasons.length) return pending(reasons);
  const allPrivate = {};
  const privateOverall = {};
  for (const condition of CONDITIONS) {
    allPrivate[condition] = PRIVATE_LAYOUT.flatMap((item) =>
      data[condition][item.scope + '.jsonl'].map((row) => ({
        id: item.scope + '\0' + String(row.id),
        no_answer: row.no_answer,
        returned: row.returned,
        request_response_chars: row.request_response_chars,
        by_k: row.by_k,
      })),
    );
    privateOverall[condition] = privateReport(
      'private-total',
      allPrivate[condition],
      freeze.packing.max_context_chars,
    );
  }

  const privatePairs = {};
  for (const opponent of CONDITIONS.filter((name) => name !== 'echo')) {
    const byScope = {};
    for (const item of PRIVATE_LAYOUT) {
      const left = data.echo[item.scope + '.jsonl'];
      const right = data[opponent][item.scope + '.jsonl'];
      const values = {};
      for (const k of KS) {
        values[k] = {};
        for (const key of ['complete', 'fact_coverage', 'hit', 'mrr']) {
          values[k][key] = paired(
            left,
            right,
            (row) => privateMetric(row, key, k),
            {
              filter: (a, b) => !a.no_answer && !b.no_answer,
              completeTable: key === 'complete' && k === 10,
            },
          );
        }
      }
      values.context_mean_chars = pairedDifference(
        left,
        right,
        (row) => row.request_response_chars,
      );
      byScope[item.scope] = values;
    }
    const overall = {};
    for (const k of KS) {
      overall[k] = {};
      for (const key of ['complete', 'fact_coverage', 'hit', 'mrr']) {
        overall[k][key] = paired(
          allPrivate.echo,
          allPrivate[opponent],
          (row) => privateMetric(row, key, k),
          {
            filter: (a, b) => !a.no_answer && !b.no_answer,
            completeTable: key === 'complete' && k === 10,
          },
        );
      }
    }
    overall.context_mean_chars = pairedDifference(
      allPrivate.echo,
      allPrivate[opponent],
      (row) => row.request_response_chars,
    );
    privatePairs[opponent] = {
      scopes: byScope,
      overall: {
        complete_at_10: overall[10].complete,
        fact_coverage_at_10: overall[10].fact_coverage,
        hit_at_10: overall[10].hit,
        mrr_at_10: overall[10].mrr,
        by_k: overall,
        context_mean_chars: overall.context_mean_chars,
      },
    };
  }

  const qasperPairs = {};
  for (const opponent of CONDITIONS.filter((name) => name !== 'echo')) {
    const echoEvidence = qasperEvidence.echo;
    const otherEvidence = qasperEvidence[opponent];
    const echoOfficialRows = [...qasperOfficial.echo].map(([id, row]) => ({
      id,
      value: row['Evidence F1'],
    }));
    const otherOfficialRows = [...qasperOfficial[opponent]].map(
      ([id, row]) => ({
        id,
        value: row['Evidence F1'],
      }),
    );
    qasperPairs[opponent] = {
      official_evidence_f1: paired(
        echoOfficialRows,
        otherOfficialRows,
        (row) => row.value,
      ),
      strict_coverage: paired(
        echoEvidence,
        otherEvidence,
        (row) => row.strict_coverage,
        { filter: (a, b) => a.eligible && b.eligible },
      ),
      strict_complete: paired(
        echoEvidence,
        otherEvidence,
        (row) => row.strict_complete,
        { filter: (a, b) => a.eligible && b.eligible },
      ),
      context_mean_chars: pairedDifference(
        echoEvidence,
        otherEvidence,
        (row) => row.request_response_chars,
      ),
    };
    if (
      qasperPairs[opponent].official_evidence_f1.questions !==
        QASPER_QUESTIONS ||
      qasperPairs[opponent].strict_coverage.questions !== QASPER_ELIGIBLE
    )
      throw new Error('qasper_pair_denominator:' + opponent);
  }

  const fixedPairs = {};
  for (const item of FIXED_LAYOUT) {
    fixedPairs[item.scope] = {};
    for (const opponent of CONDITIONS.filter((name) => name !== 'echo')) {
      const leftMap = fixedOfficial.echo[item.scope];
      const rightMap = fixedOfficial[opponent][item.scope];
      const left = [...leftMap].map(([id, row]) => ({ id, ...row }));
      const right = [...rightMap].map(([id, row]) => ({ id, ...row }));
      fixedPairs[item.scope][opponent] = {};
      for (const metric of Object.keys(fixedReports[item.scope].echo.metrics)) {
        fixedPairs[item.scope][opponent][metric] = paired(
          left,
          right,
          (row) => row[metric],
        );
      }
    }
  }

  const moduleBytes = await fs.readFile(fileURLToPath(import.meta.url));
  const manifestHash = hash(manifestBytes);
  const indexHash = hash(indexBytes);
  const freezeHash = hash(freezeBytes);
  const scopes = {};
  for (const item of PRIVATE_LAYOUT) {
    scopes[item.scope] = {
      questions: item.questions,
      answerable: item.answerable,
      facts: item.facts,
      conditions: privateReports[item.scope],
    };
  }
  const summary = {
    schema_version: 1,
    status: 'complete',
    coverage: {
      distinct_questions: TOTAL_QUESTIONS,
      per_condition: TOTAL_QUESTIONS,
      conditions: CONDITIONS,
      excluded_conditions: {
        conditions: ['khoj-dense', 'khoj-rerank'],
        reason: 'user_cancelled',
        included_in_metrics: false,
      },
      private: { questions: 200, answerable: 196, facts: 403, no_answer: 4 },
      qasper: { questions: QASPER_QUESTIONS, strict_eligible: QASPER_ELIGIBLE },
      fixed: { langchain: 203, godot: 99, du: 2000 },
      mapping_gaps: 0,
    },
    provenance: {
      freeze_sha256: freezeHash,
      index_freeze_sha256: indexHash,
      manifest_sha256: manifestHash,
      summarizer_sha256: hash(moduleBytes),
      frozen_scoring_code_sha256: scoringCode,
      scoring_inputs_count: scoringInputsCount,
      score_receipts_sha256: postRunReceiptHashes,
      scoring_invocation_receipts_sha256: invocationReceiptHashes,
      score_files_sha256: scoreHashes,
    },
    packing: freeze.packing,
    conditions: Object.fromEntries(
      CONDITIONS.map((condition) => [
        condition,
        {
          fixed_candidate_limit: frozenConditions[condition].fixed_return_limit,
        },
      ]),
    ),
    private: {
      scopes,
      same_collection_overall: {
        questions: 200,
        answerable: 196,
        facts: 403,
        conditions: privateOverall,
      },
    },
    qasper: {
      questions: QASPER_QUESTIONS,
      strict_eligible: QASPER_ELIGIBLE,
      conditions: Object.fromEntries(
        CONDITIONS.map((condition) => [
          condition,
          qasperReport(
            qasperEvidence[condition],
            qasperOfficial[condition],
            freeze.packing.max_context_chars,
          ),
        ]),
      ),
    },
    fixed: Object.fromEntries(
      FIXED_LAYOUT.map((item) => [
        item.scope,
        { questions: item.questions, conditions: fixedReports[item.scope] },
      ]),
    ),
    paired: {
      private: privatePairs,
      qasper: qasperPairs,
      fixed: fixedPairs,
    },
  };

  const outputDir = path.join(absoluteRoot, 'analysis');
  const summaryPath = path.join(outputDir, 'summary.json');
  const markdownPath = path.join(outputDir, 'summary.zh.md');
  if ((await exists(summaryPath)) || (await exists(markdownPath)))
    return pending([{ code: 'summary_output_exists' }]);
  if (options.dryRun) {
    return {
      status: 'ready',
      would_write: ['analysis/summary.json', 'analysis/summary.zh.md'],
      score_file_count: CONDITIONS.length * scoreNames().length,
      score_receipt_count: CONDITIONS.length,
      invocation_receipt_count: CONDITIONS.length,
      mapping_gaps: 0,
    };
  }

  const summaryText = JSON.stringify(summary, null, 2) + '\n';
  const markdownText = renderMarkdown(summary);
  const written = [];
  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(summaryPath, summaryText, { flag: 'wx' });
    written.push(summaryPath);
    await fs.writeFile(markdownPath, markdownText, { flag: 'wx' });
    written.push(markdownPath);
  } catch {
    await Promise.all(
      written.map((file) => fs.rm(file, { force: true }).catch(() => {})),
    );
    return pending([{ code: 'summary_write_failed' }]);
  }
  return {
    status: 'written',
    files: ['analysis/summary.json', 'analysis/summary.zh.md'],
    summarizer_sha256: summary.provenance.summarizer_sha256,
    freeze_sha256: summary.provenance.freeze_sha256,
    score_file_count: CONDITIONS.length * scoreNames().length,
    score_receipt_count: CONDITIONS.length,
    invocation_receipt_count: CONDITIONS.length,
  };
}

export { summarizeProductComparison };

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = args.find((arg) => !arg.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!root) {
    process.stderr.write(
      'Usage: node evals/summarize-product-comparison.mjs ROOT [--dry-run]\n',
    );
    process.exitCode = 2;
  } else {
    const result = await summarizeProductComparison(root, { dryRun });
    process.stdout.write(
      JSON.stringify(
        {
          status: result.status,
          ...(result.reasons ? { reasons: result.reasons } : {}),
          ...(result.would_write ? { would_write: result.would_write } : {}),
          ...(result.files ? { files: result.files } : {}),
          ...(result.score_file_count !== undefined
            ? { score_file_count: result.score_file_count }
            : {}),
          ...(result.invocation_receipt_count !== undefined
            ? { invocation_receipt_count: result.invocation_receipt_count }
            : {}),
          ...(result.freeze_sha256
            ? { freeze_sha256: result.freeze_sha256 }
            : {}),
          ...(result.summarizer_sha256
            ? { summarizer_sha256: result.summarizer_sha256 }
            : {}),
        },
        null,
        2,
      ) + '\n',
    );
    if (result.status === 'pending') process.exitCode = 2;
  }
}
