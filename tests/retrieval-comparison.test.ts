import { describe, it, expect } from 'vitest';
import { pairedBootstrap } from '../src/retrieval-comparison.js';
describe('paired retrieval statistics', () => {
  it('reports a hand-worked gain and resamples whole independent intent groups', () => {
    const result = pairedBootstrap(
      [
        {
          id: 'a',
          group: 'one',
          baseline: { covered: 0, expected: 1 },
          candidate: { covered: 1, expected: 1 },
        },
        {
          id: 'b',
          group: 'two',
          baseline: { covered: 0, expected: 3 },
          candidate: { covered: 3, expected: 3 },
        },
      ],
      { iterations: 1000, seed: 7 },
    );
    expect(result.independent_groups).toBe(2);
    expect(result.fact_coverage).toEqual({
      baseline: 0,
      candidate: 1,
      delta: 1,
      ci95: [1, 1],
      valid_resamples: 1000,
    });
    expect(result.complete_evidence).toEqual({
      baseline: 0,
      candidate: 1,
      delta: 1,
      ci95: [1, 1],
      valid_resamples: 1000,
    });
  });
});

it('does not treat repeated rows from one intent as independent trials', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: 'positive-' + i,
    group: 'positive',
    baseline: { covered: 0, expected: 1 },
    candidate: { covered: 1, expected: 1 },
  }));
  rows.push({
    id: 'negative',
    group: 'negative',
    baseline: { covered: 1, expected: 1 },
    candidate: { covered: 0, expected: 1 },
  });
  const r = pairedBootstrap(rows, { iterations: 1000, seed: 7 });
  expect(r.questions).toBe(21);
  expect(r.independent_groups).toBe(2);
  expect(r.fact_coverage.delta).toBeCloseTo(19 / 21);
  expect(r.fact_coverage.ci95).toEqual([-1, 1]);
  expect(pairedBootstrap(rows, { iterations: 1000, seed: 7 })).toEqual(r);
});
it('keeps absent denominators and a single independent group explicit', () => {
  const absent = pairedBootstrap([
    {
      id: 'none',
      group: 'one',
      baseline: { covered: 0, expected: 0 },
      candidate: { covered: 0, expected: 0 },
    },
  ]);
  expect(absent.fact_coverage).toEqual({
    baseline: null,
    candidate: null,
    delta: null,
    ci95: null,
    valid_resamples: 0,
  });
  const one = pairedBootstrap([
    {
      id: 'q',
      group: 'one',
      baseline: { covered: 0, expected: 1 },
      candidate: { covered: 1, expected: 1 },
    },
  ]);
  expect(one.fact_coverage.delta).toBe(1);
  expect(one.fact_coverage.ci95).toBeNull();
});
it('rejects mismatched labels and impossible counts', () => {
  expect(() =>
    pairedBootstrap([
      {
        id: 'q',
        group: 'q',
        baseline: { covered: 0, expected: 1 },
        candidate: { covered: 1, expected: 2 },
      },
    ]),
  ).toThrow(/Required facts differ/);
  expect(() =>
    pairedBootstrap([
      {
        id: 'q',
        group: 'q',
        baseline: { covered: 2, expected: 1 },
        candidate: { covered: 1, expected: 1 },
      },
    ]),
  ).toThrow(/Invalid fact counts/);
});

import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { compareRetrievalRuns } from '../src/retrieval-comparison.js';
async function fixtureRun(root: string, name: string, hit: boolean) {
  const dir = join(root, name);
  await mkdir(dir);
  const data = {
    version: 1,
    name: 'paired',
    split: 'development',
    scenario: { id: 'A', kind: 'separate' },
    corpus: [{ collection_id: 'a', path: 'a.md', sha256: 'a'.repeat(64) }],
    facts: [{ id: 'f', evidence: [] }],
    questions: [
      {
        id: 'q',
        intent_group: 'i',
        type: 'fact',
        query: 'what?',
        required_facts: ['f'],
        no_answer: false,
      },
    ],
  };
  const raw = JSON.stringify(data);
  await writeFile(join(dir, 'dataset.json'), raw);
  const request = { query: 'what?', overrides: { max_context_chars: 11900 } };
  const result = { status: 'ok', results: hit ? [{ text: 'evidence' }] : [] };
  const row = {
    query_id: 'q',
    intent_group: 'i',
    type: 'fact',
    request,
    status: 'ok',
    expected_facts: ['f'],
    covered_facts: hit ? ['f'] : [],
    subquery_coverage: [],
    no_answer: false,
    request_chars: JSON.stringify(request).length,
    response_chars: JSON.stringify(result).length,
    context_chars:
      JSON.stringify(request).length + JSON.stringify(result).length,
    latency_ms: 10,
    first_fact_reciprocal_rank: hit ? 1 : 0,
    api_requests: 0,
    result,
  };
  const manifest = {
    dataset: {
      name: data.name,
      split: data.split,
      scenario: data.scenario,
      sha256: createHash('sha256').update(raw).digest('hex'),
    },
    corpus: data.corpus,
    runtime: { sha256: 'b'.repeat(64) },
    budget_chars: 12000,
    retrieval: { mode: 'bm25' },
    embedding: { model: 'example' },
    selection: { chunker: name },
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'rows.jsonl'), JSON.stringify(row) + '\n');
  await writeFile(
    join(dir, 'report.json'),
    JSON.stringify({
      status: 'complete',
      dataset: data.name,
      split: data.split,
      scenario: data.scenario,
      retrieval_only: true,
      api_usage: null,
      query_cache_hits: 0,
      rows: [row],
    }),
  );
  return dir;
}
it('pairs frozen run artifacts and refuses changed source budgets or labels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-paired-'));
  try {
    const a = await fixtureRun(root, 'baseline', false),
      b = await fixtureRun(root, 'candidate', true);
    const result = await compareRetrievalRuns(a, b, {
      iterations: 1000,
      seed: 7,
    });
    expect(result.paired.fact_coverage.delta).toBe(1);
    expect(result.status).toBe('complete');
    const p = join(b, 'manifest.json'),
      m = JSON.parse(await readFile(p, 'utf8'));
    m.budget_chars = 24000;
    await writeFile(p, JSON.stringify(m));
    await expect(compareRetrievalRuns(a, b)).rejects.toThrow(/budget/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { writeRetrievalComparison } from '../src/retrieval-comparison.js';
it('rejects corrupted labels, result logs, and existing comparison output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-comparison-'));
  try {
    const a = await fixtureRun(root, 'a', false),
      b = await fixtureRun(root, 'b', true);
    const output = join(root, 'comparison.json');
    await writeRetrievalComparison(a, b, output);
    await expect(writeRetrievalComparison(a, b, output)).rejects.toThrow(
      /EEXIST/,
    );
    await expect(
      writeRetrievalComparison(a, b, join(a, '..comparison.json')),
    ).rejects.toThrow(/outside/);
    const original = await readFile(join(b, 'dataset.json'), 'utf8');
    await writeFile(join(b, 'dataset.json'), original + ' ');
    await expect(compareRetrievalRuns(a, b)).rejects.toThrow(/Dataset bytes/);
    await writeFile(join(b, 'dataset.json'), original);
    await writeFile(join(b, 'rows.jsonl'), '{}\n');
    await expect(compareRetrievalRuns(a, b)).rejects.toThrow(/Row log/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('retains partial failure in the comparison rather than dropping its question', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-incomplete-'));
  try {
    const a = await fixtureRun(root, 'a', false),
      b = await fixtureRun(root, 'b', true);
    const file = join(b, 'report.json'),
      report = JSON.parse(await readFile(file, 'utf8'));
    report.status = 'incomplete';
    const row = report.rows[0];
    row.status = 'partial_failure';
    row.result.status = 'partial_failure';
    row.response_chars = JSON.stringify(row.result).length;
    row.context_chars = row.request_chars + row.response_chars;
    await writeFile(file, JSON.stringify(report));
    await writeFile(join(b, 'rows.jsonl'), JSON.stringify(row) + '\n');
    const r = await compareRetrievalRuns(a, b);
    expect(r.status).toBe('diagnostic_incomplete');
    expect(r.candidate.failures).toBe(1);
    expect(r.paired.questions).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps fixed child questions in their parent intent group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-children-'));
  try {
    const dirs = [
      await fixtureRun(root, 'baseline', false),
      await fixtureRun(root, 'candidate', true),
    ];
    for (const [i, dir] of dirs.entries()) {
      const d = JSON.parse(await readFile(join(dir, 'dataset.json'), 'utf8'));
      d.facts.push({ id: 'g', evidence: [] });
      d.questions[0].required_facts = ['f', 'g'];
      d.questions[0].subquestions = [
        { id: 'one', text: 'first?', required_facts: ['f'] },
        { id: 'two', text: 'second?', required_facts: ['g'] },
      ];
      const raw = JSON.stringify(d);
      await writeFile(join(dir, 'dataset.json'), raw);
      const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      m.dataset.sha256 = createHash('sha256').update(raw).digest('hex');
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(m));
      const r = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')),
        row = r.rows[0];
      row.expected_facts = ['f', 'g'];
      row.request = {
        queries: [
          { query_id: 'one', text: 'first?' },
          { query_id: 'two', text: 'second?' },
        ],
        overrides: { max_context_chars: 11800 },
      };
      row.subquery_coverage = [
        {
          query_id: 'one',
          expected_facts: ['f'],
          covered_facts: i ? ['f'] : [],
        },
        { query_id: 'two', expected_facts: ['g'], covered_facts: [] },
      ];
      row.request_chars = JSON.stringify(row.request).length;
      row.context_chars = row.request_chars + row.response_chars;
      await writeFile(join(dir, 'report.json'), JSON.stringify(r));
      await writeFile(join(dir, 'rows.jsonl'), JSON.stringify(row) + '\n');
    }
    const r = await compareRetrievalRuns(dirs[0]!, dirs[1]!);
    expect(r.paired.fact_coverage.delta).toBe(0.5);
    expect(r.paired.complete_evidence.delta).toBe(0);
    expect(r.subquestions?.questions).toBe(2);
    expect(r.subquestions?.independent_groups).toBe(1);
    expect(r.subquestions?.fact_coverage.ci95).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('cannot manufacture an answerable confidence interval by adding unanswerable groups', () => {
  const r = pairedBootstrap(
    [
      {
        id: 'answer',
        group: 'one',
        baseline: { covered: 0, expected: 1 },
        candidate: { covered: 1, expected: 1 },
      },
      {
        id: 'absent',
        group: 'two',
        baseline: { covered: 0, expected: 0 },
        candidate: { covered: 0, expected: 0 },
      },
    ],
    { iterations: 1000, seed: 7 },
  );
  expect(r.independent_groups).toBe(2);
  expect(r.fact_coverage.ci95).toBeNull();
  expect(r.fact_coverage.valid_resamples).toBe(0);
});
it('accepts equivalent corpus manifests in producer-normalized order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-corpus-order-'));
  try {
    const dirs = [
      await fixtureRun(root, 'a', false),
      await fixtureRun(root, 'b', true),
    ];
    for (const dir of dirs) {
      const d = JSON.parse(await readFile(join(dir, 'dataset.json'), 'utf8'));
      d.corpus = [
        { collection_id: 'a', path: 'z.md', sha256: 'c'.repeat(64) },
        ...d.corpus,
      ];
      const raw = JSON.stringify(d);
      await writeFile(join(dir, 'dataset.json'), raw);
      const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      m.corpus = d.corpus.slice().reverse();
      m.dataset.sha256 = createHash('sha256').update(raw).digest('hex');
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(m));
    }
    const r = await compareRetrievalRuns(dirs[0]!, dirs[1]!);
    expect(r.paired.fact_coverage.delta).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects claimed coverage when the recorded retrieval returned no evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-impossible-'));
  try {
    const a = await fixtureRun(root, 'a', false),
      b = await fixtureRun(root, 'b', true);
    const p = join(b, 'report.json'),
      r = JSON.parse(await readFile(p, 'utf8')),
      row = r.rows[0];
    row.status = 'empty';
    row.result = { status: 'empty', results: [] };
    row.response_chars = JSON.stringify(row.result).length;
    row.context_chars = row.request_chars + row.response_chars;
    await writeFile(p, JSON.stringify(r));
    await writeFile(join(b, 'rows.jsonl'), JSON.stringify(row) + '\n');
    await expect(compareRetrievalRuns(a, b)).rejects.toThrow(
      /coverage|evidence/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
