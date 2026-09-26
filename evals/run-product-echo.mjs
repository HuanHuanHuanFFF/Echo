import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSha256, verifyExecutionFiles } from './lib/product-freeze.mjs';
import { openDatabase } from '../dist/database.js';
import { embeddingFingerprint } from '../dist/embedding.js';
import { loadFrozenPrivateVectors } from './lib/product-private-vectors.mjs';
import { jsonLines } from './prepare-product-comparison.mjs';
import {
  packProductEvidence,
  sourceLineSpans,
} from './lib/product-evidence.mjs';
import {
  arms,
  armOptions,
  makeContext,
  closeContext,
  queryCandidates,
  createPublicProvider,
  makeEmbeddingConfig,
  createPrivateProvider,
} from './run-minisearch-parameter-exploration.mjs';

const [privateRoot, publicRoot, batchRoot, scope] = process.argv.slice(2);
assert.ok(privateRoot && publicRoot && batchRoot && scope);
const freeze = JSON.parse(
  await fs.readFile(path.join(batchRoot, 'freeze.json'), 'utf8'),
);
assert.equal(freeze.status, 'frozen');
assert.deepEqual(
  freeze.conditions.echo.retrieval,
  armOptions(arms['public-A'], 'hybrid', freeze.packing.max_context_chars),
  'Frozen Echo parameters differ from actual candidate arm and packing',
);
assert.equal(freeze.conditions.echo.fixed_return_limit, 120);
assert.equal(freeze.packing.topk, freeze.conditions.echo.retrieval.topk);
assert.equal(
  freeze.packing.source_cap,
  freeze.conditions.echo.retrieval.max_chunks_per_source,
);
await verifyExecutionFiles(batchRoot, freeze.execution_files, [
  fileURLToPath(import.meta.url),
  ...[
    './lib/product-evidence.mjs',
    './lib/product-private-vectors.mjs',
    './lib/product-freeze.mjs',
    './run-minisearch-parameter-exploration.mjs',
    './prepare-product-comparison.mjs',
    './lib/public-runtime.mjs',
    '../dist/database.js',
    '../dist/retrieval.js',
    '../dist/minisearch.js',
    '../dist/embedding.js',
    '../dist/config.js',
    '../dist/lexical.js',
    '../package-lock.json',
  ].map((relative) => fileURLToPath(new URL(relative, import.meta.url))),
]);
const manifest = JSON.parse(
  await fs.readFile(path.join(batchRoot, 'corpus-v1/manifest.json'), 'utf8'),
);
const group = manifest.scopes[scope];
assert.ok(group);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function verifyBoundFile(receipt) {
  assert.ok(receipt?.path && receipt.sha256, 'Missing frozen input binding');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(receipt.path)) hash.update(bytes);
  assert.equal(
    hash.digest('hex'),
    receipt.sha256,
    'Frozen input changed: ' + receipt.path,
  );
}
assert.equal(
  digest(await fs.readFile(path.join(batchRoot, 'corpus-v1/manifest.json'))),
  freeze.corpus_manifest_sha256,
);
for (const file of [group.corpus, group.queries])
  assert.equal(digest(await fs.readFile(file.path)), file.sha256);
const out = path.join(batchRoot, 'runs/echo');
await fs.mkdir(out, { recursive: true });
const output = await fs.open(path.join(out, `${scope}.jsonl`), 'wx');
if (group.kind === 'official-fixed-unit') {
  const reference = freeze.echo.fixed_reference;
  await verifyBoundFile(freeze.echo.fixed_reference_freeze);
  assert.equal(
    path.resolve(freeze.echo.fixed_reference_freeze.path),
    path.resolve(reference, 'freeze.json'),
  );
  const referenceFreeze = JSON.parse(
    await fs.readFile(freeze.echo.fixed_reference_freeze.path, 'utf8'),
  );
  assert.equal(referenceFreeze.status, 'frozen');
  assert.deepEqual(referenceFreeze.arms['public-A'], arms['public-A']);
  const expectedRetrieval = freeze.conditions.echo.retrieval;
  for (const key of [
    'bm25_candidates',
    'dense_candidates',
    'title_weight',
    'min_dense_similarity',
    'topk',
    'max_chunks_per_source',
  ])
    assert.equal(referenceFreeze.fixed[key], expectedRetrieval[key]);
  assert.equal(
    referenceFreeze.fixed.max_context_chars_utf16,
    freeze.packing.max_context_chars,
  );
  assert.equal(referenceFreeze.fixed.model, freeze.model.name);
  assert.equal(referenceFreeze.fixed.dimensions, freeze.model.dimensions);
  assert.equal(
    referenceFreeze.fixed.lexical_engine,
    'MiniSearch 7.2.0; query-term coverage multiplier disabled',
  );
  assert.equal(
    referenceFreeze.fixed.tokenizer,
    'ICU zh-CN with existing expansion chain',
  );
  assert.equal(referenceFreeze.fixed.rerank, false);
  assert.equal(referenceFreeze.fixed.mmr, false);
  assert.equal(
    referenceFreeze.public.vectors.plan_sha256,
    freeze.echo.embedding_plan.sha256,
  );
  assert.equal(
    referenceFreeze.public.vectors.cache_sha256,
    freeze.echo.vector_cache.sha256,
  );
  const oldScope = referenceFreeze.public.source_freeze.cohorts[scope];
  assert.equal(oldScope.query_file_sha256, group.source_queries.sha256);
  assert.equal(oldScope.corpus_file_sha256, group.source_corpus.sha256);
  const input = path.join(
    reference,
    'public',
    `${scope}-public-A-hybrid.jsonl`,
  );
  const receipt = freeze.echo.fixed_files[scope];
  assert.equal(digest(await fs.readFile(input)), receipt.sha256);
  let count = 0;
  for await (const row of jsonLines(input)) {
    assert.equal(row.condition, 'public-A-hybrid');
    assert.equal(row.rrf_k, 10);
    await output.write(
      JSON.stringify({
        id: String(row.id),
        rankings: row.rankings.map((item) => ({
          id: String(item.id),
          rank: item.rank,
          score: item.rrf_score,
        })),
        provenance: { reused: true, path: input, sha256: receipt.sha256 },
      }) + '\n',
    );
    count++;
  }
  assert.equal(count, group.questions);
  await output.close();
  console.log(
    JSON.stringify({
      scope,
      status: 'complete',
      questions: count,
      reused: true,
    }),
  );
} else {
  const documents = new Map();
  for await (const row of jsonLines(group.corpus.path))
    documents.set(row.id, row);
  const queries = [];
  for await (const row of jsonLines(group.queries.path)) queries.push(row);
  await verifyBoundFile(freeze.echo.embedding_plan);
  await verifyBoundFile(freeze.echo.vector_cache);
  await verifyBoundFile(
    scope === 'qasper' ? freeze.echo.qasper_database : group.source_database,
  );
  const plan = JSON.parse(
    await fs.readFile(path.join(publicRoot, 'embedding-plan.json'), 'utf8'),
  );
  const embedding = makeEmbeddingConfig(plan.config);
  const fingerprint = embeddingFingerprint(embedding);
  assert.equal(fingerprint, freeze.model.fingerprint);
  const vectorDb = openDatabase(path.join(publicRoot, 'vectors.sqlite'), {
    readOnly: true,
  });
  let provider;
  if (scope === 'qasper') {
    provider = createPublicProvider(vectorDb, fingerprint);
  } else {
    const cache = await loadFrozenPrivateVectors(
      freeze.echo.private_query_cache,
      {
        model: embedding.model,
        dimensions: 1024,
        endpoint: embedding.base_url + '/embeddings',
      },
    );
    for (const question of queries)
      for (const query of question.queries)
        assert.ok(
          cache.has(query.text),
          'Frozen private query lacks exact model-input evidence',
        );
    const base = createPrivateProvider(cache, fingerprint);
    provider = {
      ...base,
      async embed(texts) {
        for (const text of texts)
          assert.ok(cache.has(text), 'Exact model input is not frozen');
        return base.embed(texts);
      },
    };
  }
  const dbPath =
    scope === 'qasper'
      ? path.join(publicRoot, 'qasper/structure.sqlite')
      : group.source_database.path;
  const context = await makeContext({ dbPath, provider, embedding });
  try {
    let count = 0;
    for (const question of queries) {
      const start = performance.now();
      const rankedQueries = [];
      for (const query of question.queries) {
        assert.equal(
          query.text,
          query.text.trim(),
          'Frozen full-document query must equal executed text',
        );
        const result = await queryCandidates(
          context,
          query.id,
          query.text,
          question.source_id ? { source_ids: [question.source_id] } : {},
          arms['public-A'],
          'hybrid',
        );
        const normalized = result.candidates.map((candidate) => {
          const evidence = candidate.evidence;
          const source = documents.get(evidence.source_id);
          assert.ok(source);
          assert.equal(evidence.source_version, source.source_sha256);
          assert.equal(
            source.text
              .split('\n')
              .slice(
                evidence.start_line - source.original_first_line,
                evidence.end_line - source.original_first_line + 1,
              )
              .join('\n'),
            evidence.text,
            'Echo candidate text differs from source lines',
          );
          return {
            id: digest(JSON.stringify([source.id, evidence.text])).slice(0, 32),
            native_id: evidence.chunk_id,
            source_location: {
              start_line: evidence.start_line,
              end_line: evidence.end_line,
            },
            source_id: source.id,
            path: source.relative_path,
            text: evidence.text,
            source_spans: sourceLineSpans(
              source,
              evidence.start_line,
              evidence.end_line,
            ),
            score: candidate.score,
          };
        });
        rankedQueries.push({
          query_id: query.id,
          query_sha256: digest(query.text),
          results: normalized,
          native_counts: result.counts,
        });
      }
      const packed = packProductEvidence(
        question,
        rankedQueries,
        freeze.packing,
      );
      await output.write(
        JSON.stringify({
          id: question.id,
          scope,
          ranked_queries: rankedQueries,
          ...packed,
          elapsed_ms: performance.now() - start,
        }) + '\n',
      );
      count++;
      if (count % 100 === 0)
        console.log(
          JSON.stringify({
            scope,
            processed: count,
            questions: group.questions,
          }),
        );
    }
    assert.equal(count, group.questions);
    console.log(
      JSON.stringify({
        scope,
        status: 'complete',
        questions: count,
        reused: false,
      }),
    );
  } finally {
    await output.close();
    closeContext(context);
    vectorDb.close();
  }
}

const runReceipt = {
  status: 'complete',
  condition: 'echo',
  scope,
  questions: group.questions,
  completed_at: new Date().toISOString(),
  freeze_sha256: await fileSha256(path.join(batchRoot, 'freeze.json')),
  result: {
    path: path.join(out, scope + '.jsonl'),
    sha256: await fileSha256(path.join(out, scope + '.jsonl')),
  },
};
await fs.writeFile(
  path.join(out, scope + '-receipt.json'),
  JSON.stringify(runReceipt, null, 2) + '\n',
  { flag: 'wx' },
);
