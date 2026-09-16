import type { EchoConfig } from './config.js';
import type { EmbeddingProvider } from './contracts.js';
import { hash } from './identity.js';

export function validateVectors(
  value: unknown,
  count: number,
  dimensions: number,
): number[][] {
  if (!Array.isArray(value) || value.length !== count)
    throw new Error('Embedding response count mismatch');
  return value.map((vector) => {
    if (
      !Array.isArray(vector) ||
      vector.length !== dimensions ||
      vector.some((n) => typeof n !== 'number' || !Number.isFinite(n))
    )
      throw new Error('Embedding response has invalid dimensions or values');
    const scale = Math.max(...(vector as number[]).map(Math.abs));
    if (scale === 0)
      throw new Error('Embedding response has zero or invalid norm');
    const scaled = (vector as number[]).map((value) => value / scale);
    const norm = Math.hypot(...scaled);
    return Array.from(new Float32Array(scaled.map((value) => value / norm)));
  });
}
export function embeddingFingerprint(config: EchoConfig['embedding']): string {
  const { base_url: baseUrl, model, dimensions } = config;
  if (!baseUrl || !model || !dimensions)
    throw new Error(
      'Embedding not configured: set base_url, model and dimensions',
    );
  const endpoint = new URL(baseUrl.replace(/\/$/, '') + '/embeddings');
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      'Embedding base_url must be an HTTP(S) URL without credentials, query or fragment',
    );
  return hash(
    JSON.stringify({
      vector_transform: 'unit-float32-v1',
      endpoint: endpoint.href,
      model,
      dimensions,
      sendDimensions: config.send_dimensions,
      documentPrefix: config.document_prefix,
      queryPrefix: config.query_prefix,
    }),
  );
}
export function createEmbeddingProvider(
  config: EchoConfig['embedding'],
): EmbeddingProvider {
  const { base_url: baseUrl, model, dimensions } = config;
  if (!baseUrl || !model || !dimensions)
    throw new Error(
      'Embedding not configured: set base_url, model and dimensions',
    );
  const key = process.env[config.api_key_env];
  if (!key)
    throw new Error(
      'Embedding key missing: set environment variable ' + config.api_key_env,
    );
  const endpoint = new URL(baseUrl.replace(/\/$/, '') + '/embeddings');
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      'Embedding base_url must be an HTTP(S) URL without credentials, query or fragment',
    );
  const usage = { requests: 0, texts: 0, input_chars: 0 };
  let knownUsageRequests = 0,
    reportedTokens = 0;
  return {
    usage: () => ({
      ...usage,
      reported_tokens:
        knownUsageRequests === usage.requests ? reportedTokens : null,
    }),
    dimensions,
    fingerprint: embeddingFingerprint(config),
    async embed(texts, purpose, signal) {
      const vectors: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += config.batch_size) {
        signal?.throwIfAborted();
        const batch = texts.slice(offset, offset + config.batch_size);
        const prefix =
          purpose === 'query' ? config.query_prefix : config.document_prefix;
        const timeout = AbortSignal.timeout(config.timeout_ms);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        usage.requests++;
        usage.texts += batch.length;
        usage.input_chars += batch.reduce(
          (sum, text) => sum + prefix.length + text.length,
          0,
        );
        const response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: combined,
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + key,
          },
          body: JSON.stringify({
            model,
            input: batch.map((text) => prefix + text),
            encoding_format: 'float',
            ...(config.send_dimensions ? { dimensions } : {}),
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            'Embedding API HTTP ' +
              response.status +
              '; check endpoint, model and key',
          );
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          combined.throwIfAborted();
          throw new Error(
            'Embedding response is not valid JSON; check the model service',
          );
        }
        if (
          body &&
          typeof body === 'object' &&
          'usage' in body &&
          body.usage &&
          typeof body.usage === 'object' &&
          'total_tokens' in body.usage &&
          typeof body.usage.total_tokens === 'number' &&
          Number.isSafeInteger(body.usage.total_tokens) &&
          body.usage.total_tokens >= 0
        ) {
          knownUsageRequests++;
          reportedTokens += body.usage.total_tokens;
        }
        if (
          !body ||
          typeof body !== 'object' ||
          !('data' in body) ||
          !Array.isArray(body.data)
        )
          throw new Error('Invalid embedding API response');
        const ordered: unknown[] = new Array(batch.length);
        const seen = new Set<number>();
        for (const row of body.data) {
          if (
            !row ||
            typeof row !== 'object' ||
            !Number.isInteger(row.index) ||
            row.index < 0 ||
            row.index >= batch.length ||
            seen.has(row.index)
          )
            throw new Error('Invalid embedding response index');
          seen.add(row.index);
          ordered[row.index] = row.embedding;
        }
        if (seen.size !== batch.length)
          throw new Error('Embedding response count mismatch');
        vectors.push(...validateVectors(ordered, batch.length, dimensions));
      }
      return vectors;
    },
  };
}
