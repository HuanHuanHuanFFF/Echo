import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const positive = (max: number) => z.number().int().min(1).max(max);
export const retrievalSchema = z
  .object({
    mode: z.enum(['hybrid', 'bm25', 'dense']).default('hybrid'),
    topk: positive(100).default(8),
    max_chunks_per_source: positive(100).default(2),
    bm25_candidates: positive(1000).default(60),
    dense_candidates: positive(1000).default(60),
    rrf_k: positive(1000).default(60),
    title_weight: z.number().min(0).max(20).default(2),
    bm25_weight: z.number().min(0).max(10).default(1),
    dense_weight: z.number().min(0).max(10).default(1),
    max_context_chars: positive(100000).min(256).default(12000),
    min_dense_similarity: z.number().min(-1).max(1).default(0.3),
  })
  .strict()
  .refine(
    (v) => v.bm25_weight + v.dense_weight > 0,
    'At least one retrieval weight must be positive',
  );
const embeddingSchema = z
  .object({
    provider: z.literal('http').default('http'),
    model: z.string().min(1).optional(),
    dimensions: positive(8192).optional(),
    base_url: z.url().optional(),
    api_key_env: z.string().min(1).default('ECHO_EMBEDDING_API_KEY'),
    timeout_ms: positive(600000).default(30000),
    batch_size: positive(128).default(8),
    document_prefix: z.string().max(2000).default(''),
    query_prefix: z.string().max(2000).default(''),
    send_dimensions: z.boolean().default(true),
  })
  .strict();
const lexicalSchema = z
  .object({
    locale: z
      .string()
      .min(2)
      .max(50)
      .refine((v) => {
        try {
          return Intl.getCanonicalLocales(v).length === 1;
        } catch {
          return false;
        }
      }, 'Invalid locale')
      .default('zh-CN'),
    dictionary: z.array(z.string().min(1).max(200)).max(1000).default([]),
  })
  .strict();
const configSchema = z
  .object({
    database: z.string().min(1).default('.echo/index.sqlite'),
    collections: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            root: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    chunker: z
      .object({
        module: z.string().min(1).optional(),
        version: z.string().min(1).default('1'),
        options: z.record(z.string(), z.unknown()).default({ max_chars: 1000 }),
      })
      .strict()
      .default({ version: '1', options: { max_chars: 1000 } }),
    embedding: embeddingSchema.default(embeddingSchema.parse({})),
    lexical: lexicalSchema.default(lexicalSchema.parse({})),
    retrieval: retrievalSchema.default(retrievalSchema.parse({})),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.collections.map((c) => c.id)).size !== v.collections.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate collection id',
        path: ['collections'],
      });
  });
export type EchoConfig = z.infer<typeof configSchema>;
export type RetrievalConfig = z.infer<typeof retrievalSchema>;
export function parseConfig(value: unknown): EchoConfig {
  return configSchema.parse(value);
}
export function retrievalOptions(
  base: RetrievalConfig,
  overrides: unknown = {},
): RetrievalConfig {
  const partial = z.record(z.string(), z.unknown()).parse(overrides);
  return retrievalSchema.parse({ ...base, ...partial });
}
export async function loadConfig(path: string): Promise<EchoConfig> {
  const config = parseConfig(JSON.parse(await readFile(path, 'utf8')));
  const base = dirname(resolve(path));
  const absolute = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  config.database = absolute(config.database);
  config.collections = config.collections.map((c) => ({
    ...c,
    root: absolute(c.root),
  }));
  if (config.chunker.module)
    config.chunker.module = absolute(config.chunker.module);
  return config;
}
