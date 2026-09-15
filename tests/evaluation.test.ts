import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coveredFacts, runEvaluation } from '../src/evaluation.js';

it('counts facts only from the labelled source and actual quoted text', () => {
  const facts = [{ id: 'a', source: 'a.md', text: 'required fact' }];
  expect(
    coveredFacts(['a'], facts, [
      { source: 'b.md', text: 'required fact', start_line: 1, end_line: 1 },
    ]),
  ).toEqual([]);
  expect(
    coveredFacts(['a'], facts, [
      { source: 'a.md', text: 'unrelated', start_line: 1, end_line: 1 },
    ]),
  ).toEqual([]);
  expect(
    coveredFacts(['a'], facts, [
      {
        source: 'a.md',
        text: 'the required fact is here',
        start_line: 1,
        end_line: 1,
      },
    ]),
  ).toEqual(['a']);
});
it('runs the full fixed lexical dataset without a model and enforces cumulative context budgets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-evaluation-'));
  try {
    const { report } = await runEvaluation({
      lexicalOnly: true,
      outputDir: dir,
      budgetChars: 8000,
    });
    expect(report.status).toBe('lexical_only');
    expect(report.api_usage).toBeNull();
    expect(report.rows).toHaveLength(42);
    for (const row of report.rows) {
      expect(row.total_context_chars).toBe(
        row.request_chars + row.search_chars + row.read_chars,
      );
      expect(row.total_context_chars).toBeLessThanOrEqual(8000);
    }
    expect(report.corpus_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(report.strategies).every((s) => s.errors === 0)).toBe(
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('requires an explicit API configuration and request budget for real evaluation', async () => {
  await expect(runEvaluation({ lexicalOnly: false })).rejects.toThrow(
    'Real evaluation requires',
  );
});
