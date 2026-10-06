import { mkdtemp, writeFile, readFile, mkdir, cp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
const { jsonLines, qasperMarkdown, qasperLabels } = await import(
  pathToFileURL(resolve('evals/prepare-public-benchmarks.mjs')).href
);
it('keeps Unicode line separators inside a JSONL string without changing corpus text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-public-jsonl-'));
  try {
    const p = join(dir, 'fixture.jsonl');
    const rows = [
      { text: 'code\u2028still same document\u2029end' },
      { text: 'second\nphysical escaped newline' },
    ];
    await writeFile(p, rows.map((r) => JSON.stringify(r)).join('\n'));
    const actual = [];
    for await (const row of jsonLines(p)) actual.push(row);
    expect(actual).toEqual(rows);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('maps QASPER evidence to original paragraph ranges without unioning annotators', () => {
  const data = qasperMarkdown(
    {
      title: 'Fixture',
      abstract: 'Summary',
      full_text: [
        {
          section_name: 'Results',
          paragraphs: ['first\nfact', 'second fact', 'first\nfact'],
        },
      ],
    },
    '7e9c9b01-1d31-4374-a925-876f4bc6232b',
  );
  const q = {
    answers: [
      {
        annotation_id: 'a',
        answer: { unanswerable: false, evidence: ['first fact'] },
      },
      {
        annotation_id: 'b',
        answer: { unanswerable: false, evidence: ['second fact'] },
      },
      { annotation_id: 'c', answer: { unanswerable: true, evidence: [] } },
    ],
  };
  const labels = qasperLabels(q, data.paragraphs);
  expect(labels.eligible).toBe(true);
  expect(labels.annotation_disagreement).toBe(true);
  expect(labels.annotations[0].evidence[0].paragraph_ids).toEqual([1, 3]);
  expect(labels.annotations[1].evidence[0].paragraph_ids).toEqual([2]);
  for (const p of data.paragraphs)
    expect(
      data.markdown
        .split('\n')
        .slice(p.start_line - 1, p.end_line)
        .join('\n'),
    ).toBe(p.text);
});
it('does not silently score only the mapped subset of a required evidence set', () => {
  const paragraphs = [{ id: 0, text: 'known' }];
  for (const evidence of [
    ['known', 'missing'],
    ['known', 'FLOAT SELECTED: figure'],
    [],
  ]) {
    const labels = qasperLabels(
      { answers: [{ answer: { unanswerable: false, evidence } }] },
      paragraphs,
    );
    expect(labels.eligible).toBe(false);
    expect(labels.category).toBe('unsupported_evidence');
  }
  expect(
    qasperLabels(
      { answers: [{ answer: { unanswerable: true, evidence: [] } }] },
      paragraphs,
    ).category,
  ).toBe('unanswerable');
});

const { lastRowsById } = await import(
  pathToFileURL(resolve('evals/prepare-public-benchmarks.mjs')).href
);
const { qasperScore, boundedRequest } = await import(
  pathToFileURL(resolve('evals/lib/public-runtime.mjs')).href
);

it('configures a new isolated Qasper run with whole mode without a model call', async () => {
  const { parseConfig } = await import('../src/config.js');
  const { embeddingFingerprint } = await import('../src/embedding.js');
  const { openDatabase } = await import('../src/database.js');
  await mkdir(resolve('.echo'), { recursive: true });
  const root = await mkdtemp(join(resolve('.echo'), 'qasper-mode-'));
  try {
    await mkdir(join(root, 'runtime'));
    await cp(resolve('dist'), join(root, 'runtime/dist'), { recursive: true });
    const embedding = parseConfig({
      embedding: {
        base_url: 'http://127.0.0.1:1/v1',
        model: 'fixture',
        dimensions: 2,
      },
    }).embedding;
    await writeFile(
      join(root, 'embedding-plan.json'),
      JSON.stringify({
        fingerprint: embeddingFingerprint(embedding),
        config: embedding,
      }),
    );
    const db = openDatabase(join(root, 'vectors.sqlite'));
    try {
      db.exec('CREATE TABLE entries (key TEXT, vector BLOB, vector_sha TEXT)');
    } finally {
      db.close();
    }
    const output = execFileSync(
      process.execPath,
      [resolve('evals/run-public-qasper.mjs'), root, 'configure'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(output).toContain('QASPER_CONFIGURED');
    for (const k of [10, 30]) {
      const config = JSON.parse(
        await readFile(
          join(root, `qasper/config/retrieval/rrf${k}.json`),
          'utf8',
        ),
      );
      expect(config.packing_mode).toBe('whole');
      expect(config.rrf_k).toBe(k);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('scores complete whole-mode blocks after a long block is skipped under the response budget', async () => {
  const { packResults } = await import('../src/retrieval.js');
  const { retrievalSchema } = await import('../src/config.js');
  const long = 'A'.repeat(25500) + '\nNOT enabled.';
  const short = 'Target evidence';
  const markdown = long + '\n' + short;
  const base = {
    source_id: 'source',
    collection_id: 'notes',
    path: '/notes/a.md',
    relative_path: 'a.md',
    source_version: 'a'.repeat(64),
    heading_path: [],
    section_start_line: 1,
    section_end_line: 3,
    matched_query_ids: [],
  };
  const result = packResults(
    [
      {
        query_id: 'q',
        status: 'ok',
        counts: { bm25: 2, dense: 0, fused: 2 },
        candidates: [
          {
            score: 2,
            evidence: {
              ...base,
              chunk_id: 'long',
              start_line: 1,
              end_line: 2,
              text: long,
            },
          },
          {
            score: 1,
            evidence: {
              ...base,
              chunk_id: 'short',
              start_line: 3,
              end_line: 3,
              text: short,
            },
          },
        ],
      },
    ],
    retrievalSchema.parse({ packing_mode: 'whole', max_context_chars: 16000 }),
  );
  expect(result.results.map((e) => e.chunk_id)).toEqual(['short']);
  expect(result.results[0]!.text_truncated).toBe(false);
  const doc = {
    source_id: 'source',
    paragraphs: [
      { id: 0, text: long, start_line: 1, end_line: 2 },
      { id: 1, text: short, start_line: 3, end_line: 3 },
    ],
  };
  const q = {
    eligible: true,
    category: 'text_evidence',
    annotations: [
      { id: 'a', valid: true, evidence: [{ text: short, paragraph_ids: [1] }] },
    ],
  };
  expect(qasperScore(q, doc, result, markdown).strict_complete).toBe(true);
  q.annotations[0]!.evidence = [{ text: long, paragraph_ids: [0] }];
  expect(qasperScore(q, doc, result, markdown).strict_complete).toBe(false);
  expect(result.excluded!.budget).toBe(1);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(16000);
});
it('uses the final row for an official duplicate corpus ID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-public-lastrow-'));
  try {
    const p = join(dir, 'data.jsonl');
    await writeFile(
      p,
      [
        { _id: 'a', text: 'old' },
        { _id: 'b', text: 'other' },
        { _id: 'a', text: 'new' },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    );
    const rows = await lastRowsById(p);
    expect(rows.size).toBe(2);
    expect(rows.get('a').text).toBe('new');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('preserves official Evidence F1 duplicate denominators and separates normalized coverage', () => {
  const doc = {
    source_id: 'source',
    paragraphs: [
      { id: 0, text: 'A', start_line: 1, end_line: 1 },
      { id: 1, text: 'A', start_line: 3, end_line: 3 },
    ],
  };
  const result = {
    results: [
      { source_id: 'source', start_line: 1, end_line: 3, text: 'A\n\nA' },
    ],
  };
  const q = {
    eligible: true,
    category: 'text_evidence',
    annotations: [
      {
        id: 'ann',
        valid: true,
        evidence: [{ text: 'A', paragraph_ids: [0, 1] }],
      },
    ],
  };
  const score = qasperScore(q, doc, result, 'A\n\nA');
  expect(score.official_formula_evidence_f1).toBeCloseTo(2 / 3);
  expect(score.strict_complete).toBe(true);
  q.annotations[0]!.evidence[0]!.text = ' A ';
  const whitespace = qasperScore(q, doc, result, 'A\n\nA');
  expect(whitespace.official_formula_evidence_f1).toBe(0);
  expect(whitespace.strict_coverage).toBe(1);
});
it('charges filters and overrides against the same cumulative context budget', () => {
  const request = boundedRequest(
    'Question',
    '123e4567-e89b-42d3-a456-426614174000',
  );
  expect(
    JSON.stringify(request).length + request.overrides.max_context_chars,
  ).toBeLessThanOrEqual(16000);
  expect(request.filters.source_ids).toEqual([
    '123e4567-e89b-42d3-a456-426614174000',
  ]);
});

it('includes explicit retrieval overrides in the budget without accepting their own budget', () => {
  const overrides = {
    mode: 'hybrid',
    bm25_weight: 0.25,
    max_context_chars: 999999,
  };
  const request = boundedRequest('Question', 'source', 16000, overrides);
  expect(request.overrides.mode).toBe('hybrid');
  expect(request.overrides.bm25_weight).toBe(0.25);
  expect(
    JSON.stringify(request).length + request.overrides.max_context_chars,
  ).toBeLessThanOrEqual(16000);
  expect(overrides.max_context_chars).toBe(999999);
});
