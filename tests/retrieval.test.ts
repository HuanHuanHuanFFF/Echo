import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { parseConfig } from '../src/config.js';
import type { EmbeddingProvider } from '../src/contracts.js';
import { createEmbeddingProvider, validateVectors } from '../src/embedding.js';
import { tokenize } from '../src/lexical.js';
import { syncIndex } from '../src/sync.js';
import { searchIndex } from '../src/retrieval.js';
import { openDatabase } from '../src/database.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const mock: EmbeddingProvider = {
  fingerprint: 'test-one-hot-v1',
  dimensions: 3,
  async embed(texts) {
    return texts.map((t) =>
      t.includes('苹果') || t.includes('fruitA')
        ? [1, 0, 0]
        : t.includes('香蕉')
          ? [0, 1, 0]
          : [0, 0, 1],
    );
  },
};
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'echo-search-')));
  dirs.push(dir);
  const root = join(dir, 'notes');
  await mkdir(root);
  const config = parseConfig({
    database: join(dir, 'index.sqlite'),
    collections: [{ id: 'test', root }],
    retrieval: { mode: 'bm25' },
  });
  await writeFile(
    join(root, 'a.md'),
    '# 苹果\n苹果是水果。\n## 保存\n苹果低温保存。\n## 价格\n苹果价格是示例。',
  );
  await writeFile(join(root, 'b.md'), '# 香蕉\n香蕉含有淀粉。');
  await writeFile(
    join(root, 'state.md'),
    '# 状态机\n状态迁移由 Guard 检查，RouterRegistryHandler 分发工具。',
  );
  await syncIndex(config, undefined, mock);
  return { dir, root, config };
}
it('uses local Chinese and identifier tokens without an API', () => {
  const config = parseConfig({});
  const title = new Set(
    tokenize('状态机 RouterRegistryHandler echo_id', config.lexical),
  );
  expect(tokenize('状态机', config.lexical).some((t) => title.has(t))).toBe(
    true,
  );
  expect(tokenize('registry', config.lexical).some((t) => title.has(t))).toBe(
    true,
  );
  expect(tokenize('echo_id', config.lexical).some((t) => title.has(t))).toBe(
    true,
  );
});
it('compares BM25/dense/hybrid, preserves raw locations and enforces both caps', async () => {
  const { config, root } = await fixture();
  const lexical = await searchIndex(config, {
    query: '苹果',
    overrides: { mode: 'bm25', topk: 10, max_chunks_per_source: 1 },
  });
  expect(lexical.results).toHaveLength(1);
  const dense = await searchIndex(
    config,
    {
      query: 'fruitA',
      overrides: { mode: 'dense', topk: 2, max_chunks_per_source: 10 },
    },
    undefined,
    mock,
  );
  expect(dense.results).toHaveLength(2);
  const hybrid = await searchIndex(
    config,
    {
      query: '苹果',
      overrides: { mode: 'hybrid', topk: 10, max_chunks_per_source: 2 },
    },
    undefined,
    mock,
  );
  expect(hybrid.results).toHaveLength(2);
  expect(hybrid.queries[0]!.candidates).toMatchObject({
    bm25: 3,
    dense: 3,
    fused: 3,
  });
  for (const e of hybrid.results)
    expect(
      (await readFile(e.path, 'utf8'))
        .split(/\r?\n/)
        .slice(e.start_line - 1, e.end_line)
        .join('\n'),
    ).toBe(e.text);
  expect(hybrid.results.every((e) => e.path === join(root, 'a.md'))).toBe(true);
});
it('filters before candidate limits and keeps empty scopes empty', async () => {
  const { config } = await fixture();
  const result = await searchIndex(
    config,
    {
      query: 'fruitA',
      filters: { path_prefix: 'state' },
      overrides: {
        mode: 'dense',
        dense_candidates: 1,
        min_dense_similarity: -1,
      },
    },
    undefined,
    mock,
  );
  expect(result.results).toHaveLength(1);
  expect(result.results[0]!.relative_path).toBe('state.md');
  expect(
    (
      await searchIndex(
        config,
        { query: '苹果', filters: { collections: [] } },
        undefined,
        mock,
      )
    ).results,
  ).toEqual([]);
  expect(
    (
      await searchIndex(
        config,
        { query: '苹果', filters: { collections: ['missing'] } },
        undefined,
        mock,
      )
    ).results,
  ).toEqual([]);
});
it('bounds the entire serialized result, exposes budget/source exclusions, and rejects invalid overrides', async () => {
  const { config } = await fixture();
  const result = await searchIndex(
    config,
    {
      query: '苹果',
      overrides: {
        max_context_chars: 1300,
        topk: 10,
        max_chunks_per_source: 10,
      },
    },
    undefined,
    mock,
  );
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(1300);
  expect(result.excluded.budget).toBeGreaterThan(0);
  await expect(
    searchIndex(
      config,
      { query: '苹果', overrides: { topk: 0 } },
      undefined,
      mock,
    ),
  ).rejects.toThrow();
  await expect(
    searchIndex(
      config,
      { query: '苹果', overrides: { typo: 1 } },
      undefined,
      mock,
    ),
  ).rejects.toThrow();
});
it('distinguishes empty lexical hits from failed dense retrieval, and marks hybrid fallback', async () => {
  const { config } = await fixture();
  expect(
    (await searchIndex(config, { query: 'xyzUnseen' })).queries[0]!.status,
  ).toBe('empty');
  const unavailable: EmbeddingProvider = {
    ...mock,
    async embed() {
      throw new Error('injected model unavailable');
    },
  };
  const hybrid = await searchIndex(
    config,
    { query: '苹果', overrides: { mode: 'hybrid' } },
    undefined,
    unavailable,
  );
  expect(hybrid.queries[0]!.status).toBe('partial_failure');
  expect(hybrid.results.length).toBeGreaterThan(0);
  const dense = await searchIndex(
    config,
    { query: '苹果', overrides: { mode: 'dense' } },
    undefined,
    unavailable,
  );
  expect(dense.queries[0]!.status).toBe('error');
  expect(dense.results).toEqual([]);
});
it('rolls back both retrieval lanes on embedding failure and rebuilds model/tokenizer changes', async () => {
  const { config, root } = await fixture();
  const before = await searchIndex(
    config,
    { query: '苹果', overrides: { mode: 'hybrid' } },
    undefined,
    mock,
  );
  await writeFile(
    join(root, 'a.md'),
    (await readFile(join(root, 'a.md'), 'utf8')).replace(
      '苹果是水果',
      '苹果是新内容',
    ),
  );
  await expect(
    syncIndex(config, undefined, {
      ...mock,
      async embed() {
        throw new Error('model failed');
      },
    }),
  ).rejects.toThrow('model failed');
  expect(
    (
      await searchIndex(
        config,
        { query: '苹果', overrides: { mode: 'hybrid' } },
        undefined,
        mock,
      )
    ).results,
  ).toEqual(before.results);
  const next = { ...mock, fingerprint: 'model-v2' };
  await syncIndex(config, undefined, next);
  expect(
    (
      await searchIndex(
        config,
        { query: '苹果', overrides: { mode: 'dense' } },
        undefined,
        mock,
      )
    ).queries[0]!.status,
  ).toBe('error');
  config.lexical.dictionary = ['RouterRegistryHandler'];
  await expect(searchIndex(config, { query: '苹果' })).rejects.toThrow(
    'Lexical configuration differs',
  );
  await syncIndex(config, undefined, next);
  const db = openDatabase(config.database);
  try {
    expect(db.prepare('SELECT count(*) n FROM embeddings').get()).toEqual(
      db.prepare('SELECT count(*) n FROM chunks').get(),
    );
  } finally {
    db.close();
  }
});
it('validates vector count, dimensions, nonfinite and zero values', () => {
  for (const value of [[], [[1]], [[0, 0]], [[NaN, 1]], [[Infinity, 1]]])
    expect(() => validateVectors(value, 1, 2)).toThrow();
});
it('calls a real local HTTP server with the configured key, handles ordering, and propagates timeout', async () => {
  let requestBody: { input: string[]; model: string } | undefined,
    authorization: string | undefined;
  const server = createServer((req, res) => {
    if (req.url?.includes('stall')) return;
    const chunks: Buffer[] = [];
    req.on('data', (d) => chunks.push(d as Buffer));
    req.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString()) as {
        input: string[];
        model: string;
      };
      authorization = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: requestBody.input
            .map((_, index) => ({
              index,
              embedding: index === 0 ? [1, 0] : [0, 1],
            }))
            .reverse(),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No server address');
  const env = 'ECHO_TEST_EMBEDDING_KEY';
  process.env[env] = 'isolated-test-key';
  try {
    const cfg = parseConfig({
      embedding: {
        base_url: 'http://127.0.0.1:' + address.port + '/v1',
        model: 'test',
        dimensions: 2,
        api_key_env: env,
        timeout_ms: 1000,
      },
    });
    const provider = createEmbeddingProvider(cfg.embedding);
    expect(await provider.embed(['a', 'b'], 'document')).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(authorization).toBe('Bearer isolated-test-key');
    expect(requestBody?.model).toBe('test');
    cfg.embedding.base_url = 'http://127.0.0.1:' + address.port + '/stall';
    cfg.embedding.timeout_ms = 20;
    await expect(
      createEmbeddingProvider(cfg.embedding).embed(['a'], 'query'),
    ).rejects.toThrow();
  } finally {
    delete process.env[env];
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('reports exact weighted RRF contributions for returned evidence', async () => {
  const { config } = await fixture();
  const result = await searchIndex(
    config,
    {
      query: '苹果',
      overrides: {
        mode: 'hybrid',
        bm25_weight: 2,
        dense_weight: 0.5,
        rrf_k: 20,
      },
    },
    undefined,
    mock,
  );
  for (const evidence of result.results) {
    const rank = evidence.rankings![0]!;
    expect(rank.rrf_score).toBeCloseTo(
      2 / (20 + rank.bm25_rank!) + 0.5 / (20 + rank.dense_rank!),
      12,
    );
  }
});
it('deletes both retrieval indexes together and rejects malformed scopes', async () => {
  const { config, root } = await fixture();
  await rm(join(root, 'a.md'));
  await syncIndex(config, undefined, mock);
  expect(
    (
      await searchIndex(
        config,
        { query: '苹果', overrides: { mode: 'hybrid' } },
        undefined,
        mock,
      )
    ).results,
  ).toEqual([]);
  const db = openDatabase(config.database);
  try {
    expect(db.prepare('SELECT count(*) n FROM chunk_fts').get()).toEqual(
      db.prepare('SELECT count(*) n FROM chunks').get(),
    );
  } finally {
    db.close();
  }
  await expect(
    searchIndex(config, {
      query: 'x',
      filters: { source_ids: ['not-a-uuid'] },
    }),
  ).rejects.toThrow();
  await expect(
    searchIndex(config, { query: 'x', filters: { unknown: true } }),
  ).rejects.toThrow();
});

it('reads the previous committed snapshot while another connection prepares a sync', async () => {
  const { config } = await fixture();
  const writer = openDatabase(config.database);
  writer.exec('BEGIN IMMEDIATE');
  try {
    const before = Date.now();
    const result = await searchIndex(config, { query: '苹果' });
    expect(result.results.length).toBeGreaterThan(0);
    expect(Date.now() - before).toBeLessThan(1000);
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
});

it('treats uppercase and lowercase UUID filters as the same identity', async () => {
  const { config, root } = await fixture();
  const id = 'ABCDEFAB-1234-4ABC-8ABC-ABCDEFABCDEF';
  await writeFile(
    join(root, 'upper.md'),
    '---\necho_id: ' + id + '\n---\n# 苹果\n苹果规范化样本',
  );
  await syncIndex(config, undefined, mock);
  const lower = await searchIndex(config, {
    query: '苹果',
    filters: { source_ids: [id.toLowerCase()] },
  });
  const upper = await searchIndex(config, {
    query: '苹果',
    filters: { source_ids: [id] },
  });
  expect(lower.results).toHaveLength(1);
  expect(upper.results).toEqual(lower.results);
});
it('reports complete dense failure as error at the top level', async () => {
  const { config } = await fixture();
  const broken = {
    ...mock,
    async embed(): Promise<number[][]> {
      throw new Error('model unavailable');
    },
  };
  expect(
    (
      await searchIndex(
        config,
        { query: '苹果', overrides: { mode: 'dense' } },
        undefined,
        broken,
      )
    ).status,
  ).toBe('error');
});
it.each([1e30, 1e-30])(
  'normalizes extreme vector magnitude before SQLite cosine: %s',
  async (magnitude) => {
    const vector = validateVectors([[magnitude, 0]], 1, 2)[0]!;
    const db = openDatabase(':memory:');
    try {
      expect(
        db
          .prepare('SELECT vec_distance_cosine(?,?) AS d')
          .get(new Float32Array(vector), new Float32Array(vector)),
      ).toEqual({ d: 0 });
    } finally {
      db.close();
    }
  },
);

it.each([1e30, 1e-30])(
  'retrieves equal extreme vectors after a complete sync: %s',
  async (magnitude) => {
    const { config } = await fixture();
    const provider: EmbeddingProvider = {
      fingerprint: 'extreme-' + magnitude,
      dimensions: 2,
      async embed(texts) {
        return texts.map(() => [magnitude, 0]);
      },
    };
    await syncIndex(config, undefined, provider);
    const result = await searchIndex(
      config,
      {
        query: 'same vector',
        overrides: {
          mode: 'dense',
          topk: 100,
          max_chunks_per_source: 100,
          min_dense_similarity: 0.999,
        },
      },
      undefined,
      provider,
    );
    expect(result.results).toHaveLength(5);
    expect(result.queries[0]!.status).toBe('ok');
  },
);
