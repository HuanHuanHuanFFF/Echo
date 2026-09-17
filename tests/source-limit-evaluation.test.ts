import { retrievalSchema, retrievalOptions } from '../src/config.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { frozenQueryFetch } = await import(
  pathToFileURL(resolve('evals/lib/frozen-query-fetch.mjs')).href
);
const {
  sourceLimitRetrieval,
  checkedIndexState,
  experimentRetrieval,
  experimentMetadata,
  experimentBudget,
  budgetRequestPayload,
} = await import(
  pathToFileURL(resolve('evals/run-source-limit-comparison.mjs')).href
);
const endpoint = 'https://example.invalid/embeddings';
const options = (text = 'fixed', signal?: AbortSignal) => ({
  method: 'POST',
  redirect: 'error',
  body: JSON.stringify({
    model: 'fixture-model',
    dimensions: 2,
    encoding_format: 'float',
    input: [text],
  }),
  ...(signal ? { signal } : {}),
});
const payload = () => ({
  data: [{ index: 0, embedding: [0.1, 0.9] }],
  usage: { total_tokens: 7 },
});
const setup = (fetchFn: () => Promise<Response>) =>
  frozenQueryFetch({
    endpoint,
    model: 'fixture-model',
    dimensions: 2,
    fetchFn,
    validate: (body: ReturnType<typeof payload>) =>
      expect(body.data[0]?.embedding).toHaveLength(2),
  });
describe('single source-limit experiment', () => {
  it('runs only the explicitly requested joint condition without changing other values', () => {
    const base = retrievalSchema.parse({ rrf_k: 60, max_context_chars: 12000 });
    const joint = experimentRetrieval(base, 'rrf-budget-combined', 'joint');
    expect(joint).toEqual({ ...base, rrf_k: 30, max_context_chars: 16000 });
    expect(experimentMetadata('rrf-budget-combined').values).toEqual(['joint']);
    expect(experimentBudget(base, 'rrf-budget-combined', 'joint')).toBe(16000);
    expect(base.rrf_k).toBe(60);
    expect(base.max_context_chars).toBe(12000);
  });
  it.each([
    ['rrf-k', 'rrf_k', 30],
    ['title-weight', 'title_weight', 1],
    ['dense-threshold', 'min_dense_similarity', 0.25],
    ['context-budget', 'max_context_chars', 16000],
  ] as const)('isolates %s from the same baseline', (name, field, value) => {
    const base = retrievalSchema.parse({ rrf_k: 60, max_context_chars: 12000 }),
      before = structuredClone(base);
    const candidate = experimentRetrieval(base, name, value);
    expect(candidate).toEqual({ ...base, [field]: value });
    expect(base).toEqual(before);
    expect(candidate.max_chunks_per_source).toBe(3);
    expect(candidate.bm25_weight).toBe(0.5);
    expect(experimentBudget(base, name, value)).toBe(
      name === 'context-budget' ? 16000 : 12000,
    );
    expect(experimentMetadata(name).authorization).toContain(field);
  });
  it('permits per-request response-budget overrides without mutating defaults', () => {
    const base = retrievalSchema.parse({});
    const result = retrievalOptions(base, { max_context_chars: 20000 });
    expect(result.max_context_chars).toBe(20000);
    expect(base.max_context_chars).toBe(16000);
    expect(result.topk).toBe(10);
    expect(result.max_chunks_per_source).toBe(3);
  });
  it('checks the total request plus response budget and permits only its derived override', () => {
    const payload = {
      queries: [{ query_id: 'a', text: 'same frozen subquestion' }],
    };
    const a = { ...payload, overrides: { max_context_chars: 11800 } },
      b = { ...payload, overrides: { max_context_chars: 15800 } };
    expect(budgetRequestPayload(a, 12000)).toEqual(
      budgetRequestPayload(b, 16000),
    );
    expect(() => budgetRequestPayload(b, 12000)).toThrow();
    expect(() =>
      budgetRequestPayload(
        { ...a, overrides: { max_context_chars: 11800, topk: 20 } },
        12000,
      ),
    ).toThrow();
  });
  it('preserves source-limit output fields and labels each experiment accurately', () => {
    const source = experimentMetadata('source-limit'),
      weight = experimentMetadata('bm25-weight');
    expect(source.limits).toEqual([3, 4]);
    expect(source.values).toEqual([3, 4]);
    expect(source.authorization).toContain('source limit 3 versus 4');
    expect(source.authorization).not.toContain('BM25');
    expect(weight.values).toEqual([0.5, 0.25]);
    expect(weight.limits).toBeUndefined();
    expect(weight.authorization).toContain('retaining source limit 3');
  });
  it('changes only BM25 weight while retaining source limit three and dense weight one', () => {
    const base = {
      max_chunks_per_source: 3,
      bm25_weight: 0.5,
      dense_weight: 1,
      topk: 10,
      rrf_k: 60,
    };
    expect(experimentRetrieval(base, 'bm25-weight', 0.25)).toEqual({
      ...base,
      bm25_weight: 0.25,
    });
    expect(experimentRetrieval(base, 'source-limit', 4)).toEqual({
      ...base,
      max_chunks_per_source: 4,
    });
    expect(() =>
      experimentRetrieval(
        { ...base, max_chunks_per_source: 4 },
        'bm25-weight',
        0.25,
      ),
    ).toThrow();
    expect(() => experimentRetrieval(base, 'bm25-weight', 0.75)).toThrow();
  });
  it('uses verified seeds offline, remains immutable, and rejects missing queries before fetching', async () => {
    const digest = (s: string) => createHash('sha256').update(s).digest('hex');
    const request = JSON.parse(options().body);
    const response = payload();
    const seed = {
      key: digest(endpoint + '\n' + JSON.stringify(request)),
      request,
      response,
      vector_sha256: digest(JSON.stringify(response.data)),
    };
    let network = 0;
    const memo = frozenQueryFetch({
      endpoint,
      model: 'fixture-model',
      dimensions: 2,
      seeds: [seed],
      offlineOnly: true,
      fetchFn: async () => {
        network++;
        throw Error('Must never fetch');
      },
      validate: () => {},
    });
    const fetch = memo.forRun('weight-test', new Set(['fixed', 'missing']));
    response.data[0]!.embedding[0] = 999;
    const replayed = await (await fetch(endpoint, options())).json();
    expect(replayed.data[0].embedding[0]).toBe(0.1);
    expect(replayed.usage.total_tokens).toBe(0);
    await expect(fetch(endpoint, options('missing'))).rejects.toThrow(
      'network disabled',
    );
    expect(network).toBe(0);
    expect(memo.stats()).toMatchObject({
      logical_requests: 1,
      reused_responses: 1,
      seeded_responses: 1,
      network_requests: 0,
      network_reported_tokens: 0,
    });
  });
  it('rejects a corrupt seed before allowing replay', () => {
    const request = JSON.parse(options().body);
    const seed = {
      key: 'invalid',
      request,
      response: payload(),
      vector_sha256: 'invalid',
    };
    expect(() =>
      frozenQueryFetch({
        endpoint,
        model: 'fixture-model',
        dimensions: 2,
        seeds: [seed],
        offlineOnly: true,
        fetchFn: async () => Response.json(payload()),
        validate: () => {},
      }),
    ).toThrow();
  });
  it('accepts each verified config revision while preserving all actual index fields', () => {
    const left = { revision: 'config-3', ready: true, sources: 10, chunks: 20 };
    const right = { ...left, revision: 'config-4' };
    expect(checkedIndexState(left, 'config-3')).toEqual(
      checkedIndexState(right, 'config-4'),
    );
    expect(() => checkedIndexState(right, 'config-3')).toThrow();
    expect(checkedIndexState({ ...right, chunks: 21 }, 'config-4')).not.toEqual(
      checkedIndexState(left, 'config-3'),
    );
  });
  it('changes only the source limit and preserves the input config', () => {
    const base = {
      mode: 'hybrid',
      topk: 10,
      max_chunks_per_source: 3,
      bm25_weight: 0.5,
      dense_weight: 1,
    };
    expect(sourceLimitRetrieval(base, 4)).toEqual({
      ...base,
      max_chunks_per_source: 4,
    });
    expect(base.max_chunks_per_source).toBe(3);
    expect(() => sourceLimitRetrieval(base, 5)).toThrow();
  });
  it('replays actual captured vectors while recording zero new service tokens', async () => {
    let calls = 0;
    const memo = setup(async () => {
      calls++;
      return Response.json(payload());
    });
    const a = memo.forRun('3', new Set(['fixed']));
    const b = memo.forRun('4', new Set(['fixed']));
    const first = await (await a(endpoint, options())).json();
    const second = await (await b(endpoint, options())).json();
    expect(first.data).toEqual(second.data);
    expect(first.usage.total_tokens).toBe(7);
    expect(second.usage.total_tokens).toBe(0);
    expect(calls).toBe(1);
    expect(memo.stats()).toMatchObject({
      logical_requests: 2,
      network_requests: 1,
      reused_responses: 1,
      network_reported_tokens: 7,
    });
  });
  it('coalesces concurrent duplicate requests into one external call', async () => {
    let calls = 0;
    const memo = setup(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return Response.json(payload());
    });
    const fetch = memo.forRun('3', new Set(['fixed']));
    const responses = await Promise.all([
      fetch(endpoint, options()),
      fetch(endpoint, options()),
    ]);
    const values = await Promise.all(responses.map((r) => r.json()));
    expect(values[0].data).toEqual(values[1].data);
    expect(calls).toBe(1);
    expect(memo.stats().reused_responses).toBe(1);
  });
  it('checks the current run whitelist and destination even for cached responses', async () => {
    let calls = 0;
    const memo = setup(async () => {
      calls++;
      return Response.json(payload());
    });
    await memo.forRun('allowed', new Set(['fixed']))(endpoint, options());
    await expect(
      memo.forRun('different', new Set(['other']))(endpoint, options()),
    ).rejects.toThrow('Query not allowed');
    await expect(
      memo.forRun('allowed', new Set(['fixed']))(
        'https://other.invalid',
        options(),
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('does not silently retry a failed API request', async () => {
    let calls = 0;
    const memo = setup(async () => {
      calls++;
      return new Response('', { status: 503 });
    });
    const fetch = memo.forRun('3', new Set(['fixed']));
    await expect(fetch(endpoint, options())).rejects.toThrow('503');
    await expect(fetch(endpoint, options())).rejects.toThrow('503');
    expect(calls).toBe(1);
    expect(memo.stats().network_reported_tokens).toBeNull();
  });
  it('honors cancellation before a cache hit is returned', async () => {
    const memo = setup(async () => Response.json(payload()));
    const fetch = memo.forRun('3', new Set(['fixed']));
    await fetch(endpoint, options());
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetch(endpoint, options('fixed', controller.signal)),
    ).rejects.toThrow();
    expect(memo.stats().logical_requests).toBe(1);
  });
});
