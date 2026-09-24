import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

const { requiredAuditors } = await import(
  pathToFileURL(path.resolve('evals/lib/product-index-receipt.mjs')).href
);
const { requiredProductRunExecutionFiles } = await import(
  pathToFileURL(path.resolve('evals/lib/product-run-integrity.mjs')).href
);
const { verifyProductRuns } = await import(
  pathToFileURL(path.resolve('evals/lib/product-run-integrity.mjs')).href
);

const roots: string[] = [];

const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const jsonl = (rows: unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify(value, null, 2) + '\n';
  await fs.writeFile(file, bytes);
  return bytes;
}

async function writeRows(file: string, rows: unknown[]) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = jsonl(rows);
  await fs.writeFile(file, bytes);
  return bytes;
}

async function makeBatch(
  scope: string,
  kind: string,
  corpusRows: unknown[],
  questions: unknown[],
  sourceFiles: { source_corpus?: unknown[]; source_queries?: unknown[] } = {},
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'product-run-integrity-'),
  );
  roots.push(root);
  const corpusPath = path.join(root, 'corpus-v1', `${scope}-corpus.jsonl`);
  const queriesPath = path.join(root, 'corpus-v1', `${scope}-queries.jsonl`);
  const corpusBytes = await writeRows(corpusPath, corpusRows);
  const queryBytes = await writeRows(queriesPath, questions);
  const info: Record<string, any> = {
    kind,
    questions: questions.length,
    documents: corpusRows.length,
    corpus: { path: corpusPath, sha256: sha(corpusBytes) },
    queries: { path: queriesPath, sha256: sha(queryBytes) },
  };
  for (const key of ['source_corpus', 'source_queries'] as const) {
    const rows = sourceFiles[key];
    if (!rows) continue;
    const file = path.join(root, 'corpus-v1', `${scope}-${key}.jsonl`);
    const bytes = await writeRows(file, rows);
    info[key] = { path: file, sha256: sha(bytes) };
  }
  const manifest = { scopes: { [scope]: info } };
  const manifestBytes = await writeJson(
    path.join(root, 'corpus-v1', 'manifest.json'),
    manifest,
  );
  return {
    root,
    scope,
    info,
    questions,
    async writeFreeze(extra: Record<string, unknown> = {}, condition = 'echo') {
      const execution_files = await Promise.all(
        requiredProductRunExecutionFiles(condition).map(
          async (file: string) => ({
            path: file,
            sha256: sha(await fs.readFile(file)),
          }),
        ),
      );
      return writeJson(path.join(root, 'freeze.json'), {
        status: 'frozen',
        corpus_manifest_sha256: sha(manifestBytes),
        execution_files,
        ...extra,
      });
    },
  };
}

async function writeEchoReceipt(
  root: string,
  scope: string,
  freezeBytes: string,
  rows: unknown[],
) {
  const output = path.join(root, 'runs', 'echo', `${scope}.jsonl`);
  const outputBytes = await writeRows(output, rows);
  await writeJson(path.join(root, 'runs', 'echo', `${scope}-receipt.json`), {
    status: 'complete',
    condition: 'echo',
    scope,
    questions: rows.length,
    freeze_sha256: sha(freezeBytes),
    result: { path: output, sha256: sha(outputBytes) },
  });
}

async function createKhojV2IndexReceipt(
  root: string,
  scope: string,
  info: Record<string, any>,
  modelFingerprint: string,
  fixed = false,
  artifacts: string[] = [],
) {
  const directory = path.join(root, 'indexes', 'khoj', scope);
  const kind = fixed ? 'fixed' : 'native';
  const indexFile = path.join(directory, `index-${kind}-scope-receipt.json`);
  const indexBytes = await writeJson(indexFile, {
    status: 'indexed',
    scope,
    kind,
    inputs: { corpus_sha256: info.corpus.sha256 },
  });
  const auditKind = fixed ? 'fixed-evidence' : 'native-evidence';
  const auditFile = path.join(directory, `${kind}-evidence-audit.json`);
  const auditBytes = await writeJson(auditFile, {
    status: 'verified',
    scope,
    corpus_sha256: info.corpus.sha256,
    model_fingerprint: modelFingerprint,
    documents: info.documents,
    entries: info.documents,
    cache_vectors_matched: info.documents,
    mapping_gaps: [],
    vector_gaps: [],
    missing_source_ids: [],
  });
  const files = [
    { path: indexFile, sha256: sha(indexBytes) },
    { path: auditFile, sha256: sha(auditBytes) },
    ...(await Promise.all(
      artifacts.map(async (file) => ({
        path: file,
        sha256: sha(await fs.readFile(file)),
      })),
    )),
    ...(await Promise.all(
      requiredAuditors('khoj', fixed).map(async (file: string) => ({
        path: file,
        sha256: sha(await fs.readFile(file)),
      })),
    )),
  ];
  const receipt = {
    version: 2,
    status: 'frozen',
    product: 'khoj',
    scope,
    corpus_sha256: info.corpus.sha256,
    model_fingerprint: modelFingerprint,
    audits: [{ kind: auditKind, path: auditFile, sha256: sha(auditBytes) }],
    execution_files: files,
  };
  const receiptPath = path.join(directory, 'query-index-receipt.json');
  const receiptBytes = await writeJson(receiptPath, receipt);
  return { receiptPath, receiptSha: sha(receiptBytes) };
}

async function createDifyV2IndexReceipt(
  root: string,
  scope: string,
  info: Record<string, any>,
  modelFingerprint: string,
) {
  const directory = path.join(root, 'indexes', 'dify', scope);
  const stateFile = path.join(directory, 'state.json');
  const stateBytes = await writeJson(stateFile, {
    dataset_id: 'dataset-fixture',
  });
  const segmentMapFile = path.join(directory, 'segment-map.jsonl');
  const segmentMapBytes = await writeRows(segmentMapFile, [
    {
      segment_id: 'segment1',
      unit_id: 'unit1',
      text_sha256: sha('Official unit.'),
    },
  ]);
  const mappingAuditFile = path.join(directory, 'fixed-segments-audit.json');
  const mappingAuditBytes = await writeJson(mappingAuditFile, {
    status: 'verified',
    scope,
    corpus_sha256: info.corpus.sha256,
    dataset_id: 'dataset-fixture',
    documents: info.documents,
    exact_texts: info.documents,
    mapping_gaps: [],
  });
  const vectorsAuditFile = path.join(directory, 'model-vectors-audit.json');
  const vectorsAuditBytes = await writeJson(vectorsAuditFile, {
    status: 'verified',
    dataset_id: 'dataset-fixture',
    dimensions: 1024,
    model_cache_fingerprint: modelFingerprint,
    expected_vectors: info.documents,
    actual_vectors: info.documents,
    matched_model_vectors: info.documents,
    source_segment_contract_matched: info.documents,
    missing: [],
    problems: [],
  });
  const files = [
    { path: stateFile, sha256: sha(stateBytes) },
    { path: segmentMapFile, sha256: sha(segmentMapBytes) },
    { path: mappingAuditFile, sha256: sha(mappingAuditBytes) },
    { path: vectorsAuditFile, sha256: sha(vectorsAuditBytes) },
    ...(await Promise.all(
      requiredAuditors('dify', true).map(async (file: string) => ({
        path: file,
        sha256: sha(await fs.readFile(file)),
      })),
    )),
  ];
  const receipt = {
    version: 2,
    status: 'frozen',
    product: 'dify',
    scope,
    corpus_sha256: info.corpus.sha256,
    model_fingerprint: modelFingerprint,
    audits: [
      {
        kind: 'fixed-segments',
        path: mappingAuditFile,
        sha256: sha(mappingAuditBytes),
      },
      {
        kind: 'model-vectors',
        path: vectorsAuditFile,
        sha256: sha(vectorsAuditBytes),
      },
    ],
    execution_files: files,
  };
  const receiptPath = path.join(directory, 'query-index-receipt.json');
  const receiptBytes = await writeJson(receiptPath, receipt);
  return {
    receiptPath,
    receiptSha: sha(receiptBytes),
    stateFile,
    stateSha: sha(stateBytes),
    segmentMapFile,
    segmentMapSha: sha(segmentMapBytes),
  };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('product run integrity gate', () => {
  it('rejects an Echo run receipt pinned to another global freeze', async () => {
    const questions = [
      { id: 'q1', queries: [{ id: 's1', text: 'find the alpha note' }] },
    ];
    const corpusRows = [
      {
        id: 'doc1',
        source_id: 'doc1',
        relative_path: 'notes/a.md',
        text: 'Alpha note.\n',
        original_first_line: 1,
      },
    ];
    const batch = await makeBatch(
      'personal',
      'markdown',
      corpusRows,
      questions,
    );
    const freezeBytes = await batch.writeFreeze();
    const candidateText = 'Alpha note.';
    await writeEchoReceipt(batch.root, batch.scope, freezeBytes, [
      {
        id: 'q1',
        scope: 'personal',
        ranked_queries: [
          {
            query_id: 's1',
            query_sha256: sha('find the alpha note'),
            results: [
              {
                id: sha(JSON.stringify(['doc1', candidateText])).slice(0, 32),
                native_id: 'chunk1',
                source_location: { start_line: 1, end_line: 1 },
                source_id: 'doc1',
                path: 'notes/a.md',
                text: candidateText,
                score: 0.8,
              },
            ],
          },
        ],
      },
    ]);
    const receiptFile = path.join(
      batch.root,
      'runs',
      'echo',
      'personal-receipt.json',
    );
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    receipt.freeze_sha256 = 'f'.repeat(64);
    await writeJson(receiptFile, receipt);

    await expect(
      verifyProductRuns({
        root: batch.root,
        condition: 'echo',
        scopes: ['personal'],
      }),
    ).rejects.toThrow('belongs to a different freeze');
  });

  it('rejects a changed Echo fixed-unit ranking against its frozen old source', async () => {
    const scope = 'langchain';
    const questions = [
      { id: 'q1', queries: [{ id: 's1', text: 'find unit one' }] },
    ];
    const corpusRows = [
      {
        id: 'unit1',
        source_id: 'unit1',
        relative_path: 'unit1',
        text: 'Unit one.',
      },
    ];
    const batch = await makeBatch(
      scope,
      'official-fixed-unit',
      corpusRows,
      questions,
      {
        source_corpus: corpusRows,
        source_queries: questions,
      },
    );
    const reference = path.join(batch.root, 'preserved');
    const oldResults = path.join(
      reference,
      'public',
      `${scope}-public-A-hybrid.jsonl`,
    );
    const oldBytes = await writeRows(oldResults, [
      {
        id: 'q1',
        condition: 'public-A-hybrid',
        rrf_k: 10,
        rankings: [{ id: 'unit1', rank: 1, rrf_score: 0.6 }],
      },
    ]);
    const modelName = 'test-embedding-model';
    const retrieval = {
      lexical_engine: 'minisearch',
      bm25_candidates: 60,
      dense_candidates: 60,
      title_weight: 2,
      min_dense_similarity: 0.3,
      topk: 10,
      max_chunks_per_source: 6,
      max_context_chars: 20000,
      mode: 'hybrid',
      minisearch_k: 1.2,
      minisearch_b: 0.7,
      minisearch_d: 0.5,
      bm25_weight: 0.5,
      dense_weight: 1,
      rrf_k: 10,
    };
    const planContent = 'plan';
    const cacheContent = 'cache';
    await fs.writeFile(path.join(batch.root, 'plan.json'), planContent);
    await fs.writeFile(path.join(batch.root, 'cache.sqlite'), cacheContent);
    const planSha = sha(planContent);
    const cacheSha = sha(cacheContent);
    const referenceFreeze = {
      status: 'frozen',
      arms: {
        'public-A': {
          id: 'public-A',
          minisearch_k: 1.2,
          minisearch_b: 0.7,
          minisearch_d: 0.5,
          bm25_weight: 0.5,
          dense_weight: 1,
          rrf_k: 10,
          retrieval: { max_chunks_per_source: 6, max_context_chars: 20000 },
          reason: 'public A fixture',
        },
      },
      fixed: {
        bm25_candidates: 60,
        dense_candidates: 60,
        title_weight: 2,
        min_dense_similarity: 0.3,
        topk: 10,
        max_chunks_per_source: 6,
        max_context_chars_utf16: 20000,
        model: modelName,
        dimensions: 1024,
        lexical_engine:
          'MiniSearch 7.2.0; query-term coverage multiplier disabled',
        tokenizer: 'ICU zh-CN with existing expansion chain',
        rerank: false,
        mmr: false,
      },
      public: {
        vectors: { plan_sha256: planSha, cache_sha256: cacheSha },
        source_freeze: {
          cohorts: {
            [scope]: {
              corpus_file_sha256: batch.info.source_corpus.sha256,
              query_file_sha256: batch.info.source_queries.sha256,
            },
          },
        },
      },
    };
    const referenceFreezePath = path.join(reference, 'freeze.json');
    const referenceFreezeBytes = await writeJson(
      referenceFreezePath,
      referenceFreeze,
    );
    const freezeBytes = await batch.writeFreeze({
      model: { name: modelName, dimensions: 1024, fingerprint: 'model-fp' },
      packing: { topk: 10, source_cap: 6, max_context_chars: 20000 },
      conditions: { echo: { retrieval, fixed_return_limit: 120 } },
      echo: {
        fixed_reference: reference,
        fixed_reference_freeze: {
          path: referenceFreezePath,
          sha256: sha(referenceFreezeBytes),
        },
        fixed_files: { [scope]: { sha256: sha(oldBytes) } },
        embedding_plan: {
          path: path.join(batch.root, 'plan.json'),
          sha256: planSha,
        },
        vector_cache: {
          path: path.join(batch.root, 'cache.sqlite'),
          sha256: cacheSha,
        },
      },
    });
    await writeEchoReceipt(batch.root, scope, freezeBytes, [
      {
        id: 'q1',
        rankings: [{ id: 'unit1', rank: 1, score: 0.5 }],
        provenance: { reused: true, path: oldResults, sha256: sha(oldBytes) },
      },
    ]);

    await expect(
      verifyProductRuns({
        root: batch.root,
        condition: 'echo',
        scopes: [scope],
      }),
    ).rejects.toThrow('score differs from preserved source');
  });

  it('rejects a Khoj normalized score that differs from its bound native response', async () => {
    const scope = 'native-scope';
    const condition = 'khoj-dense';
    const questions = [
      { id: 'q1', queries: [{ query_id: 's1', text: 'find alpha' }] },
    ];
    const corpusRows = [
      {
        id: 'doc1',
        source_id: 'doc1',
        relative_path: 'docs/a.md',
        text: 'Alpha evidence.\n',
      },
    ];
    const batch = await makeBatch(scope, 'markdown', corpusRows, questions);
    const modelFingerprint = 'model-fingerprint';
    const freezeBytes = await batch.writeFreeze(
      {
        model: { fingerprint: modelFingerprint },
        conditions: {
          [condition]: { rerank: false, dedupe: false, fixed_return_limit: 10 },
        },
      },
      condition,
    );
    const index = await createKhojV2IndexReceipt(
      batch.root,
      scope,
      batch.info,
      modelFingerprint,
    );
    const text = 'Alpha evidence.\n';
    const raw = [
      {
        'corpus-id': 'native-doc1',
        score: 0.8,
        additional: { file: 'docs/a.md', compiled: text },
      },
    ];
    const output = path.join(batch.root, 'runs', condition, `${scope}.jsonl`);
    const outputBytes = await writeRows(output, [
      {
        id: 'q1',
        scope,
        condition: {
          name: condition,
          rerank: false,
          dedupe: false,
          return_limit: 10,
        },
        native_http_return_limit: 10,
        ranked_queries: [
          {
            query_id: 's1',
            query: 'find alpha',
            native_query: 'find alpha',
            native_request: {
              method: 'GET',
              path: '/api/search',
              params: {
                q: 'find alpha',
                n: '10',
                t: 'markdown',
                r: 'false',
                dedupe: 'false',
              },
            },
            filter: null,
            filter_applied_before_top10: false,
            dedupe: false,
            native_return_limit: 10,
            native_response: raw,
            native_response_sha256: sha(JSON.stringify(raw)),
            results: [
              {
                id: sha(JSON.stringify(['doc1', text])).slice(0, 32),
                native_id: 'native-doc1',
                native_metadata: {
                  entry: null,
                  heading: null,
                  file: 'docs/a.md',
                },
                source_id: 'doc1',
                path: 'docs/a.md',
                text,
                score: 0.7,
                cross_score: null,
                cross_score_present: false,
              },
            ],
          },
        ],
      },
    ]);
    await writeJson(
      path.join(batch.root, 'runs', condition, `${scope}-receipt.json`),
      {
        status: 'complete',
        condition,
        scope,
        questions: 1,
        freeze_sha256: sha(freezeBytes),
        index_receipt: { path: index.receiptPath, sha256: index.receiptSha },
        result: { path: output, sha256: sha(outputBytes) },
      },
    );

    await expect(
      verifyProductRuns({ root: batch.root, condition, scopes: [scope] }),
    ).rejects.toThrow('normalized score differs from response');
  });

  it('rejects a fixed-unit public ranking that diverges from verified native results', async () => {
    const scope = 'fixed-scope';
    const condition = 'khoj-dense';
    const unitText = 'Official unit.';
    const questions = [
      { id: 'q1', queries: [{ query_id: 's1', text: 'find unit' }] },
    ];
    const corpusRows = [
      {
        id: 'unit1',
        source_id: 'unit1',
        relative_path: 'unit-1',
        text: unitText,
      },
    ];
    const batch = await makeBatch(
      scope,
      'official-fixed-unit',
      corpusRows,
      questions,
    );
    const modelFingerprint = 'fixed-model-fingerprint';
    const freezeBytes = await batch.writeFreeze(
      {
        model: { fingerprint: modelFingerprint },
        conditions: {
          [condition]: { rerank: false, dedupe: false, fixed_return_limit: 10 },
        },
      },
      condition,
    );
    const fixedInput = path.join(
      batch.root,
      'khoj-runtime',
      'input',
      `fixed-${scope}.jsonl`,
    );
    await writeRows(fixedInput, [
      {
        unit_id: 'unit1',
        source_id: 'unit1',
        corpus_id: 'native-unit1',
        file: 'unit-1',
        compiled: unitText,
      },
    ]);
    const index = await createKhojV2IndexReceipt(
      batch.root,
      scope,
      batch.info,
      modelFingerprint,
      true,
      [fixedInput],
    );
    const raw = [
      {
        'corpus-id': 'native-unit1',
        score: 0.8,
        additional: { file: 'unit-1', compiled: unitText },
      },
    ];
    const output = path.join(batch.root, 'runs', condition, `${scope}.jsonl`);
    const outputBytes = await writeRows(output, [
      {
        id: 'q1',
        scope,
        condition: {
          name: condition,
          rerank: false,
          dedupe: false,
          return_limit: 10,
        },
        native_http_return_limit: 10,
        ranked_queries: [
          {
            query_id: 's1',
            query: 'find unit',
            native_query: 'find unit',
            native_request: {
              method: 'GET',
              path: '/api/search',
              params: {
                q: 'find unit',
                n: '10',
                t: 'plaintext',
                r: 'false',
                dedupe: 'false',
              },
            },
            filter: null,
            filter_applied_before_top10: false,
            dedupe: false,
            native_return_limit: 10,
            native_response: raw,
            native_response_sha256: sha(JSON.stringify(raw)),
            results: [
              {
                id: 'unit1',
                native_id: 'native-unit1',
                native_metadata: {
                  entry: null,
                  heading: null,
                  file: 'unit-1',
                },
                text: unitText,
                score: 0.8,
                cross_score: null,
                cross_score_present: false,
              },
            ],
          },
        ],
        rankings: [{ id: 'unit1', rank: 1, score: 0.7 }],
      },
    ]);
    await writeJson(
      path.join(batch.root, 'runs', condition, `${scope}-receipt.json`),
      {
        status: 'complete',
        condition,
        scope,
        questions: 1,
        freeze_sha256: sha(freezeBytes),
        index_receipt: { path: index.receiptPath, sha256: index.receiptSha },
        result: { path: output, sha256: sha(outputBytes) },
      },
    );

    await expect(
      verifyProductRuns({ root: batch.root, condition, scopes: [scope] }),
    ).rejects.toThrow(
      'Fixed public ranking score differs from verified native results',
    );
  });

  it('rejects a Dify fixed ranking that diverges from its native segment response', async () => {
    const scope = 'dify-fixed';
    const condition = 'dify';
    const unitText = 'Official unit.';
    const questions = [
      { id: 'q1', queries: [{ id: 's1', text: 'find unit' }] },
    ];
    const corpusRows = [{ id: 'unit1', text: unitText }];
    const batch = await makeBatch(
      scope,
      'official-fixed-unit',
      corpusRows,
      questions,
    );
    const modelFingerprint = 'dify-model-fingerprint';
    const freezeBytes = await batch.writeFreeze(
      {
        model: { fingerprint: modelFingerprint },
        conditions: {
          [condition]: { rerank: false, dedupe: false, fixed_return_limit: 10 },
        },
      },
      condition,
    );
    const index = await createDifyV2IndexReceipt(
      batch.root,
      scope,
      batch.info,
      modelFingerprint,
    );
    const nativeBody = {
      data: {
        status: 'succeeded',
        outputs: {
          result: [
            {
              content: unitText,
              metadata: { segment_id: 'segment1', score: 0.8 },
            },
          ],
        },
      },
    };
    const nativeFile = path.join(
      batch.root,
      'runs',
      condition,
      'native',
      'q1-s1.json',
    );
    const nativeBytes = await writeJson(nativeFile, {
      run_fingerprint: 'dify-run-fingerprint',
      question_id: 'q1',
      query_id: 's1',
      ok: true,
      raw_http: {
        response_status: 200,
        request_body: { inputs: { query: 'find unit' } },
        response_body_raw: JSON.stringify(nativeBody),
      },
    });
    const snapshots = [
      path.join(
        batch.root,
        'runs',
        condition,
        'query-state',
        scope + '.native-dataset.json',
      ),
      path.join(
        batch.root,
        'runs',
        condition,
        'query-state',
        scope + '.published-workflow.json',
      ),
    ];
    const snapshotBindings = [];
    for (const file of snapshots) {
      const bytes = await writeJson(file, { fixture: path.basename(file) });
      snapshotBindings.push({ path: file, sha256: sha(bytes) });
    }
    const output = path.join(batch.root, 'runs', condition, scope + '.jsonl');
    const outputBytes = await writeRows(output, [
      {
        id: 'q1',
        scope,
        ranked_queries: [
          {
            query_id: 's1',
            results: [{ unit_id: 'unit1', rank: 1, score: 0.8 }],
          },
        ],
        rankings: [{ id: 'unit1', rank: 1, score: 0.7 }],
      },
    ]);
    await writeJson(
      path.join(batch.root, 'runs', condition, scope + '.receipt.json'),
      {
        status: 'completed',
        condition,
        scope,
        parent_questions: 1,
        run_fingerprint: 'dify-run-fingerprint',
        freeze_sha256: sha(freezeBytes),
        corpus_sha256: batch.info.corpus.sha256,
        query_sha256: batch.info.queries.sha256,
        query_index_receipt_file: index.receiptPath,
        query_index_receipt_sha256: index.receiptSha,
        scope_execution_files: [
          { path: index.stateFile, sha256: index.stateSha },
          { path: index.segmentMapFile, sha256: index.segmentMapSha },
        ],
        native_files: [
          {
            question_id: 'q1',
            query_id: 's1',
            path: nativeFile,
            sha256: sha(nativeBytes),
          },
        ],
        runtime_snapshots: snapshotBindings,
        output_file: output,
        output_sha256: sha(outputBytes),
      },
    );

    await expect(
      verifyProductRuns({ root: batch.root, condition, scopes: [scope] }),
    ).rejects.toThrow(
      'Fixed public ranking score differs from verified native results',
    );
  });
});
