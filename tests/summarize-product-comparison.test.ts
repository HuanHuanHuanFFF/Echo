import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

const { summarizeProductComparison } = await import(
  pathToFileURL(path.resolve('evals/summarize-product-comparison.mjs')).href
);

const roots: string[] = [];
const conditions = ['echo', 'dify', 'khoj-dense', 'khoj-rerank'];
const scoreFiles = [
  'A-test.jsonl',
  'B-test.jsonl',
  'C-test.jsonl',
  'D-test.jsonl',
  'mixed-test.jsonl',
  'qasper.jsonl',
  'evidence-summary.json',
  'langchain-official-per-query.json',
  'godot-official-per-query.json',
  'du-official-per-query.json',
  'qasper-official-per-query.json',
  'official-public-summary.json',
];

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function makeIncompleteRoot(root: string): Promise<void> {
  const scopes = {
    'A-test': { questions: 50, answerable: 48, facts: 125 },
    'B-test': { questions: 35, answerable: 35, facts: 65 },
    'C-test': { questions: 25, answerable: 25, facts: 46 },
    'D-test': { questions: 30, answerable: 30, facts: 58 },
    'mixed-test': { questions: 60, answerable: 58, facts: 109 },
    qasper: { questions: 1005 },
    langchain: { questions: 203 },
    godot: { questions: 99 },
    du: { questions: 2000 },
  };
  const manifestBytes = Buffer.from(JSON.stringify({ scopes }));
  const indexBytes = Buffer.from('{}\n');
  await fs.mkdir(path.join(root, 'corpus-v1'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'corpus-v1', 'manifest.json'),
    manifestBytes,
  );
  await fs.writeFile(path.join(root, 'index-freeze.json'), indexBytes);
  await fs.writeFile(
    path.join(root, 'freeze.json'),
    JSON.stringify({
      status: 'frozen',
      corpus_manifest_sha256: hash(manifestBytes),
      index_freeze: { sha256: hash(indexBytes) },
      packing: { topk: 10, source_cap: 6, max_context_chars: 20000 },
      conditions: Object.fromEntries(
        conditions.map((condition) => [condition, { fixed_return_limit: 10 }]),
      ),
    }),
  );

  for (const condition of conditions.filter((name) => name !== 'dify')) {
    const directory = path.join(root, 'scores', condition);
    await fs.mkdir(directory, { recursive: true });
    await Promise.all(
      scoreFiles.map((name) => fs.writeFile(path.join(directory, name), '')),
    );
  }
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('product comparison summary readiness', () => {
  it('stays pending and writes no report when one condition is missing', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'comparison-summary-'),
    );
    roots.push(root);
    await makeIncompleteRoot(root);

    const result = await summarizeProductComparison(root);

    expect(result).toMatchObject({
      status: 'pending',
      reasons: [
        {
          code: 'score_files_missing',
          missing_count: scoreFiles.length,
        },
      ],
    });
    expect(result.reasons[0].sample).toContain('dify/A-test.jsonl');
    await expect(fs.access(path.join(root, 'analysis'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
