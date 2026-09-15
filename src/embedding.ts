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
  return {
    dimensions,
    fingerprint: hash(
      JSON.stringify({
        vector_transform: 'unit-float32-v1',
        endpoint: endpoint.href,
        model,
        dimensions,
        documentPrefix: config.document_prefix,
        queryPrefix: config.query_prefix,
      }),
    ),
    async embed(texts, purpose, signal) {
      const vectors: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += config.batch_size) {
        signal?.throwIfAborted();
        const batch = texts.slice(offset, offset + config.batch_size);
        const prefix =
          purpose === 'query' ? config.query_prefix : config.document_prefix;
        const timeout = AbortSignal.timeout(config.timeout_ms);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
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
        const body: unknown = await response.json();
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
