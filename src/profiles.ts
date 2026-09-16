import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { parseConfig, type EchoConfig } from './config.js';
import { hash } from './identity.js';
import { defaultChunker } from './chunker.js';
import { tokenize, lexicalFingerprint } from './lexical.js';
import type { ChunkerInput, ChunkRange } from './contracts.js';
import type { StrategySnapshot } from './profile-types.js';

export const profileId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const activeSchema = z
  .object({
    chunker: profileId,
    tokenizer: profileId,
    embedding: profileId,
    retrieval: profileId,
  })
  .strict();
export const mainSchema = z
  .object({
    version: z.literal(2),
    database: z.string().min(1).default('.echo/index.sqlite'),
    active: activeSchema,
    directories: z
      .object({
        chunkers: z.string().min(1).default('chunkers'),
        tokenizers: z.string().min(1).default('tokenizers'),
        embedding: z.string().min(1).default('config/embedding'),
        retrieval: z.string().min(1).default('config/retrieval'),
      })
      .strict()
      .default({
        chunkers: 'chunkers',
        tokenizers: 'tokenizers',
        embedding: 'config/embedding',
        retrieval: 'config/retrieval',
      }),
    sources: z.string().min(1).default('config/sources.json'),
    runtime: z.string().min(1).default('config/runtime.json'),
    logging: z.string().min(1).default('config/logging.json'),
  })
  .strict();
export type MainConfig = z.infer<typeof mainSchema>;
export const defaultMain: MainConfig = mainSchema.parse({
  version: 2,
  active: {
    chunker: 'heading-1000',
    tokenizer: 'icu-zh',
    embedding: 'default',
    retrieval: 'balanced',
  },
});
export const headingStrategy = (maxChars: number) =>
  `export default { id: 'heading-${maxChars}', version: '1', chunk(input) { return input.headingLines(${maxChars}); } };\n`;
export const defaultTokenizer =
  "export default { id: 'icu-zh', version: '1', tokenize(text, context) { return context.icu(text, { locale: 'zh-CN', dictionary: [] }); } };\n";
type StrategyModule = {
  id: string;
  version: string;
  resources?: Record<string, string>;
  chunk?: (
    input: ChunkerInput & {
      resources: Record<string, string>;
      headingLines: (max: number) => ChunkRange[] | Promise<ChunkRange[]>;
    },
  ) => ChunkRange[] | Promise<ChunkRange[]>;
  tokenize?: (
    text: string,
    context: { resources: Record<string, string>; icu: typeof tokenize },
  ) => string[] | Promise<string[]>;
};
async function compile(
  code: string,
  id: string,
  kind: 'chunker' | 'tokenizer',
): Promise<StrategyModule> {
  const module: unknown = (
    await import(
      'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
    )
  ).default;
  const value = module as StrategyModule | undefined;
  if (
    !value ||
    value.id !== id ||
    typeof value.version !== 'string' ||
    !value.version ||
    typeof value[kind === 'chunker' ? 'chunk' : 'tokenize'] !== 'function'
  )
    throw new Error(
      'Invalid ' +
        kind +
        ' strategy: filename and exported id must match ' +
        id,
    );
  return value;
}
export async function loadProfileConfig(path: string): Promise<EchoConfig> {
  const configPath = resolve(path),
    base = dirname(configPath);
  const reads = new Map<string, string>();
  const read = async (file: string) => {
    const absolute = resolve(base, file),
      text = await readFile(absolute, 'utf8');
    reads.set(absolute, text);
    return text;
  };
  const main = mainSchema.parse(JSON.parse(await read(configPath)));
  const json = async (file: string) => JSON.parse(await read(file)) as unknown;
  const profile = async (kind: 'embedding' | 'retrieval') => {
    const id = main.active[kind];
    const raw = z
      .record(z.string(), z.unknown())
      .parse(await json(resolve(base, main.directories[kind], id + '.json')));
    if (raw.id !== id)
      throw new Error(kind + ' profile filename and id must match ' + id);
    const { id: _id, ...settings } = raw;
    return settings;
  };
  const strategy = async (
    kind: 'chunker' | 'tokenizer',
  ): Promise<StrategySnapshot> => {
    const id = main.active[kind],
      directory =
        main.directories[kind === 'chunker' ? 'chunkers' : 'tokenizers'];
    const file = resolve(base, directory, id + '.mjs'),
      code = await read(file);
    const module = await compile(code, id, kind);
    const declarations = z
      .record(z.string(), z.string())
      .parse(module.resources ?? {});
    const resources: Record<string, string> = {};
    for (const [name, resource] of Object.entries(declarations))
      resources[name] = await read(resolve(dirname(file), resource));
    const fingerprint = hash(
      JSON.stringify({
        id,
        version: module.version,
        code,
        resources,
        engine:
          kind === 'chunker'
            ? 'heading-lines-1'
            : lexicalFingerprint({ locale: 'zh-CN', dictionary: [] }),
      }),
    );
    return { id, version: module.version, code, resources, fingerprint };
  };
  const [chunker, tokenizer, embedding, retrieval, sources, runtime, logging] =
    await Promise.all([
      strategy('chunker'),
      strategy('tokenizer'),
      profile('embedding'),
      profile('retrieval'),
      json(main.sources),
      json(main.runtime),
      json(main.logging),
    ]);
  const sourceSettings = z
    .object({ collections: z.array(z.unknown()) })
    .strict()
    .parse(sources);
  const config = parseConfig({
    database: resolve(base, main.database),
    collections: sourceSettings.collections,
    embedding,
    retrieval,
    runtime,
    logging,
  });
  config.collections = config.collections.map((c) => ({
    ...c,
    root: resolve(base, c.root),
  }));
  if (config.logging.file)
    config.logging.file = resolve(base, config.logging.file);
  for (const [file, content] of reads)
    if ((await readFile(file, 'utf8')) !== content)
      throw new Error('Configuration changed while loading; retry');
  config.profile = {
    configPath,
    active: main.active,
    chunker,
    tokenizer,
    revision: hash(
      JSON.stringify([...reads].sort(([a], [b]) => a.localeCompare(b))),
    ),
  };
  return config;
}
export async function profileChunker(snapshot: StrategySnapshot) {
  const module = await compile(snapshot.code, snapshot.id, 'chunker');
  return {
    id: snapshot.id,
    version: snapshot.version,
    chunk: (input: ChunkerInput) =>
      module.chunk!({
        ...input,
        options: Object.freeze({}),
        resources: Object.freeze({ ...snapshot.resources }),
        headingLines: (max) =>
          defaultChunker.chunk({ ...input, options: { max_chars: max } }),
      }),
  };
}
export async function profileTokenizer(snapshot: StrategySnapshot) {
  const module = await compile(snapshot.code, snapshot.id, 'tokenizer');
  return async (text: string) => {
    const terms = await module.tokenize!(text, {
      resources: Object.freeze({ ...snapshot.resources }),
      icu: (text, config) =>
        tokenize(text, config).map((t) =>
          Buffer.from(t.slice(1), 'hex').toString('utf8'),
        ),
    });
    if (
      !Array.isArray(terms) ||
      terms.length > 100000 ||
      terms.some((t) => typeof t !== 'string' || t.length > 10000)
    )
      throw new Error(
        'Invalid tokenizer output: expected bounded string terms',
      );
    return terms
      .filter(Boolean)
      .map(
        (t) =>
          't' + Buffer.from(t.normalize('NFKC').toLowerCase()).toString('hex'),
      );
  };
}
