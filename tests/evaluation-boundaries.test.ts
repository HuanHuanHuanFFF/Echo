import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { corpusSnapshot, runEvaluation } from '../src/evaluation.js';

it('fingerprints every recursively indexed Markdown file, including uppercase extensions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-corpus-hash-'));
  try {
    await mkdir(join(dir, 'nested'));
    await writeFile(
      join(dir, 'a.md'),
      '---\necho_id: 10000000-0000-4000-8000-000000000001\n---\n# A',
    );
    await writeFile(
      join(dir, 'nested', 'b.MD'),
      '---\necho_id: 10000000-0000-4000-8000-000000000002\n---\n# B',
    );
    const before = await corpusSnapshot(dir);
    expect(Object.keys(before)).toEqual(['a.md', 'nested/b.MD']);
    await writeFile(
      join(dir, 'nested', 'b.MD'),
      '---\necho_id: 10000000-0000-4000-8000-000000000002\n---\n# changed',
    );
    expect((await corpusSnapshot(dir))['nested/b.MD']).not.toBe(
      before['nested/b.MD'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Protocol-only fake vectors: these temporary outputs never establish semantic quality.
async function apiFixture(onFirstRequest?: (output: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'echo-eval-protocol-')),
    output = join(dir, 'run'),
    configPath = join(dir, 'profile.json');
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part) => parts.push(part as Buffer));
    req.on('end', () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(parts).toString()) as {
          input: string[];
        };
        requests.push(body);
        if (requests.length === 1) await onFirstRequest?.(output);
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
            usage: { total_tokens: 7 },
          }),
        );
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const key = 'ECHO_METADATA_PROTOCOL_KEY';
  process.env[key] = 'test-only';
  await writeFile(
    configPath,
    JSON.stringify({
      embedding: {
        base_url: 'http://127.0.0.1:' + address.port + '/v1',
        model: 'protocol-not-semantic',
        dimensions: 2,
        api_key_env: key,
        batch_size: 1,
        send_dimensions: false,
        timeout_ms: 4321,
      },
    }),
  );
  return {
    configPath,
    output,
    requests,
    async close() {
      delete process.env[key];
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
it('records the complete non-secret API request configuration and call cap', async () => {
  const fixture = await apiFixture();
  try {
    const { report } = await runEvaluation({
      lexicalOnly: false,
      configPath: fixture.configPath,
      outputDir: fixture.output,
      maxApiCalls: 80,
    });
    expect(report.profile.embedding).toMatchObject({
      batch_size: 1,
      send_dimensions: false,
      timeout_ms: 4321,
    });
    expect(report).toMatchObject({ api_request_limit: 80 });
    expect(fixture.requests.every((r) => r.dimensions === undefined)).toBe(
      true,
    );
    expect(JSON.stringify(report)).not.toContain('test-only');
  } finally {
    await fixture.close();
  }
});
it('does not publish a success marker when a required artifact cannot be written', async () => {
  const fixture = await apiFixture(async (output) => {
    await mkdir(join(output, 'vectors.json'));
  });
  try {
    await expect(
      runEvaluation({
        lexicalOnly: false,
        configPath: fixture.configPath,
        outputDir: fixture.output,
        maxApiCalls: 80,
      }),
    ).rejects.toThrow();
    expect(fixture.requests.length).toBeGreaterThan(10);
    await expect(
      readFile(join(fixture.output, 'report.json')).then(() => true),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      JSON.parse(await readFile(join(fixture.output, 'failure.json'), 'utf8'))
        .status,
    ).toBe('incomplete');
  } finally {
    await fixture.close();
  }
});

it('context reading retrieves a fact absent from the search chunk within the same cumulative budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-context-eval-'));
  try {
    const { report } = await runEvaluation({
      lexicalOnly: true,
      outputDir: dir,
      scenario: 'long-context',
      budgetChars: 8000,
    });
    const search = report.rows.find((row) => row.strategy === 'bm25_default')!;
    const read = report.rows.find(
      (row) => row.strategy === 'bm25_with_host_read',
    )!;
    expect(search.covered_facts).toEqual(['start']);
    expect(read.covered_facts).toEqual(['start', 'finish']);
    expect(read.reads.some((piece) => piece.text.includes('OMEGA'))).toBe(true);
    expect(read.total_context_chars).toBeLessThanOrEqual(8000);
    expect(read.total_context_chars).toBeGreaterThan(
      search.total_context_chars,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
