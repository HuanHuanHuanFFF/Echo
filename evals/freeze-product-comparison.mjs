import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fileSha256 } from './lib/product-freeze.mjs';
import { validateIndexReceipt } from './lib/product-index-receipt.mjs';
import { requiredProductRunExecutionFiles } from './lib/product-run-integrity.mjs';

const MODELS = Object.freeze({
  name: 'qwen3.7-text-embedding',
  dimensions: 1024,
});

const ECHO_ARM = Object.freeze({
  id: 'public-A',
  minisearch_k: 1.2,
  minisearch_b: 0.7,
  minisearch_d: 0.5,
  bm25_weight: 0.5,
  dense_weight: 1,
  rrf_k: 10,
  reason:
    '公开全量主臂A：新综合1.0.1、MiniSearch无匹配词乘数、BM25=0.5、dense=1、RRF10、cap6、预算20000。',
  retrieval: Object.freeze({
    max_chunks_per_source: 6,
    max_context_chars: 20000,
  }),
});

function digestText(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonical(file) {
  return path.resolve(file).replaceAll('\\', '/').toLowerCase();
}

function within(root, file) {
  const base = path
    .resolve(root)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
  const candidate = path.resolve(file).toLowerCase();
  return (
    candidate === base || candidate.startsWith(base + path.sep.toLowerCase())
  );
}

function addBlocker(blockers, code) {
  if (!blockers.includes(code)) blockers.push(code);
}

async function readJson(file, label) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new Error(label);
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonlIds(file, label) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(label);
  }
  const ids = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(label);
    }
    const id = String(row?.id ?? '');
    if (!id) throw new Error(label);
    ids.push(id);
  }
  return ids;
}

async function collectTree(root, extensions, blockers, label) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      addBlocker(blockers, label + '-directory-missing');
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '__pycache__' || entry.name === 'node_modules')
        continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        addBlocker(blockers, label + '-contains-symlink');
      } else if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (extensions.has(extension)) files.push(path.resolve(file));
      }
    }
  }
  await visit(root);
  return files;
}

async function executionPaths(
  root,
  privateRoot,
  repository,
  validIndexReceipts,
  blockers,
) {
  const evalFiles = await collectTree(
    path.join(repository, 'evals'),
    new Set(['.mjs', '.js', '.cjs', '.py']),
    blockers,
    'evals-code',
  );
  // The post-run report binds its own code and score artifacts independently.
  // It does not generate queries, rankings, evidence mappings, or primary scores.
  const executionEvalFiles = evalFiles.filter(
    (file) => path.basename(file) !== 'summarize-product-comparison.mjs',
  );
  const distFiles = await collectTree(
    path.join(repository, 'dist'),
    new Set(['.js', '.mjs', '.cjs', '.json', '.node']),
    blockers,
    'dist-code',
  );
  const khojScripts = await collectTree(
    path.join(root, 'khoj-runtime', 'scripts'),
    new Set(['.mjs', '.js', '.py']),
    blockers,
    'khoj-runtime-code',
  );
  const fixedRuntimeFiles = [
    path.join(repository, 'package.json'),
    path.join(repository, 'package-lock.json'),
    path.join(root, 'corpus-v1', 'manifest.json'),
    path.join(root, 'index-freeze.json'),
    path.join(root, 'khoj-runtime', 'compose.yml'),
    path.join(repository, 'evals', 'run-final-four-arms.mjs'),
    path.join(repository, 'evals', 'lib', 'frozen-query-fetch.mjs'),
    path.join(repository, 'evals', 'audit-product-model-provenance.mjs'),
    path.join(privateRoot, 'query-fetch-guard-final.mjs'),
    path.join(root, 'khoj-runtime', 'filter-order-verification-20260924.json'),
    path.join(root, 'khoj-runtime', 'entry-adapter-source-20260924.py'),
    path.join(root, 'private-capture-source-verification-20260924.json'),
    path.join(
      root,
      'dify-runtime',
      'qasper-parent-mapping-preflight-20260924.json',
    ),
    ...validIndexReceipts.map((item) => item.path),
  ];
  const conditionFiles = [
    ...requiredProductRunExecutionFiles('echo'),
    ...requiredProductRunExecutionFiles('dify'),
    ...requiredProductRunExecutionFiles('khoj-dense'),
    ...requiredProductRunExecutionFiles('khoj-rerank'),
  ];
  const unique = new Map();
  for (const file of [
    ...executionEvalFiles,
    ...distFiles,
    ...khojScripts,
    ...fixedRuntimeFiles,
    ...conditionFiles,
  ]) {
    unique.set(canonical(file), path.resolve(file));
  }
  const pins = [];
  for (const file of [...unique.values()].sort((a, b) =>
    canonical(a).localeCompare(canonical(b)),
  )) {
    try {
      pins.push({ path: file, sha256: await fileSha256(file) });
    } catch {
      addBlocker(blockers, 'required-code-or-runtime-file-missing');
    }
  }
  return pins;
}

async function scoringInputPaths(publicRoot, blockers) {
  const required = [
    path.join(publicRoot, 'data', 'du-qrels.jsonl'),
    path.join(publicRoot, 'data', 'qasper-dev.jsonl'),
    path.join(publicRoot, 'reference', 'scorer-source-manifest.json'),
  ];
  const referenceScripts = await collectTree(
    path.join(publicRoot, 'reference'),
    new Set(['.py']),
    blockers,
    'public-reference-scripts',
  );
  const scoringTools = await collectTree(
    path.join(publicRoot, 'scoring-tools'),
    new Set(['.py', '.pyd', '.dll', '.so', '.json', '.txt']),
    blockers,
    'official-scoring-tools',
  );
  const unique = new Map();
  for (const file of [...required, ...referenceScripts, ...scoringTools])
    unique.set(canonical(file), path.resolve(file));
  const bindings = {};
  for (const file of [...unique.values()].sort((a, b) =>
    canonical(a).localeCompare(canonical(b)),
  )) {
    try {
      const key = path.relative(publicRoot, file).replaceAll('\\', '/');
      bindings[key] = { path: file, sha256: await fileSha256(file) };
    } catch {
      addBlocker(blockers, 'official-scoring-input-missing');
    }
  }
  return bindings;
}

export async function inspectIndexReceipts({
  root,
  manifest,
  modelFingerprint,
  validator = validateIndexReceipt,
}) {
  const scopes = Object.keys(manifest.scopes ?? {}).sort();
  const valid = [];
  const pending = [];
  const invalid = [];
  for (const product of ['dify', 'khoj']) {
    for (const scope of scopes) {
      const file = path.join(
        root,
        'indexes',
        product,
        scope,
        'query-index-receipt.json',
      );
      if (!(await exists(file))) {
        pending.push({ product, scope });
        continue;
      }
      try {
        const verified = await validator({
          root,
          product,
          scope,
          info: manifest.scopes[scope],
          modelFingerprint,
        });
        valid.push({
          product,
          scope,
          path: verified.path ?? file,
          sha256: verified.sha256,
        });
      } catch {
        invalid.push({ product, scope });
      }
    }
  }
  return {
    expected: scopes.length * 2,
    scope_count: scopes.length,
    valid,
    pending,
    invalid,
  };
}

const RUNTIME_CONTAINERS = Object.freeze([
  'echo-compare-dify-api-1',
  'echo-compare-dify-worker-1',
  'echo-compare-dify-plugin_daemon-1',
  'echo-compare-dify-weaviate-1',
  'echo-compare-dify-redis-1',
  'echo-compare-dify-db_postgres-1',
  'khoj-product-comparison-server-1',
  'khoj-product-comparison-database-1',
]);

function captureRuntimeImages() {
  return RUNTIME_CONTAINERS.map((name) => {
    const output = execFileSync(
      'docker',
      ['inspect', '--format', '{{.Name}} {{.Image}}', name],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    const [actualName, imageId, extra] = output.split(/\s+/);
    assert.equal(actualName, '/' + name);
    assert.equal(extra, undefined);
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/i);
    return { name, image_id: imageId };
  });
}

function expectedEchoRetrieval(maxContextChars) {
  return {
    lexical_engine: 'minisearch',
    topk: 10,
    max_chunks_per_source: 6,
    bm25_candidates: 60,
    dense_candidates: 60,
    title_weight: 2,
    dense_weight: 1,
    min_dense_similarity: 0.3,
    max_context_chars: maxContextChars,
    mode: 'hybrid',
    minisearch_k: ECHO_ARM.minisearch_k,
    minisearch_b: ECHO_ARM.minisearch_b,
    minisearch_d: ECHO_ARM.minisearch_d,
    bm25_weight: ECHO_ARM.bm25_weight,
    rrf_k: ECHO_ARM.rrf_k,
  };
}

async function verifyEchoFixedReference({
  root,
  privateRoot,
  manifest,
  indexFreeze,
  publicRoot,
}) {
  const reference = path.resolve(root, '..', '2026-09-22-cap6-public-full-v2');
  const referenceFreezePath = path.join(reference, 'freeze.json');
  const referenceFreeze = await readJson(
    referenceFreezePath,
    'preserved Echo freeze missing',
  );
  assert.equal(referenceFreeze.status, 'frozen');
  const planPath = path.join(publicRoot, 'embedding-plan.json');
  const vectorPath = path.join(publicRoot, 'vectors.sqlite');
  const qasperDatabasePath = path.join(
    publicRoot,
    'qasper',
    'structure.sqlite',
  );
  const plan = await readJson(planPath, 'public embedding plan missing');
  assert.equal(plan.fingerprint, indexFreeze.model.fingerprint);
  assert.equal(plan.config?.dimensions, indexFreeze.model.dimensions);
  const planSha = await fileSha256(planPath);
  const vectorSha = await fileSha256(vectorPath);
  const queryCachePath = path.join(
    root,
    'echo-private-vector-bindings-20260924.json',
  );
  const queryCache = await readJson(
    queryCachePath,
    'private vector binding receipt missing',
  );
  assert.equal(queryCache.status, 'verified');
  for (const item of [queryCache.report, queryCache.plan]) {
    assert.ok(item?.path && /^[a-f0-9]{64}$/i.test(String(item.sha256 ?? '')));
    assert.ok(within(privateRoot, item.path));
    assert.equal(await fileSha256(item.path), item.sha256);
  }
  const qasperDatabaseSha = await fileSha256(qasperDatabasePath);
  assert.deepEqual(referenceFreeze.arms?.['public-A'], ECHO_ARM);
  assert.equal(referenceFreeze.fixed?.model, indexFreeze.model.name);
  assert.equal(referenceFreeze.fixed?.dimensions, indexFreeze.model.dimensions);
  assert.equal(referenceFreeze.fixed?.max_context_chars_utf16, 20000);
  assert.equal(
    referenceFreeze.fixed?.lexical_engine,
    'MiniSearch 7.2.0; query-term coverage multiplier disabled',
  );
  assert.equal(
    referenceFreeze.fixed?.tokenizer,
    'ICU zh-CN with existing expansion chain',
  );
  assert.equal(referenceFreeze.fixed?.rerank, false);
  assert.equal(referenceFreeze.fixed?.mmr, false);
  assert.equal(referenceFreeze.public?.vectors?.plan_sha256, planSha);
  assert.equal(referenceFreeze.public?.vectors?.cache_sha256, vectorSha);

  const fixedFiles = {};
  for (const scope of Object.keys(manifest.scopes).filter(
    (key) => manifest.scopes[key].kind === 'official-fixed-unit',
  )) {
    const info = manifest.scopes[scope];
    const cohort = referenceFreeze.public?.source_freeze?.cohorts?.[scope];
    assert.ok(cohort);
    for (const key of ['source_corpus', 'source_queries']) {
      assert.equal(await fileSha256(info[key].path), info[key].sha256);
    }
    assert.equal(cohort.corpus_file_sha256, info.source_corpus.sha256);
    assert.equal(cohort.query_file_sha256, info.source_queries.sha256);
    const queryIds = await writeJsonlIds(
      info.queries.path,
      'fixed query file is invalid',
    );
    const resultPath = path.join(
      reference,
      'public',
      scope + '-public-A-hybrid.jsonl',
    );
    const resultSha = await fileSha256(resultPath);
    const resultIds = await writeJsonlIds(
      resultPath,
      'preserved Echo fixed result is invalid',
    );
    const resultRows = (await fs.readFile(resultPath, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (const row of resultRows) {
      assert.equal(row.condition, 'public-A-hybrid');
      assert.equal(row.rrf_k, 10);
      assert.ok(Array.isArray(row.rankings) && row.rankings.length <= 120);
      for (const item of row.rankings) {
        assert.ok(String(item.id ?? ''));
        assert.ok(Number.isInteger(item.rank) && item.rank > 0);
        assert.ok(Number.isFinite(item.rrf_score));
      }
    }
    assert.deepEqual(resultIds, queryIds);
    fixedFiles[scope] = { sha256: resultSha };
  }
  return {
    fixedReference: reference,
    fixedReferenceFreeze: {
      path: referenceFreezePath,
      sha256: await fileSha256(referenceFreezePath),
    },
    fixedFiles,
    embeddingPlan: { path: planPath, sha256: planSha },
    vectorCache: { path: vectorPath, sha256: vectorSha },
    qasperDatabase: { path: qasperDatabasePath, sha256: qasperDatabaseSha },
    privateQueryCache: queryCache,
    privateQueryCacheBinding: {
      path: queryCachePath,
      sha256: await fileSha256(queryCachePath),
    },
  };
}

async function validateManifestAndFreezeInputs({ root, indexFreezePath }) {
  const manifestPath = path.join(root, 'corpus-v1', 'manifest.json');
  const manifest = await readJson(manifestPath, 'corpus manifest missing');
  const manifestSha = await fileSha256(manifestPath);
  const indexFreeze = await readJson(indexFreezePath, 'index-freeze missing');
  assert.equal(indexFreeze.status, 'index-inputs-frozen');
  assert.equal(indexFreeze.corpus_manifest_sha256, manifestSha);
  assert.equal(indexFreeze.model?.name, MODELS.name);
  assert.equal(indexFreeze.model?.dimensions, MODELS.dimensions);
  assert.match(String(indexFreeze.model?.fingerprint ?? ''), /^[a-f0-9]{64}$/i);
  assert.ok(indexFreeze.dify?.version && indexFreeze.dify?.commit);
  assert.ok(indexFreeze.khoj?.commit && indexFreeze.khoj?.markdown_parser);
  return { manifest, manifestSha, indexFreeze };
}

async function createPlan({
  root,
  privateRoot,
  publicRoot,
  validateReceipt = validateIndexReceipt,
}) {
  root = path.resolve(root);
  privateRoot = path.resolve(privateRoot);
  publicRoot = path.resolve(publicRoot);
  const blockers = [];
  let runtimeImages = [];
  try {
    runtimeImages = captureRuntimeImages();
  } catch {
    addBlocker(blockers, 'runtime-image-identity-unavailable');
  }
  const freezePath = path.join(root, 'freeze.json');
  const rootFreezeExists = await exists(freezePath);
  if (rootFreezeExists) addBlocker(blockers, 'freeze-already-exists');
  let manifest;
  let manifestSha;
  let indexFreeze;
  let indexFreezeSha;
  try {
    const indexFreezePath = path.join(root, 'index-freeze.json');
    ({ manifest, manifestSha, indexFreeze } =
      await validateManifestAndFreezeInputs({ root, indexFreezePath }));
    indexFreezeSha = await fileSha256(indexFreezePath);
  } catch {
    addBlocker(blockers, 'manifest-or-index-freeze-invalid');
  }
  if (!manifest || !indexFreeze) {
    return {
      root,
      freezePath,
      freeze: null,
      executionFiles: [],
      summary: {
        mode: 'dry-run',
        status: 'blocked',
        root_freeze_exists: rootFreezeExists,
        scope_count: 0,
        index_receipts: { expected: 18, valid: 0, pending: [], invalid: [] },
        blockers,
      },
    };
  }

  const scopeNames = Object.keys(manifest.scopes ?? {}).sort();
  if (scopeNames.length !== 9)
    addBlocker(blockers, 'expected-nine-manifest-scopes');
  const readiness = await inspectIndexReceipts({
    root,
    manifest,
    modelFingerprint: indexFreeze.model.fingerprint,
    validator: validateReceipt,
  });
  if (readiness.expected !== 18)
    addBlocker(blockers, 'expected-eighteen-scope-receipts');
  if (readiness.invalid.length)
    addBlocker(blockers, 'existing-v2-index-receipt-invalid');

  let echo;
  try {
    echo = await verifyEchoFixedReference({
      root,
      privateRoot,
      manifest,
      indexFreeze,
      publicRoot,
    });
  } catch {
    addBlocker(blockers, 'echo-fixed-reference-or-cache-binding-invalid');
  }

  let scoringInputs = {};
  try {
    scoringInputs = await scoringInputPaths(publicRoot, blockers);
  } catch {
    addBlocker(blockers, 'official-scoring-inputs-incomplete');
  }

  const scoringToolsRoot = path.join(publicRoot, 'scoring-tools');
  const scoringToolFiles = await collectTree(
    scoringToolsRoot,
    new Set(['.py', '.pyd', '.dll', '.so', '.json', '.txt']),
    blockers,
    'official-scoring-tools',
  );
  if (!scoringToolFiles.length)
    addBlocker(blockers, 'official-scoring-tools-empty');

  const repository = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const executionFiles = await executionPaths(
    root,
    privateRoot,
    repository,
    readiness.valid,
    blockers,
  );
  const codePinSha = digestText(JSON.stringify(executionFiles));
  const echoRetrieval = expectedEchoRetrieval(20000);
  const echoBindings = echo && {
    fixed_reference: echo.fixedReference,
    fixed_reference_freeze: echo.fixedReferenceFreeze,
    fixed_files: echo.fixedFiles,
    embedding_plan: echo.embeddingPlan,
    vector_cache: echo.vectorCache,
    qasper_database: echo.qasperDatabase,
    private_query_cache: echo.privateQueryCache,
    private_query_cache_binding: echo.privateQueryCacheBinding,
  };
  const difyCondition = { ...indexFreeze.dify, fixed_return_limit: 60 };
  const conditions = {
    echo: { retrieval: echoRetrieval, fixed_return_limit: 120 },
    dify: difyCondition,
    'khoj-dense': { rerank: false, dedupe: false, fixed_return_limit: 10 },
    'khoj-rerank': { rerank: true, dedupe: false, fixed_return_limit: 10 },
  };
  const scopeReceipts = [];
  for (const item of readiness.valid)
    scopeReceipts.push({
      product: item.product,
      scope: item.scope,
      status: 'validated',
      path: item.path,
      sha256: item.sha256,
    });
  for (const item of readiness.pending)
    scopeReceipts.push({
      product: item.product,
      scope: item.scope,
      status: 'pending',
    });
  const inputSnapshotSha = digestText(
    JSON.stringify({
      executionFiles,
      scoringInputs,
      echo,
      runtimeImages,
      conditions,
      indexFreezeSha,
    }),
  );
  const freeze = {
    version: 1,
    status: 'frozen',
    created_at: new Date().toISOString(),
    corpus_manifest_sha256: manifestSha,
    model: indexFreeze.model,
    runtime_images: runtimeImages,
    packing: { topk: 10, source_cap: 6, max_context_chars: 20000 },
    echo: echoBindings,
    dify: difyCondition,
    khoj: indexFreeze.khoj,
    conditions,
    index_freeze: {
      path: path.join(root, 'index-freeze.json'),
      sha256: indexFreezeSha,
    },
    index_execution_revision: {
      version: 1,
      status: readiness.pending.length
        ? 'index-inputs-preserved-scope-indexing-pending'
        : 'index-inputs-preserved-all-scopes-ready',
      prior_index_freeze_preserved: true,
      index_freeze_sha256: indexFreezeSha,
      corpus_manifest_sha256: manifestSha,
      model_fingerprint: indexFreeze.model.fingerprint,
      dify_index_condition: indexFreeze.dify,
      khoj_index_condition: indexFreeze.khoj,
      scope_receipts: scopeReceipts,
      query_execution_code_sha256: codePinSha,
      input_snapshot_sha256: inputSnapshotSha,
      change_boundary:
        'Query execution receipts and recovery gates only; the index-freeze model, corpus, chunking, and ranking inputs are preserved.',
    },
    execution_files: executionFiles,
    scoring_inputs: scoringInputs,
  };
  return {
    root,
    freezePath,
    freeze,
    executionFiles,
    summary: {
      mode: 'dry-run',
      status: blockers.length ? 'blocked' : 'ready',
      root_freeze_exists: rootFreezeExists,
      manifest_scopes: scopeNames.length,
      index_receipts: {
        expected: readiness.expected,
        valid: readiness.valid.length,
        pending: readiness.pending,
        invalid: readiness.invalid,
      },
      execution_file_count: executionFiles.length,
      code_pin_sha256: codePinSha,
      input_snapshot_sha256: inputSnapshotSha,
      runtime_image_count: runtimeImages.length,
      scoring_input_count: Object.keys(scoringInputs).length,
      blockers,
      freeze_write_allowed: blockers.length === 0,
    },
  };
}

export async function writeFreezeOnce(file, bytes) {
  let handle;
  try {
    handle = await fs.open(file, 'wx', 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function parseArgs(argv) {
  const options = { mode: 'dry-run' };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--dry-run') options.mode = 'dry-run';
    else if (item === '--freeze') options.mode = 'freeze';
    else if (item === '--root') options.root = argv[++index];
    else if (item === '--private-root') options.privateRoot = argv[++index];
    else if (item === '--public-root') options.publicRoot = argv[++index];
    else if (item === '--help' || item === '-h') options.help = true;
    else throw new Error('unknown argument');
  }
  if (!options.help) {
    for (const key of ['root', 'privateRoot', 'publicRoot'])
      assert.ok(
        typeof options[key] === 'string' &&
          options[key].trim() &&
          !options[key].startsWith('--'),
        'All three root paths must be supplied',
      );
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    console.error(
      'Usage: node freeze-product-comparison.mjs [--dry-run|--freeze] --root PATH --private-root PATH --public-root PATH',
    );
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(
      'Usage: node freeze-product-comparison.mjs [--dry-run|--freeze] --root PATH --private-root PATH --public-root PATH',
    );
    return;
  }
  let plan;
  try {
    plan = await createPlan({
      root: options.root,
      privateRoot: options.privateRoot,
      publicRoot: options.publicRoot,
    });
  } catch {
    console.log(
      JSON.stringify(
        {
          mode: options.mode,
          status: 'blocked',
          blockers: ['builder-preflight-failed'],
          freeze_written: false,
        },
        null,
        2,
      ),
    );
    if (options.mode === 'freeze') process.exitCode = 1;
    return;
  }
  plan.summary.mode = options.mode;
  if (options.mode === 'dry-run') {
    console.log(
      JSON.stringify({ ...plan.summary, freeze_written: false }, null, 2),
    );
    return;
  }
  if (plan.summary.blockers.length || !plan.freeze) {
    console.log(
      JSON.stringify({ ...plan.summary, freeze_written: false }, null, 2),
    );
    process.exitCode = 1;
    return;
  }
  try {
    const fresh = await createPlan({
      root: options.root,
      privateRoot: options.privateRoot,
      publicRoot: options.publicRoot,
    });
    if (
      fresh.summary.blockers.length ||
      fresh.summary.code_pin_sha256 !== plan.summary.code_pin_sha256 ||
      fresh.summary.input_snapshot_sha256 !== plan.summary.input_snapshot_sha256
    ) {
      console.log(
        JSON.stringify(
          {
            ...fresh.summary,
            mode: 'freeze',
            status: 'blocked',
            blockers: [
              ...fresh.summary.blockers,
              'inputs-changed-during-freeze',
            ],
            freeze_written: false,
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }
    const bytes = JSON.stringify(fresh.freeze, null, 2) + '\n';
    await writeFreezeOnce(fresh.freezePath, bytes);
    console.log(
      JSON.stringify(
        {
          ...fresh.summary,
          mode: 'freeze',
          status: 'frozen',
          freeze_written: true,
        },
        null,
        2,
      ),
    );
  } catch {
    console.log(
      JSON.stringify(
        {
          ...plan.summary,
          mode: 'freeze',
          status: 'blocked',
          blockers: [...plan.summary.blockers, 'freeze-write-rejected'],
          freeze_written: false,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
