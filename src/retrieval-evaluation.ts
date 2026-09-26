import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  appendFile,
  rename,
  realpath,
} from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadConfig, type EchoConfig } from './config.js';
import { listMarkdown } from './sync.js';
import { hash, parseSource } from './identity.js';
import { openDatabase } from './database.js';
import { profileStatus, profileTables, sqlName } from './profile-store.js';
import {
  searchIndex,
  querySpecSchema,
  searchSchema,
  type SearchEvidence,
} from './retrieval.js';
import { createEmbeddingProvider } from './embedding.js';
import type { EmbeddingProvider } from './contracts.js';

const id = z.string().min(1).max(100);
const sourcePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.includes('\\') &&
      !p.startsWith('/') &&
      !/^[a-z]:/i.test(p) &&
      p
        .split('/')
        .every((part) => part !== '..' && part !== '.' && part !== ''),
    'Source paths must be normalized relative paths',
  );
const corpusEntry = z
  .object({
    collection_id: id,
    path: sourcePath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const anchor = z
  .object({
    collection_id: id,
    path: sourcePath,
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    quote: z.string().min(1),
  })
  .strict();
const datasetSchema = z
  .object({
    version: z.literal(1),
    name: id,
    split: z.enum(['development', 'test']),
    scenario: z.object({ id, kind: z.enum(['separate', 'mixed']) }).strict(),
    corpus: z.array(corpusEntry).min(1),
    facts: z.array(z.object({ id, evidence: z.array(anchor).min(1) }).strict()),
    questions: z
      .array(
        z
          .object({
            id,
            intent_group: id,
            type: id,
            query: z.string().trim().min(1).max(2000),
            subquestions: z
              .array(
                z
                  .object({
                    id: querySpecSchema.shape.query_id,
                    text: z.string().trim().min(1).max(2000),
                    required_facts: z.array(id),
                  })
                  .strict(),
              )
              .min(1)
              .max(8)
              .optional(),
            required_facts: z.array(id),
            no_answer: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
type Dataset = z.infer<typeof datasetSchema>;
type CorpusEntry = z.infer<typeof corpusEntry>;
interface Source extends CorpusEntry {
  absolute: string;
  sourceId: string;
  lines: string[];
  frontmatterEnd: number;
}
const key = (collection: string, path: string) =>
  JSON.stringify([collection, path]);
const sorted = <T extends CorpusEntry>(rows: T[]) =>
  [...rows].sort((a, b) =>
    key(a.collection_id, a.path).localeCompare(key(b.collection_id, b.path)),
  );
const manifestOf = (sources: Source[]) =>
  sorted(sources).map(({ collection_id, path, sha256 }) => ({
    collection_id,
    path,
    sha256,
  }));
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const byteHash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
function strictText(bytes: Uint8Array, label: string) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Error(label + ' contains invalid UTF-8');
  }
}

async function scan(config: EchoConfig): Promise<Source[]> {
  const found: Source[] = [];
  const identities = new Set<string>();
  for (const collection of config.collections) {
    const root = await realpath(collection.root);
    for (const file of await listMarkdown(root, collection)) {
      const bytes = await readFile(file);
      const raw = strictText(bytes, 'Corpus');
      const parsed = parseSource(raw);
      if (!parsed.sourceId)
        throw new Error(
          'Evaluation requires pre-existing UUID v4 identities; prepare a test copy first',
        );
      if (identities.has(parsed.sourceId))
        throw new Error('Duplicate corpus identity');
      identities.add(parsed.sourceId);
      found.push({
        collection_id: collection.id,
        path: relative(root, file).split(sep).join('/'),
        sha256: byteHash(bytes),
        absolute: file,
        sourceId: parsed.sourceId,
        lines: parsed.lines,
        frontmatterEnd: parsed.frontmatterEnd,
      });
    }
  }
  return sorted(found);
}
export async function snapshotRetrievalCorpus(
  configPath: string,
  outputPath?: string,
) {
  const config = await loadConfig(configPath);
  if (outputPath) await outsideCorpus(resolve(outputPath), config);
  const corpus = manifestOf(await scan(config));
  if (outputPath)
    await writeFile(resolve(outputPath), json(corpus), { flag: 'wx' });
  return corpus;
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length)
    throw new Error('Duplicate ' + label);
}
function validateLabels(dataset: Dataset, sources: Source[]) {
  unique(
    dataset.corpus.map((s) => key(s.collection_id, s.path)),
    'corpus path',
  );
  unique(
    dataset.facts.map((f) => f.id),
    'fact ID',
  );
  unique(
    dataset.questions.map((q) => q.id),
    'question ID',
  );
  if (
    JSON.stringify(sorted(dataset.corpus)) !==
    JSON.stringify(manifestOf(sources))
  )
    throw new Error('Corpus does not match frozen manifest');
  const byPath = new Map(sources.map((s) => [key(s.collection_id, s.path), s]));
  for (const fact of dataset.facts)
    for (const a of fact.evidence) {
      const source = byPath.get(key(a.collection_id, a.path));
      if (
        !source ||
        a.end_line < a.start_line ||
        a.start_line <= source.frontmatterEnd + 1 ||
        a.end_line > source.lines.length ||
        !a.quote.trim() ||
        source.lines.slice(a.start_line - 1, a.end_line).join('\n') !== a.quote
      )
        throw new Error('Invalid source evidence anchor: ' + fact.id);
    }
  for (const q of dataset.questions) {
    unique(q.required_facts, 'required fact');
    if (q.no_answer === q.required_facts.length > 0)
      throw new Error('Invalid answerability labels: ' + q.id);
    if (q.required_facts.some((f) => !dataset.facts.some((x) => x.id === f)))
      throw new Error('Unknown required fact: ' + q.id);
    if (q.subquestions) {
      unique(
        q.subquestions.map((s) => s.id),
        'subquestion ID',
      );
      for (const sub of q.subquestions) {
        unique(sub.required_facts, 'subquestion fact');
        if (sub.required_facts.some((f) => !q.required_facts.includes(f)))
          throw new Error('Subquestion has unknown parent fact: ' + q.id);
      }
      if (
        q.required_facts.some(
          (f) => !q.subquestions!.some((s) => s.required_facts.includes(f)),
        )
      )
        throw new Error('Subquestions omit required parent facts: ' + q.id);
    }
  }
  return byPath;
}
function verifyIndex(config: EchoConfig, sources: Source[]) {
  if (!config.profile)
    throw new Error('Retrieval evaluation requires version 2 configuration');
  const db = openDatabase(config.database, { readOnly: true });
  try {
    const status = profileStatus(db, config);
    if (!status.ready)
      throw new Error(
        'Selected index is not ready; run explicit sync on the test copy first',
      );
    const table = profileTables(config);
    const rows = db
      .prepare(
        'SELECT collection_id,relative_path,source_version,path,source_id FROM ' +
          sqlName(table.sources),
      )
      .all() as {
      collection_id: string;
      relative_path: string;
      source_version: string;
      path: string;
      source_id: string;
    }[];
    const indexed = new Map(
      rows.map((r) => [key(r.collection_id, r.relative_path), r]),
    );
    if (
      indexed.size !== sources.length ||
      rows.length !== sources.length ||
      sources.some((s) => {
        const r = indexed.get(key(s.collection_id, s.path));
        return (
          !r ||
          r.source_version !== s.sha256 ||
          resolve(r.path) !== resolve(s.absolute) ||
          r.source_id !== s.sourceId
        );
      })
    )
      throw new Error(
        'Index differs from frozen source corpus; synchronize before evaluation',
      );
    return status;
  } finally {
    db.close();
  }
}
function verifyPieces(pieces: SearchEvidence[], sources: Map<string, Source>) {
  for (const e of pieces) {
    const source = [...sources.values()].find(
      (s) => s.collection_id === e.collection_id && s.sourceId === e.source_id,
    );
    if (
      !source ||
      e.source_id !== source.sourceId ||
      e.source_version !== source.sha256 ||
      resolve(e.path) !== resolve(source.absolute) ||
      e.start_line <= source.frontmatterEnd + 1 ||
      e.end_line < e.start_line ||
      e.end_line > source.lines.length ||
      source.lines.slice(e.start_line - 1, e.end_line).join('\n') !== e.text
    )
      throw new Error('Returned evidence differs from frozen source');
  }
}
function covered(
  dataset: Dataset,
  expected: string[],
  pieces: SearchEvidence[],
  sources: Map<string, Source>,
) {
  return expected.filter((id) =>
    dataset.facts
      .find((f) => f.id === id)!
      .evidence.some((a) => {
        const source = sources.get(key(a.collection_id, a.path))!;
        const matching = pieces.filter(
          (e) =>
            e.collection_id === a.collection_id &&
            e.source_id === source.sourceId,
        );
        for (let line = a.start_line; line <= a.end_line; line++) {
          // Empty source lines are formatting; a split may trim them from chunk edges.
          if (
            source.lines[line - 1]!.trim() &&
            !matching.some((e) => e.start_line <= line && e.end_line >= line)
          )
            return false;
        }
        return true;
      }),
  );
}
function requestFor(
  q: Dataset['questions'][number],
  budget: number,
  responseLimit: number,
) {
  const question = q.subquestions
    ? {
        queries: q.subquestions.map(({ id, text }) => ({ query_id: id, text })),
      }
    : { query: q.query };
  let allowance = Math.min(budget, responseLimit);
  for (let i = 0; i < 4; i++) {
    const request = {
      ...question,
      overrides: { max_context_chars: allowance },
    };
    const next = budget - JSON.stringify(request).length;
    if (next >= allowance) {
      if (allowance < 256)
        throw new Error('Query leaves insufficient response budget');
      searchSchema.parse(request);
      return request;
    }
    allowance = next;
  }
  throw new Error('Cannot fit query within context budget');
}
async function runtimeSnapshot() {
  const root = dirname(fileURLToPath(import.meta.url));
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const names = (await readdir(root))
    .filter((n) => n.endsWith(extension) && !n.endsWith('.d.ts'))
    .sort();
  const files: Record<string, string> = {};
  for (const name of names)
    files[name] = byteHash(await readFile(join(root, name)));
  return {
    node: process.version,
    icu: process.versions.icu,
    files,
    sha256: hash(JSON.stringify(files)),
  };
}
async function outsideCorpus(output: string, config: EchoConfig) {
  // Resolve existing ancestors before creating an output directory (including junctions).
  let ancestor = output;
  const tail: string[] = [];
  for (;;) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
  const canonical = resolve(ancestor, ...tail);
  for (const collection of config.collections) {
    const r = relative(await realpath(collection.root), canonical);
    if (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep))
      throw new Error('Evaluation output must be outside source collections');
  }
}
export interface RetrievalEvaluationOptions {
  configPath: string;
  datasetPath: string;
  outputDir: string;
  budgetChars?: number;
  maxApiCalls?: number;
}
interface Row {
  query_id: string;
  intent_group: string;
  type: string;
  request: unknown;
  status: string;
  expected_facts: string[];
  covered_facts: string[];
  subquery_coverage: {
    query_id: string;
    expected_facts: string[];
    covered_facts: string[];
  }[];
  no_answer: boolean;
  request_chars: number;
  response_chars: number;
  context_chars: number;
  latency_ms: number;
  first_fact_reciprocal_rank: number;
  api_requests: number;
  result: Awaited<ReturnType<typeof searchIndex>>;
}
function summary(rows: Row[]) {
  const answerable = rows.filter((r) => !r.no_answer);
  const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  const percentile = (p: number) =>
    latencies.length
      ? latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)]!
      : null;
  return {
    queries: rows.length,
    answerable: answerable.length,
    fact_coverage: {
      covered: answerable.reduce((n, r) => n + r.covered_facts.length, 0),
      expected: answerable.reduce((n, r) => n + r.expected_facts.length, 0),
    },
    complete_evidence: {
      covered: answerable.filter(
        (r) => r.covered_facts.length === r.expected_facts.length,
      ).length,
      expected: answerable.length,
    },
    no_answer: {
      queries: rows.filter((r) => r.no_answer).length,
      nonempty: rows.filter((r) => r.no_answer && r.result.results.length > 0)
        .length,
    },
    failures: rows.filter(
      (r) => r.status === 'error' || r.status === 'partial_failure',
    ).length,
    mean_first_fact_reciprocal_rank: answerable.length
      ? answerable.reduce((n, r) => n + r.first_fact_reciprocal_rank, 0) /
        answerable.length
      : null,
    latency_ms: { p50: percentile(0.5), p95: percentile(0.95) },
    cumulative_context_chars: rows.reduce((n, r) => n + r.context_chars, 0),
  };
}
export async function runRetrievalEvaluation(
  options: RetrievalEvaluationOptions,
) {
  const config = await loadConfig(options.configPath);
  const budget = options.budgetChars ?? 16000;
  if (!Number.isInteger(budget) || budget < 512 || budget > 100000)
    throw new Error('Budget must be 512-100000 characters');
  if (
    config.retrieval.mode !== 'bm25' &&
    (!Number.isSafeInteger(options.maxApiCalls) ||
      !options.maxApiCalls ||
      options.maxApiCalls < 1)
  )
    throw new Error('API evaluation requires explicit maxApiCalls');
  const output = resolve(options.outputDir);
  await outsideCorpus(output, config);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length)
    throw new Error('Output directory must be empty');
  await writeFile(
    join(output, '.attempt.json'),
    json({
      started_at: new Date().toISOString(),
      api_limit: options.maxApiCalls ?? 0,
    }),
    { flag: 'wx' },
  );
  let base: EmbeddingProvider | null = null;
  const rows: Row[] = [];
  let provider: EmbeddingProvider | null = null,
    cacheHits = 0;
  const usage = () => base?.usage?.() ?? null;
  try {
    const datasetBytes = await readFile(options.datasetPath);
    const raw = strictText(datasetBytes, 'Dataset');
    const dataset = datasetSchema.parse(JSON.parse(raw.replace(/^\uFEFF/, '')));
    const sources = await scan(config),
      byPath = validateLabels(dataset, sources);
    const requests = dataset.questions.map((q) =>
      requestFor(q, budget, config.retrieval.max_context_chars),
    );
    const index = verifyIndex(config, sources),
      runtime = await runtimeSnapshot();
    await writeFile(join(output, 'dataset.json'), datasetBytes, { flag: 'wx' });
    await writeFile(
      join(output, 'manifest.json'),
      json({
        dataset: {
          name: dataset.name,
          split: dataset.split,
          scenario: dataset.scenario,
          sha256: byteHash(datasetBytes),
        },
        corpus: manifestOf(sources),
        runtime,
        selection: config.profile!.active,
        revision: config.profile!.revision,
        retrieval: config.retrieval,
        embedding: config.embedding,
        budget_chars: budget,
        api_request_limit: options.maxApiCalls ?? 0,
        index,
        behavior:
          'read-only single-turn retrieval; no Agent, answer generation, dynamic decomposition or host read',
      }),
      { flag: 'wx' },
    );
    let exhausted = false;
    if (config.retrieval.mode !== 'bm25') {
      const api = createEmbeddingProvider(config.embedding);
      base = api;
      const cache = new Map<string, number[]>();
      provider = {
        fingerprint: api.fingerprint,
        dimensions: api.dimensions,
        async embed(texts, purpose, signal) {
          if (purpose !== 'query')
            throw new Error('Retrieval-only runner cannot embed documents');
          const missing = [...new Set(texts)].filter((t) => !cache.has(t));
          const calls = Math.ceil(missing.length / config.embedding.batch_size);
          if ((api.usage?.().requests ?? 0) + calls > options.maxApiCalls!) {
            exhausted = true;
            throw new Error('API request budget exhausted');
          }
          cacheHits += texts.length - missing.length;
          if (missing.length) {
            const vectors = await api.embed(missing, purpose, signal);
            missing.forEach((t, i) => cache.set(t, vectors[i]!));
          }
          return texts.map((t) => cache.get(t)!);
        },
      };
    }
    for (let i = 0; i < dataset.questions.length; i++) {
      const q = dataset.questions[i]!,
        request = requests[i]!,
        before = usage()?.requests ?? 0,
        start = performance.now();
      const result = await searchIndex(
        config,
        request,
        AbortSignal.timeout(config.runtime.search_timeout_ms),
        provider,
      );
      const elapsed = performance.now() - start;
      verifyPieces(result.results, byPath);
      const found = covered(dataset, q.required_facts, result.results, byPath);
      let reciprocal = 0;
      if (!q.no_answer)
        for (let n = 1; n <= result.results.length; n++)
          if (
            covered(
              dataset,
              q.required_facts,
              result.results.slice(0, n),
              byPath,
            ).length
          ) {
            reciprocal = 1 / n;
            break;
          }
      const requestChars = JSON.stringify(request).length,
        responseChars = JSON.stringify(result).length;
      if (requestChars + responseChars > budget)
        throw new Error('Cumulative context budget exceeded');
      const row: Row = {
        query_id: q.id,
        intent_group: q.intent_group,
        type: q.type,
        request,
        status: result.status,
        expected_facts: q.required_facts,
        covered_facts: found,
        subquery_coverage: (q.subquestions ?? []).map((sub) => ({
          query_id: sub.id,
          expected_facts: sub.required_facts,
          covered_facts: covered(
            dataset,
            sub.required_facts,
            result.results.filter((e) => e.matched_query_ids.includes(sub.id)),
            byPath,
          ),
        })),
        no_answer: q.no_answer,
        request_chars: requestChars,
        response_chars: responseChars,
        context_chars: requestChars + responseChars,
        latency_ms: elapsed,
        first_fact_reciprocal_rank: reciprocal,
        api_requests: (usage()?.requests ?? 0) - before,
        result,
      };
      rows.push(row);
      await appendFile(join(output, 'rows.jsonl'), JSON.stringify(row) + '\n');
      await writeFile(
        join(output, 'usage.json'),
        json({ api_usage: usage(), query_cache_hits: cacheHits }),
      );
      if (exhausted) throw new Error('API request budget exhausted');
    }
    if (
      JSON.stringify(manifestOf(await scan(config))) !==
      JSON.stringify(manifestOf(sources))
    )
      throw new Error('Corpus changed during evaluation');
    if (JSON.stringify(verifyIndex(config, sources)) !== JSON.stringify(index))
      throw new Error('Selected index changed during evaluation');
    if ((await runtimeSnapshot()).sha256 !== runtime.sha256)
      throw new Error('Runtime changed during evaluation');
    const report = {
      status: rows.some(
        (r) => r.status === 'error' || r.status === 'partial_failure',
      )
        ? 'incomplete'
        : 'complete',
      dataset: dataset.name,
      split: dataset.split,
      scenario: dataset.scenario,
      retrieval_only: true,
      api_usage: usage(),
      query_cache_hits: cacheHits,
      independent_intent_groups: new Set(rows.map((r) => r.intent_group)).size,
      by_type: Object.fromEntries(
        [...new Set(rows.map((r) => r.type))].map((type) => [
          type,
          summary(rows.filter((r) => r.type === type)),
        ]),
      ),
      summary: summary(rows),
      rows,
    };
    await writeFile(join(output, 'report.json.tmp'), json(report), {
      flag: 'wx',
    });
    await rename(join(output, 'report.json.tmp'), join(output, 'report.json'));
    return { output, report };
  } catch (error) {
    await writeFile(
      join(output, 'failure.json'),
      json({
        status: 'failed',
        error: error instanceof Error ? error.message : 'Evaluation failed',
        api_usage: usage(),
        completed_rows: rows.length,
      }),
    );
    throw error;
  } finally {
    await base?.dispose?.();
  }
}
