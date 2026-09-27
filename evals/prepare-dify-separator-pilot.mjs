import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [sourceArg, targetArg, mode] = process.argv.slice(2);
assert.ok(
  sourceArg && targetArg && ['preview', 'pilot'].includes(mode),
  'Usage: node evals/prepare-dify-separator-pilot.mjs SOURCE_ROOT NEW_SIBLING_ROOT preview|pilot',
);
const sourceRoot = path.resolve(sourceArg);
const targetRoot = path.resolve(targetArg);
assert.equal(path.dirname(sourceRoot), path.dirname(targetRoot));
assert.match(
  path.basename(targetRoot),
  /^2026-09-25-dify-sep3-(preview|pilot)-v[23]$/,
);
assert.equal(path.basename(targetRoot).includes(`-${mode}-`), true);
await fs.access(path.join(sourceRoot, 'freeze.json'));
await fs.mkdir(targetRoot);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const sourceManifestFile = path.join(sourceRoot, 'corpus-v1/manifest.json');
const sourceIndexFreezeFile = path.join(sourceRoot, 'index-freeze.json');
const sourceFreezeFile = path.join(sourceRoot, 'freeze.json');
const sourceManifest = await read(sourceManifestFile);
const sourceIndexFreeze = await read(sourceIndexFreezeFile);
const sourceFreeze = await read(sourceFreezeFile);
assert.equal(sourceIndexFreeze.status, 'index-inputs-frozen');
assert.equal(sourceFreeze.status, 'frozen');
assert.equal(
  sourceIndexFreeze.dify.process_rule.rules.segmentation.separator,
  '\n\n',
);
assert.equal(
  sourceFreeze.conditions.dify.process_rule.rules.segmentation.separator,
  '\n\n',
);

await fs.mkdir(path.join(targetRoot, 'corpus-v1'));
await fs.mkdir(path.join(targetRoot, 'dify-runtime'));
const scopes = {};
const copied = [];
for (const scope of ['A-test', 'C-test']) {
  const original = sourceManifest.scopes[scope];
  assert.equal(original.kind, 'full-document');
  const revision = path.basename(targetRoot).endsWith('-v3') ? 'b' : '';
  const alias = `${scope[0]}-s3${mode === 'preview' ? 'p' : revision}-0925`;
  const corpusName = `${alias}-documents.jsonl`;
  const corpusFile = path.join(targetRoot, 'corpus-v1', corpusName);
  const sourceCorpus = await fs.readFile(original.corpus.path);
  assert.equal(sha(sourceCorpus), original.corpus.sha256);
  let corpus = sourceCorpus;
  if (mode === 'preview') {
    const rows = sourceCorpus
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map(JSON.parse);
    assert.equal(rows.length, original.documents);
    rows.sort(
      (left, right) =>
        (left.text.match(/\n\n/g)?.length ?? 0) -
        (right.text.match(/\n\n/g)?.length ?? 0),
    );
    corpus = Buffer.from(
      JSON.stringify(rows[Math.floor(rows.length / 2)]) + '\n',
    );
  }
  await fs.writeFile(corpusFile, corpus, { flag: 'wx' });
  const info = {
    kind: original.kind,
    documents: mode === 'preview' ? 1 : original.documents,
    corpus: { path: corpusFile, bytes: corpus.length, sha256: sha(corpus) },
  };
  if (mode === 'pilot') {
    for (const field of ['queries', 'labels']) {
      const bytes = await fs.readFile(original[field].path);
      assert.equal(sha(bytes), original[field].sha256);
      const file = path.join(
        targetRoot,
        'corpus-v1',
        `${alias}-${field}${field === 'queries' ? '.jsonl' : '.json'}`,
      );
      await fs.writeFile(file, bytes, { flag: 'wx' });
      info[field] = { path: file, bytes: bytes.length, sha256: sha(bytes) };
    }
    for (const field of ['questions', 'query_inputs', 'answerable', 'facts']) {
      info[field] = original[field];
    }
  }
  scopes[alias] = info;
  copied.push({
    scope: alias,
    documents: info.documents,
    questions: info.questions ?? 0,
  });
}

const manifestFile = path.join(targetRoot, 'corpus-v1/manifest.json');
await fs.writeFile(
  manifestFile,
  JSON.stringify(
    {
      version: 1,
      status: 'isolated-single-variable-pilot',
      source_manifest_sha256: sha(await fs.readFile(sourceManifestFile)),
      scopes,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
const manifestSha = sha(await fs.readFile(manifestFile));
const dify = structuredClone(sourceIndexFreeze.dify);
dify.process_rule.rules.segmentation.separator = '\n\n\n';
const indexFreezeFile = path.join(targetRoot, 'index-freeze.json');
await fs.writeFile(
  indexFreezeFile,
  JSON.stringify(
    {
      version: 1,
      status: 'index-inputs-frozen',
      created_at: new Date().toISOString(),
      corpus_manifest_sha256: manifestSha,
      source_index_freeze_sha256: sha(await fs.readFile(sourceIndexFreezeFile)),
      model: sourceIndexFreeze.model,
      dify,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
const sessionSource = path.join(
  sourceRoot,
  'dify-runtime/private-session.json',
);
const sessionTarget = path.join(
  targetRoot,
  'dify-runtime/private-session.json',
);
await fs.copyFile(sessionSource, sessionTarget, fs.constants.COPYFILE_EXCL);
if (mode === 'pilot') {
  const executionPaths = [
    manifestFile,
    indexFreezeFile,
    path.join(repoRoot, 'evals/product-dify-query.mjs'),
    path.join(repoRoot, 'evals/lib/dify-auth.mjs'),
    path.join(repoRoot, 'evals/lib/product-evidence.mjs'),
    path.join(repoRoot, 'evals/lib/product-freeze.mjs'),
  ];
  const executionFiles = await Promise.all(
    executionPaths.map(async (file) => ({
      path: file,
      sha256: sha(await fs.readFile(file)),
    })),
  );
  const freeze = {
    version: 1,
    status: 'frozen',
    created_at: new Date().toISOString(),
    corpus_manifest_sha256: manifestSha,
    source_freeze_sha256: sha(await fs.readFile(sourceFreezeFile)),
    model: sourceFreeze.model,
    runtime_images: sourceFreeze.runtime_images,
    packing: sourceFreeze.packing,
    conditions: {
      dify: {
        ...structuredClone(sourceFreeze.conditions.dify),
        process_rule: dify.process_rule,
      },
    },
    execution_files: executionFiles,
  };
  await fs.writeFile(
    path.join(targetRoot, 'freeze.json'),
    JSON.stringify(freeze, null, 2) + '\n',
    { flag: 'wx' },
  );
}
console.log(
  JSON.stringify({
    mode,
    targetRoot,
    manifest_sha256: manifestSha,
    scopes: copied,
  }),
);
