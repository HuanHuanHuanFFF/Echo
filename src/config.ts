import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { ProfileSnapshot } from './profile-types.js';

const positive = (max: number) => z.number().int().min(1).max(max);
const retrievalFields = {
  mode: z.enum(['hybrid', 'bm25', 'dense']).describe('Retrieval lanes to run.'),
  lexical_engine: z
    .enum(['minisearch', 'sqlite'])
    .describe('Local keyword engine; both use the selected tokenizer.'),
  minisearch_k: z
    .number()
    .positive()
    .max(100)
    .describe('MiniSearch term-frequency saturation.'),
  minisearch_b: z
    .number()
    .min(0)
    .max(1)
    .describe('MiniSearch document-length normalization.'),
  minisearch_d: z
    .number()
    .min(0)
    .max(100)
    .describe('MiniSearch lower-bound term-frequency boost.'),
  topk: positive(100).describe(
    'Maximum chunks across all queries; not a target count.',
  ),
  max_chunks_per_source: positive(100).describe(
    'Maximum chunks from one source across all queries, also bounded by topk.',
  ),
  bm25_candidates: positive(1000).describe(
    'Keyword candidates per query expression before fusion.',
  ),
  dense_candidates: positive(1000).describe(
    'Vector candidates per query expression before fusion.',
  ),
  rrf_k: positive(1000).describe('RRF rank smoothing constant.'),
  title_weight: z
    .number()
    .min(0)
    .max(20)
    .describe('Keyword title weight; body weight is 1.'),
  bm25_weight: z
    .number()
    .min(0)
    .max(10)
    .describe('Keyword lane weight in hybrid RRF, not a probability.'),
  dense_weight: z
    .number()
    .min(0)
    .max(10)
    .describe('Vector lane weight in hybrid RRF, not a probability.'),
  max_context_chars: positive(100000)
    .min(256)
    .describe(
      'Maximum UTF-16 characters in the complete compact response JSON, including metadata. Not tokens.',
    ),
  min_dense_similarity: z
    .number()
    .min(-1)
    .max(1)
    .describe(
      'Minimum cosine similarity for vector candidates; not answer confidence.',
    ),
};
export const retrievalOverridesSchema = z
  .object(retrievalFields)
  .partial()
  .strict()
  .describe(
    'Only supplied fields override the active retrieval configuration. Omitted fields keep configured values. The two lane weights cannot both be zero after merging.',
  );
export const retrievalSchema = z
  .object({
    mode: retrievalFields.mode.default('hybrid'),
    lexical_engine: retrievalFields.lexical_engine.default('minisearch'),
    minisearch_k: retrievalFields.minisearch_k.default(1.2),
    minisearch_b: retrievalFields.minisearch_b.default(0.7),
    minisearch_d: retrievalFields.minisearch_d.default(0.5),
    topk: retrievalFields.topk.default(10),
    max_chunks_per_source: retrievalFields.max_chunks_per_source.default(6),
    bm25_candidates: retrievalFields.bm25_candidates.default(60),
    dense_candidates: retrievalFields.dense_candidates.default(60),
    rrf_k: retrievalFields.rrf_k.default(10),
    title_weight: retrievalFields.title_weight.default(2),
    bm25_weight: retrievalFields.bm25_weight.default(0.5),
    dense_weight: retrievalFields.dense_weight.default(1),
    max_context_chars: retrievalFields.max_context_chars.default(20000),
    min_dense_similarity: retrievalFields.min_dense_similarity.default(0.3),
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
            include: z.array(z.string().min(1)).optional(),
            exclude: z.array(z.string().min(1)).optional(),
            max_file_bytes: positive(1024 * 1024 * 1024).optional(),
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
    runtime: z
      .object({
        search_timeout_ms: positive(600000).default(120000),
        max_concurrent_searches: positive(8).default(2),
        sqlite_busy_timeout_ms: z.number().int().min(0).max(600000).optional(),
      })
      .strict()
      .default({ search_timeout_ms: 120000, max_concurrent_searches: 2 }),
    logging: z
      .object({
        level: z
          .enum(['off', 'error', 'warn', 'info', 'debug'])
          .default('warn'),
        file: z.string().min(1).optional(),
        max_file_bytes: positive(100 * 1024 * 1024).default(1048576),
        retain: positive(20).default(3),
      })
      .strict()
      .default({ level: 'warn', max_file_bytes: 1048576, retain: 3 }),
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
export type EchoConfig = z.infer<typeof configSchema> & {
  profile?: ProfileSnapshot;
};
export type RetrievalConfig = z.infer<typeof retrievalSchema>;
export function parseConfig(value: unknown): EchoConfig {
  return configSchema.parse(value);
}
export function retrievalOptions(
  base: RetrievalConfig,
  overrides: unknown = {},
): RetrievalConfig {
  const partial = retrievalOverridesSchema.parse(overrides);
  return retrievalSchema.parse({ ...base, ...partial });
}
export async function loadConfig(path: string): Promise<EchoConfig> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (raw && typeof raw === 'object' && 'version' in raw && raw.version === 2)
    return (await import('./profiles.js')).loadProfileConfig(path);
  const config = parseConfig(raw);
  const base = dirname(resolve(path));
  const absolute = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  config.database = absolute(config.database);
  config.collections = config.collections.map((c) => ({
    ...c,
    root: absolute(c.root),
  }));
  if (config.logging.file) config.logging.file = absolute(config.logging.file);
  if (config.chunker.module)
    config.chunker.module = absolute(config.chunker.module);
  return config;
}
