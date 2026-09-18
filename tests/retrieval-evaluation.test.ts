import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeWorkspace, useProfiles } from '../src/profile-manager.js';
import { loadConfig } from '../src/config.js';
import { syncIndex } from '../src/sync.js';
import { hash } from '../src/identity.js';
import {
  runRetrievalEvaluation,
  snapshotRetrievalCorpus,
} from '../src/retrieval-evaluation.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'echo-recall-'));
  const configPath = join(root, 'echo.config.json');
  const notes = join(root, 'notes');
  await mkdir(notes);
  const raw =
    '---\necho_id: 10000000-0000-4000-8000-000000000001\n---\n# 索引事务\n\n失败时回滚未提交的修改。\n';
  await writeFile(join(notes, 'transaction.md'), raw);
  await initializeWorkspace(configPath);
  await writeFile(
    join(root, 'config', 'sources.json'),
    JSON.stringify({
      collections: [{ id: 'notes', root: 'notes' }],
    }),
  );
  await useProfiles(configPath, { retrieval: 'bm25' });
  await syncIndex(await loadConfig(configPath));
  const datasetPath = join(root, 'dataset.json');
  const dataset = {
    version: 1,
    name: 'isolated-recall',
    split: 'development',
    scenario: { id: 'notes', kind: 'separate' },
    corpus: [
      { collection_id: 'notes', path: 'transaction.md', sha256: hash(raw) },
    ],
    facts: [
      {
        id: 'rollback',
        evidence: [
          {
            collection_id: 'notes',
            path: 'transaction.md',
            start_line: 6,
            end_line: 6,
            quote: '失败时回滚未提交的修改。',
          },
        ],
      },
    ],
    questions: [
      {
        id: 'q1',
        intent_group: 'rollback',
        type: 'single_fact',
        query: '事务失败时怎么回滚',
        required_facts: ['rollback'],
        no_answer: false,
      },
      {
        id: 'q2',
        intent_group: 'weather',
        type: 'no_answer',
        query: 'zqxvdoesnotexist',
        required_facts: [],
        no_answer: true,
      },
    ],
  };
  await writeFile(datasetPath, JSON.stringify(dataset));
  return {
    root,
    configPath,
    datasetPath,
    dataset,
    notes,
    raw,
    outputDir: join(root, 'run'),
  };
}
it('scores actual indexed evidence from a frozen corpus without an Agent or source changes', async () => {
  const f = await fixture();
  try {
    const { report } = await runRetrievalEvaluation({
      ...f,
      budgetChars: 2000,
    });
    expect(report.status).toBe('complete');
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]!.covered_facts).toEqual(['rollback']);
    expect(report.rows[1]!.covered_facts).toEqual([]);
    expect(report.summary.fact_coverage).toEqual({ covered: 1, expected: 1 });
    expect(report.api_usage).toBeNull();
    const defaultOutput = join(f.root, 'default-budget-run');
    const defaultRun = await runRetrievalEvaluation({
      ...f,
      outputDir: defaultOutput,
    });
    const defaultManifest = JSON.parse(
      await readFile(join(defaultOutput, 'manifest.json'), 'utf8'),
    );
    expect(defaultManifest.budget_chars).toBe(16000);
    expect(defaultManifest.retrieval.rrf_k).toBe(30);
    expect(defaultRun.report.status).toBe('complete');
    for (const row of report.rows) {
      expect(row.request_chars + row.response_chars).toBe(row.context_chars);
      expect(row.context_chars).toBeLessThanOrEqual(2000);
    }
    expect(await readFile(join(f.notes, 'transaction.md'), 'utf8')).toBe(f.raw);
    expect(
      JSON.parse(await readFile(join(f.outputDir, 'report.json'), 'utf8'))
        .status,
    ).toBe('complete');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('honors the selected response cap even when the evaluation budget is larger', async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.root, 'config', 'retrieval', 'bm25.json'),
      JSON.stringify({ id: 'bm25', mode: 'bm25', max_context_chars: 1500 }),
    );
    const { report } = await runRetrievalEvaluation({
      ...f,
      budgetChars: 4000,
    });
    expect(
      report.rows.every((r) => r.result.applied.max_context_chars <= 1500),
    ).toBe(true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('sends frozen subquestions in one retrieval and preserves parent and child evidence coverage', async () => {
  const f = await fixture();
  try {
    const second =
      '---\necho_id: 10000000-0000-4000-8000-000000000002\n---\n# 审批恢复\n\n批准后从保存的暂停位置继续。\n';
    await writeFile(join(f.notes, 'approval.md'), second);
    await syncIndex(await loadConfig(f.configPath));
    const dataset = {
      ...f.dataset,
      corpus: [
        ...f.dataset.corpus,
        { collection_id: 'notes', path: 'approval.md', sha256: hash(second) },
      ],
      facts: [
        ...f.dataset.facts,
        {
          id: 'resume',
          evidence: [
            {
              collection_id: 'notes',
              path: 'approval.md',
              start_line: 6,
              end_line: 6,
              quote: '批准后从保存的暂停位置继续。',
            },
          ],
        },
      ],
      questions: [
        {
          id: 'combined',
          intent_group: 'recovery',
          type: 'multi_evidence',
          query: '事务失败和审批通过时分别怎样恢复？',
          required_facts: ['rollback', 'resume'],
          no_answer: false,
          subquestions: [
            {
              id: 'transaction',
              text: '事务失败回滚',
              required_facts: ['rollback'],
            },
            {
              id: 'approval',
              text: '审批批准后如何继续',
              required_facts: ['resume'],
            },
          ],
        },
      ],
    };
    await writeFile(f.datasetPath, JSON.stringify(dataset));
    const { report } = await runRetrievalEvaluation({
      ...f,
      budgetChars: 6000,
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.covered_facts).toEqual(['rollback', 'resume']);
    expect(report.rows[0]!.subquery_coverage).toEqual([
      {
        query_id: 'transaction',
        expected_facts: ['rollback'],
        covered_facts: ['rollback'],
      },
      {
        query_id: 'approval',
        expected_facts: ['resume'],
        covered_facts: ['resume'],
      },
    ]);
    expect(report.rows[0]!.result.queries.map((q) => q.query_id)).toEqual([
      'transaction',
      'approval',
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('rejects changed corpus and invalid anchors before producing successful metrics', async () => {
  const f = await fixture();
  try {
    const invalid = {
      ...f.dataset,
      facts: [
        {
          id: 'rollback',
          evidence: [
            {
              ...f.dataset.facts[0]!.evidence[0]!,
              quote: 'This is not present',
            },
          ],
        },
      ],
    };
    await writeFile(f.datasetPath, JSON.stringify(invalid));
    await expect(runRetrievalEvaluation(f)).rejects.toThrow(
      'Invalid source evidence anchor',
    );
    expect(
      JSON.parse(await readFile(join(f.outputDir, 'failure.json'), 'utf8'))
        .api_usage,
    ).toBeNull();
    await writeFile(f.datasetPath, JSON.stringify(f.dataset));
    await writeFile(join(f.notes, 'transaction.md'), f.raw + '\n新内容\n');
    await expect(
      runRetrievalEvaluation({ ...f, outputDir: join(f.root, 'changed') }),
    ).rejects.toThrow('Corpus does not match frozen manifest');
    await expect(
      readFile(join(f.root, 'changed', 'report.json')),
    ).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it('rejects a stale index even when labels match the edited source', async () => {
  const f = await fixture();
  try {
    const next = f.raw + '\n已发生变化。\n';
    await writeFile(join(f.notes, 'transaction.md'), next);
    await writeFile(
      f.datasetPath,
      JSON.stringify({
        ...f.dataset,
        corpus: [{ ...f.dataset.corpus[0]!, sha256: hash(next) }],
      }),
    );
    await expect(runRetrievalEvaluation(f)).rejects.toThrow(
      'Index differs from frozen source corpus',
    );
    expect(await readFile(join(f.notes, 'transaction.md'), 'utf8')).toBe(next);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it('never reuses a completed output or creates reports inside note collections', async () => {
  const f = await fixture();
  try {
    await runRetrievalEvaluation(f);
    const before = await readFile(join(f.outputDir, 'report.json'), 'utf8');
    await expect(runRetrievalEvaluation(f)).rejects.toThrow(
      'Output directory must be empty',
    );
    expect(await readFile(join(f.outputDir, 'report.json'), 'utf8')).toBe(
      before,
    );
    await expect(
      runRetrievalEvaluation({ ...f, outputDir: join(f.notes, 'result') }),
    ).rejects.toThrow('outside source collections');
    await expect(
      readFile(join(f.notes, 'result', '.attempt.json')),
    ).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it('does not credit identical words returned from a different labelled source', async () => {
  const f = await fixture();
  try {
    const second =
      '---\necho_id: 10000000-0000-4000-8000-000000000002\n---\n# other\n\n失败时回滚未提交的修改。\n';
    await writeFile(join(f.notes, 'other.md'), second);
    await syncIndex(await loadConfig(f.configPath));
    await writeFile(
      f.datasetPath,
      JSON.stringify({
        ...f.dataset,
        corpus: [
          ...f.dataset.corpus,
          { collection_id: 'notes', path: 'other.md', sha256: hash(second) },
        ],
        facts: [
          {
            id: 'rollback',
            evidence: [
              { ...f.dataset.facts[0]!.evidence[0]!, path: 'other.md' },
            ],
          },
        ],
        questions: [{ ...f.dataset.questions[0]!, query: '索引事务' }],
      }),
    );
    const { report } = await runRetrievalEvaluation(f);
    expect(report.rows[0]!.result.results.length).toBeGreaterThan(0);
    expect(report.rows[0]!.covered_facts).toEqual([]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('combines only actually returned source lines when a fact crosses chunk boundaries', async () => {
  const f = await fixture();
  try {
    const first = 'alpha ' + '甲'.repeat(44),
      second = 'beta ' + '乙'.repeat(44);
    const raw =
      '---\necho_id: 10000000-0000-4000-8000-000000000001\n---\n# two parts\n\n' +
      first +
      '\n' +
      second +
      '\n';
    await writeFile(join(f.notes, 'transaction.md'), raw);
    await writeFile(
      join(f.root, 'chunkers', 'line-64.mjs'),
      "export default {id:'line-64',version:'1',chunk(input){return input.headingLines(64);}}",
    );
    await useProfiles(f.configPath, { chunker: 'line-64' });
    await syncIndex(await loadConfig(f.configPath));
    await writeFile(
      f.datasetPath,
      JSON.stringify({
        ...f.dataset,
        corpus: [
          { collection_id: 'notes', path: 'transaction.md', sha256: hash(raw) },
        ],
        facts: [
          {
            id: 'both',
            evidence: [
              {
                collection_id: 'notes',
                path: 'transaction.md',
                start_line: 6,
                end_line: 7,
                quote: first + '\n' + second,
              },
            ],
          },
        ],
        questions: [
          {
            id: 'parts',
            intent_group: 'parts',
            type: 'multi_evidence',
            query: 'alpha beta',
            required_facts: ['both'],
            no_answer: false,
          },
        ],
      }),
    );
    const { report } = await runRetrievalEvaluation(f);
    expect(report.rows[0]!.result.results).toHaveLength(2);
    expect(report.rows[0]!.covered_facts).toEqual(['both']);
    expect(report.rows[0]!.first_fact_reciprocal_rank).toBe(0.5);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
// Local HTTP fixture verifies the real API boundary; vectors are not semantic-quality evidence.
it('enforces real request limits and preserves billed failure evidence without exposing a key', async () => {
  const { createServer } = await import('node:http');
  const f = await fixture();
  let requests = 0;
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      requests++;
      const body = JSON.parse(Buffer.concat(parts).toString()) as {
        input: string[];
      };
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
          usage: { total_tokens: 7 },
        }),
      );
    });
  });
  const key = 'ECHO_RECALL_TEST_KEY',
    old = process.env[key];
  process.env[key] = 'test-boundary-value-never-serialize';
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(
            24000 + Math.floor(Math.random() * 24000),
            '127.0.0.1',
            () => {
              server.removeListener('error', reject);
              resolve();
            },
          );
        });
        break;
      } catch (error) {
        if (attempt === 9) throw error;
      }
    }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    await writeFile(
      join(f.root, 'config', 'embedding', 'default.json'),
      JSON.stringify({
        id: 'default',
        model: 'protocol-only',
        dimensions: 2,
        base_url: 'http://127.0.0.1:' + address.port + '/v1',
        api_key_env: key,
      }),
    );
    await useProfiles(f.configPath, { retrieval: 'balanced' });
    await syncIndex(await loadConfig(f.configPath));
    requests = 0;
    await expect(
      runRetrievalEvaluation({ ...f, maxApiCalls: 1 }),
    ).rejects.toThrow('API request budget exhausted');
    expect(requests).toBe(1);
    const text = await readFile(join(f.outputDir, 'failure.json'), 'utf8');
    const failure = JSON.parse(text) as {
      api_usage: { requests: number; reported_tokens: number };
    };
    expect(failure.api_usage).toMatchObject({
      requests: 1,
      reported_tokens: 7,
    });
    expect(text).not.toContain(process.env[key]);
    await expect(readFile(join(f.outputDir, 'report.json'))).rejects.toThrow();
    await expect(
      runRetrievalEvaluation({ ...f, maxApiCalls: 1 }),
    ).rejects.toThrow('Output directory must be empty');
    expect(requests).toBe(1);
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

it('uses the same normalized subquestion identities as Echo when scoring child coverage', async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.datasetPath,
      JSON.stringify({
        ...f.dataset,
        questions: [
          {
            ...f.dataset.questions[0]!,
            subquestions: [
              {
                id: ' transaction ',
                text: '回滚未提交',
                required_facts: ['rollback'],
              },
            ],
          },
        ],
      }),
    );
    const { report } = await runRetrievalEvaluation(f);
    expect(report.rows[0]!.subquery_coverage).toEqual([
      {
        query_id: 'transaction',
        expected_facts: ['rollback'],
        covered_facts: ['rollback'],
      },
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('writes a portable corpus snapshot only outside the notes and never overwrites it', async () => {
  const f = await fixture();
  try {
    const file = join(f.root, 'snapshot.json');
    const corpus = await snapshotRetrievalCorpus(f.configPath, file);
    expect(corpus).toEqual(f.dataset.corpus);
    await expect(snapshotRetrievalCorpus(f.configPath, file)).rejects.toThrow();
    await expect(
      snapshotRetrievalCorpus(f.configPath, join(f.notes, 'new.md')),
    ).rejects.toThrow('outside source collections');
    await expect(readFile(join(f.notes, 'new.md'))).rejects.toThrow();
    expect(await readFile(join(f.notes, 'transaction.md'), 'utf8')).toBe(f.raw);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('rejects changed invalid UTF-8 bytes even when replacement decoding would preserve the same text', async () => {
  const f = await fixture();
  try {
    const raw = f.raw.replace(
      '失败时回滚未提交的修改。',
      '失败时回滚未提交的修改。�',
    );
    await writeFile(join(f.notes, 'transaction.md'), raw);
    await syncIndex(await loadConfig(f.configPath));
    const dataset = {
      ...f.dataset,
      corpus: [{ ...f.dataset.corpus[0]!, sha256: hash(raw) }],
      facts: [
        {
          id: 'rollback',
          evidence: [
            {
              ...f.dataset.facts[0]!.evidence[0]!,
              quote: '失败时回滚未提交的修改。�',
            },
          ],
        },
      ],
    };
    await writeFile(f.datasetPath, JSON.stringify(dataset));
    const bytes = Buffer.from(raw),
      at = bytes.indexOf(Buffer.from('�'));
    const invalid = Buffer.concat([
      bytes.subarray(0, at),
      Buffer.from([0xff]),
      bytes.subarray(at + 3),
    ]);
    expect(invalid.equals(bytes)).toBe(false);
    await writeFile(join(f.notes, 'transaction.md'), invalid);
    await expect(runRetrievalEvaluation(f)).rejects.toThrow(/UTF-8|utf-8/);
    await expect(snapshotRetrievalCorpus(f.configPath)).rejects.toThrow(
      /UTF-8|utf-8/,
    );
    await expect(readFile(join(f.outputDir, 'report.json'))).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it('preserves a valid UTF-8 BOM in the frozen source version and original line locations', async () => {
  const f = await fixture();
  try {
    const raw = '\uFEFF' + f.raw;
    await writeFile(join(f.notes, 'transaction.md'), raw);
    await syncIndex(await loadConfig(f.configPath));
    await writeFile(
      f.datasetPath,
      JSON.stringify({
        ...f.dataset,
        corpus: [{ ...f.dataset.corpus[0]!, sha256: hash(raw) }],
      }),
    );
    const { report } = await runRetrievalEvaluation(f);
    expect(report.rows[0]!.covered_facts).toEqual(['rollback']);
    expect(await readFile(join(f.notes, 'transaction.md'), 'utf8')).toBe(raw);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it('rejects invalid UTF-8 in the frozen question file before evaluating any row', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from(
        JSON.stringify({ ...f.dataset, name: 'dataset-�' }),
      ),
      at = bytes.indexOf(Buffer.from('�'));
    await writeFile(
      f.datasetPath,
      Buffer.concat([
        bytes.subarray(0, at),
        Buffer.from([0xff]),
        bytes.subarray(at + 3),
      ]),
    );
    await expect(runRetrievalEvaluation(f)).rejects.toThrow(/invalid UTF-8/);
    await expect(readFile(join(f.outputDir, 'report.json'))).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
