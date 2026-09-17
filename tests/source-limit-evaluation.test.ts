import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { frozenQueryFetch } = await import(
  pathToFileURL(resolve('evals/lib/frozen-query-fetch.mjs')).href
);
const { sourceLimitRetrieval } = await import(
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
