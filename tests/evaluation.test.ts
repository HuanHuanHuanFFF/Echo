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

it('stops before exceeding the authorized API call count and records failure usage', async () => {
  const { createServer } = await import('node:http');
  const { writeFile, readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'echo-eval-budget-'));
  let calls = 0;
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part) => parts.push(part as Buffer));
    req.on('end', () => {
      calls++;
      const input = (
        JSON.parse(Buffer.concat(parts).toString()) as { input: string[] }
      ).input;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: input.map((_, index) => ({ index, embedding: [1, 0] })),
          usage: { total_tokens: 7 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const key = 'ECHO_EVAL_PROTOCOL_KEY';
  process.env[key] = 'test-only';
  try {
    const configPath = join(dir, 'profile.json'),
      outputDir = join(dir, 'run');
    await writeFile(
      configPath,
      JSON.stringify({
        embedding: {
          base_url: 'http://127.0.0.1:' + address.port + '/v1',
          model: 'protocol-test',
          dimensions: 2,
          api_key_env: key,
        },
      }),
    );
    await expect(
      runEvaluation({
        lexicalOnly: false,
        configPath,
        outputDir,
        maxApiCalls: 1,
      }),
    ).rejects.toThrow('Authorized API request budget exhausted');
    expect(calls).toBe(1);
    const failure = JSON.parse(
      await readFile(join(outputDir, 'failure.json'), 'utf8'),
    ) as {
      status: string;
      api_usage: { requests: number; reported_tokens: number };
    };
    expect(failure.status).toBe('incomplete');
    expect(failure.api_usage).toMatchObject({
      requests: 1,
      reported_tokens: 7,
    });
  } finally {
    delete process.env[key];
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
