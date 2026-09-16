import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  realpath,
  rename,
} from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { parseConfig, loadConfig, type EchoConfig } from './config.js';
import type { EmbeddingProvider } from './contracts.js';
import { createEmbeddingProvider } from './embedding.js';
import { syncIndex, listMarkdown } from './sync.js';
import { searchIndex, type Evidence } from './retrieval.js';
import { hash, parseSource } from './identity.js';
import { loadChunker } from './chunker.js';
import { openDatabase } from './database.js';
import { indexStatus } from './store.js';

const factSchema = z
  .object({ id: z.string(), source: z.string(), text: z.string().min(1) })
  .strict();
const querySchema = z
  .object({
    id: z.string(),
    query: z.string(),
    facts: z.array(z.string()),
    subquestions: z.array(z.string()).optional(),
    no_answer: z.boolean().optional(),
  })
  .strict();
const datasetSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    facts: z.array(factSchema),
    queries: z.array(querySchema),
  })
  .strict();
export type Fact = z.infer<typeof factSchema>;
export interface Piece {
  source: string;
  text: string;
  start_line: number;
  end_line: number;
}
export function coveredFacts(
  expected: string[],
  facts: Fact[],
  pieces: Piece[],
): string[] {
  return expected.filter((id) => {
    const fact = facts.find((f) => f.id === id);
    if (!fact) throw new Error('Unknown fact ' + id);
    return pieces.some(
      (piece) => piece.source === fact.source && piece.text.includes(fact.text),
    );
  });
}
interface Row {
  query_id: string;
  strategy: string;
  status: string;
  expected_facts: string[];
  covered_facts: string[];
  latency_ms: number;
  request_chars: number;
  search_chars: number;
  read_chars: number;
  total_context_chars: number;
  chunks: number;
  distinct_sources: number;
  max_source_occupancy: number;
  no_answer: boolean;
  result: Awaited<ReturnType<typeof searchIndex>>;
  reads: Piece[];
}
interface Strategy {
  name: string;
  mode: 'bm25' | 'dense' | 'hybrid';
  unrestricted?: boolean;
  subquestions?: boolean;
  read?: boolean;
}
export function aggregateRows(rows: Row[]) {
  const answerable = rows.filter((r) => !r.no_answer);
  const expected = answerable.reduce((n, r) => n + r.expected_facts.length, 0);
  const covered = answerable.reduce((n, r) => n + r.covered_facts.length, 0);
  const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  return {
    queries: rows.length,
    errors: rows.filter(
      (r) => r.status === 'error' || r.status === 'partial_failure',
    ).length,
    any_fact_hit:
      answerable.filter((r) => r.covered_facts.length > 0).length +
      '/' +
      answerable.length,
    complete_coverage:
      answerable.filter(
        (r) => r.covered_facts.length === r.expected_facts.length,
      ).length +
      '/' +
      answerable.length,
    fact_coverage: covered + '/' + expected,
    no_answer_nonempty: rows.filter((r) => r.no_answer && r.chunks > 0).length,
    mean_distinct_sources:
      rows.reduce((n, r) => n + r.distinct_sources, 0) / rows.length,
    mean_max_source_occupancy:
      rows.reduce((n, r) => n + r.max_source_occupancy, 0) / rows.length,
    median_latency_ms: latencies.length
      ? (latencies[Math.floor((latencies.length - 1) / 2)]! +
          latencies[Math.floor(latencies.length / 2)]!) /
        2
      : 0,
    cumulative_context_chars: rows.reduce(
      (n, r) => n + r.total_context_chars,
      0,
    ),
  };
}
async function supplement(
  evidence: Evidence,
  budget: number,
): Promise<{ piece: Piece; cost: number } | null> {
  const start = evidence.section_start_line ?? evidence.start_line,
    end = evidence.section_end_line ?? evidence.end_line;
  const raw = await readFile(evidence.path, 'utf8');
  if (hash(raw) !== evidence.source_version)
    throw new Error('Corpus changed during contextual reading');
  const lines = parseSource(raw).lines;
  const request = {
    path: evidence.relative_path,
    start_line: start,
    end_line: end,
  };
  const requestChars = JSON.stringify(request).length;
  let chosen: Piece | undefined;
  for (let n = start; n <= end; n++) {
    const piece = {
      source: evidence.relative_path,
      start_line: start,
      end_line: n,
      text: lines.slice(start - 1, n).join('\n'),
    };
    if (requestChars + JSON.stringify(piece).length > budget) break;
    chosen = piece;
  }
  return chosen
    ? { piece: chosen, cost: requestChars + JSON.stringify(chosen).length }
    : null;
}
export async function corpusSnapshot(
  root: string,
): Promise<Record<string, string>> {
  const canonicalRoot = await realpath(root);
  const hashes: Record<string, string> = {};
  for (const path of await listMarkdown(root)) {
    const text = await readFile(path, 'utf8');
    if (!parseSource(text).sourceId)
      throw new Error(
        'Evaluation corpus requires stable UUID v4 identities: ' + path,
      );
    hashes[relative(canonicalRoot, path).split(sep).join('/')] = hash(text);
  }
  return hashes;
}
export async function runEvaluation(options: {
  configPath?: string;
  outputDir?: string;
  lexicalOnly: boolean;
  maxApiCalls?: number;
  budgetChars?: number;
  scenario?: 'default' | 'long-context';
}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (
    options.scenario !== undefined &&
    !['default', 'long-context'].includes(options.scenario)
  )
    throw new Error('Invalid evaluation scenario');
  const extended = options.scenario === 'long-context';
  const corpusRoot = join(root, 'evals', extended ? 'scenarios' : 'corpus');
  const dataset = datasetSchema.parse(
    JSON.parse(
      await readFile(
        join(root, 'evals', extended ? 'context-dataset.json' : 'dataset.json'),
        'utf8',
      ),
    ),
  );
  if (!dataset.facts.length || !dataset.queries.length)
    throw new Error('Evaluation dataset must not be empty');
  if (
    new Set(dataset.facts.map((f) => f.id)).size !== dataset.facts.length ||
    new Set(dataset.queries.map((q) => q.id)).size !== dataset.queries.length
  )
    throw new Error('Duplicate evaluation identifier');
  for (const query of dataset.queries) {
    if (
      (query.no_answer ?? false) === query.facts.length > 0 ||
      new Set(query.facts).size !== query.facts.length
    )
      throw new Error('Invalid expected fact labels: ' + query.id);
    for (const id of query.facts)
      if (!dataset.facts.some((f) => f.id === id))
        throw new Error('Unknown fact ' + id);
  }
  const fileHashes = await corpusSnapshot(corpusRoot);
  for (const fact of dataset.facts) {
    if (!Object.hasOwn(fileHashes, fact.source))
      throw new Error(
        'Fact source is outside the indexed corpus: ' + fact.source,
      );
    if (
      !(await readFile(join(corpusRoot, fact.source), 'utf8')).includes(
        fact.text,
      )
    )
      throw new Error('Fact is absent from corpus: ' + fact.id);
  }
  const budget = options.budgetChars ?? 8000;
  if (!Number.isInteger(budget) || budget < 2000 || budget > 100000)
    throw new Error('Evaluation budget must be 2000-100000 characters');
  if (
    !options.lexicalOnly &&
    (!options.configPath ||
      !Number.isInteger(options.maxApiCalls) ||
      !options.maxApiCalls ||
      options.maxApiCalls < 1)
  )
    throw new Error(
      'Real evaluation requires --config and an explicitly authorized --max-api-calls',
    );
  const profile = options.configPath
    ? await loadConfig(options.configPath)
    : parseConfig({});
  const output = resolve(
    options.outputDir ??
      join(
        root,
        '.echo',
        'evals',
        new Date().toISOString().replaceAll(':', '').replaceAll('.', ''),
      ),
  );
  await mkdir(output, { recursive: true });
  const outputRelative = relative(
    await realpath(corpusRoot),
    await realpath(output),
  );
  if (!(
    isAbsolute(outputRelative) ||
    outputRelative === '..' ||
    outputRelative.startsWith('..' + sep)
  ))
    throw new Error('Evaluation output must be outside the corpus');
  if ((await readdir(output)).length)
    throw new Error('Output directory must be empty; choose a new directory');
  await writeFile(
    join(output, '.attempt.json'),
    JSON.stringify({
      started_at: new Date().toISOString(),
      mode: options.lexicalOnly ? 'lexical_only' : 'api',
      api_request_limit: options.maxApiCalls ?? null,
    }),
    { flag: 'wx' },
  );
  const config: EchoConfig = {
    ...profile,
    database: join(output, 'index.sqlite'),
    collections: [{ id: 'evaluation', root: corpusRoot }],
    retrieval: {
      ...profile.retrieval,
      mode: options.lexicalOnly ? 'bm25' : 'hybrid',
    },
  };
  const base = options.lexicalOnly
    ? null
    : createEmbeddingProvider(config.embedding);
  const cache = new Map<string, number[]>();
  let cacheMisses = 0;
  const provider: EmbeddingProvider | null = base
    ? {
        fingerprint: base.fingerprint,
        dimensions: base.dimensions,
        async embed(texts, purpose, signal) {
          const keys = texts.map((text) => hash(purpose + '\n' + text));
          const missing = [
            ...new Map(texts.map((text, i) => [keys[i]!, text])).entries(),
          ].filter(([key]) => !cache.has(key));
          if (missing.length) {
            const used = base.usage?.().requests ?? 0;
            if (
              used + Math.ceil(missing.length / config.embedding.batch_size) >
              options.maxApiCalls!
            )
              throw new Error('Authorized API request budget exhausted');
            const vectors = await base.embed(
              missing.map(([, text]) => text),
              purpose,
              signal,
            );
            missing.forEach(([key], i) => cache.set(key, vectors[i]!));
            cacheMisses += missing.length;
          }
          return keys.map((key) => cache.get(key)!);
        },
      }
    : null;
  const started = performance.now();
  try {
    const sync = await syncIndex(config, undefined, provider);
    const verifyDb = openDatabase(config.database, { readOnly: true });
    try {
      const indexed = verifyDb
        .prepare('SELECT relative_path,source_version FROM sources')
        .all() as { relative_path: string; source_version: string }[];
      if (
        indexed.length !== Object.keys(fileHashes).length ||
        indexed.some(
          (row) => fileHashes[row.relative_path] !== row.source_version,
        )
      )
        throw new Error('Indexed corpus does not match the recorded snapshot');
    } finally {
      verifyDb.close();
    }
    if (provider)
      await provider.embed(
        [
          ...new Set(
            dataset.queries.flatMap((q) => [
              q.query,
              ...(q.subquestions ?? []),
            ]),
          ),
        ],
        'query',
      );
    const preparationMs = performance.now() - started;
    const preparedRequests = base?.usage?.().requests ?? 0;
    const strategies: Strategy[] = options.lexicalOnly
      ? [
          { name: 'bm25_default', mode: 'bm25' },
          { name: 'bm25_unrestricted', mode: 'bm25', unrestricted: true },
          { name: 'bm25_with_host_read', mode: 'bm25', read: true },
        ]
      : [
          { name: 'dense_default', mode: 'dense' },
          { name: 'hybrid_default', mode: 'hybrid' },
          { name: 'hybrid_unrestricted', mode: 'hybrid', unrestricted: true },
          { name: 'hybrid_subquestions', mode: 'hybrid', subquestions: true },
          { name: 'hybrid_with_host_read', mode: 'hybrid', read: true },
        ];
    const rows: Row[] = [];
    for (const strategy of strategies)
      for (const query of dataset.queries) {
        const question =
          strategy.subquestions && query.subquestions
            ? {
                queries: query.subquestions.map((text, i) => ({
                  query_id: query.id + '-' + i,
                  text,
                })),
              }
            : { query: query.query };
        const overrides = {
          mode: strategy.mode,
          max_chunks_per_source: strategy.unrestricted
            ? 100
            : config.retrieval.max_chunks_per_source,
          max_context_chars: budget,
        };
        let input = { ...question, overrides };
        // Reserve request and optional host-read context within the same final budget.
        const reserve = JSON.stringify(input).length;
        overrides.max_context_chars = Math.floor(
          (budget - reserve) * (strategy.read ? 0.65 : 1),
        );
        input = { ...question, overrides };
        const requestChars = JSON.stringify(input).length;
        const start = performance.now();
        const result = await searchIndex(config, input, undefined, provider);
        const latency = performance.now() - start;
        if ((base?.usage?.().requests ?? 0) !== preparedRequests)
          throw new Error('Unexpected API call during warm retrieval timing');
        const searchChars = JSON.stringify(result).length;
        const reads: Piece[] = [];
        let readChars = 0;
        if (strategy.read) {
          const seen = new Set<string>();
          for (const evidence of result.results) {
            const key =
              evidence.source_id +
              ':' +
              evidence.section_start_line +
              ':' +
              evidence.section_end_line;
            if (seen.has(key)) continue;
            seen.add(key);
            const extra = await supplement(
              evidence,
              budget - requestChars - searchChars - readChars,
            );
            if (extra) {
              reads.push(extra.piece);
              readChars += extra.cost;
            }
          }
        }
        const pieces = [
          ...result.results.map((e) => ({
            source: e.relative_path,
            text: e.text,
            start_line: e.start_line,
            end_line: e.end_line,
          })),
          ...reads,
        ];
        const covered = coveredFacts(query.facts, dataset.facts, pieces);
        const counts = new Map<string, number>();
        for (const e of result.results)
          counts.set(e.source_id, (counts.get(e.source_id) ?? 0) + 1);
        const total = requestChars + searchChars + readChars;
        if (total > budget)
          throw new Error('Cumulative context budget exceeded');
        rows.push({
          query_id: query.id,
          strategy: strategy.name,
          status: result.status,
          expected_facts: query.facts,
          covered_facts: covered,
          latency_ms: latency,
          request_chars: requestChars,
          search_chars: searchChars,
          read_chars: readChars,
          total_context_chars: total,
          chunks: result.results.length,
          distinct_sources: counts.size,
          max_source_occupancy: result.results.length
            ? Math.max(...counts.values()) / result.results.length
            : 0,
          no_answer: query.no_answer ?? false,
          result,
          reads,
        });
      }
    const db = openDatabase(config.database, { readOnly: true });
    let index;
    try {
      index = indexStatus(db);
    } finally {
      db.close();
    }
    let commit: string | null = null;
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      /* Git metadata is optional for unpacked source copies. */
    }
    const chunkerInfo = await loadChunker(config.chunker);
    const codeHashes: Record<string, string> = {};
    for (const name of [
      'chunker.ts',
      'retrieval.ts',
      'lexical.ts',
      'embedding.ts',
      'evaluation.ts',
    ])
      codeHashes[name] = hash(await readFile(join(root, 'src', name), 'utf8'));
    let dirty: boolean | null = null;
    try {
      dirty = Boolean(
        execFileSync('git', ['status', '--porcelain'], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      );
    } catch {}
    if (
      JSON.stringify(await corpusSnapshot(corpusRoot)) !==
      JSON.stringify(fileHashes)
    )
      throw new Error('Corpus changed during evaluation');
    const report = {
      status: options.lexicalOnly
        ? 'lexical_only'
        : rows.some(
              (r) => r.status === 'error' || r.status === 'partial_failure',
            )
          ? 'incomplete'
          : 'api_completed',
      created_at: new Date().toISOString(),
      dataset: dataset.name,
      scope: dataset.description,
      corpus_sha256: hash(JSON.stringify(fileHashes)),
      file_hashes: fileHashes,
      labels_sha256: hash(JSON.stringify(dataset)),
      git_commit: commit,
      git_dirty: dirty,
      code_sha256: codeHashes,
      environment: {
        node: process.version,
        icu: process.versions.icu,
        platform: process.platform,
        arch: process.arch,
      },
      profile: {
        chunker: config.chunker,
        chunker_implementation: {
          id: chunkerInfo.chunker.id,
          version: chunkerInfo.chunker.version,
          fingerprint: chunkerInfo.fingerprint,
        },
        lexical: config.lexical,
        retrieval: config.retrieval,
        embedding: base
          ? {
              ...config.embedding,
              fingerprint: base.fingerprint,
            }
          : null,
      },
      budget_chars_per_query: budget,
      preparation_ms: preparationMs,
      latency_scope:
        'Warm in-process searchIndex; excludes MCP startup/stdio and API preparation',
      api_request_limit: options.maxApiCalls ?? null,
      api_usage: base?.usage?.() ?? null,
      cache_misses: cacheMisses,
      sync,
      index,
      strategies: Object.fromEntries(
        strategies.map((s) => [
          s.name,
          aggregateRows(rows.filter((r) => r.strategy === s.name)),
        ]),
      ),
      rows,
      limitations: [
        '固定自编小样本，无盲测或全库代表性。',
        '按原文事实片段匹配评估证据覆盖，不评估生成答案。',
        'API 模式预热同一批 query embedding；延迟只计进程内检索，API 准备与 MCP 启动/传输另计。本地模式没有 embedding。',
        '累计预算包含规范请求/响应及补读请求/响应的 UTF-16 长度，不是 tokenizer token。',
        ...(options.lexicalOnly
          ? ['未使用真实 embedding，不能确认默认 hybrid 的语义效果或相对收益。']
          : []),
      ],
    };
    if (base)
      await writeFile(
        join(output, 'vectors.json'),
        JSON.stringify({
          fingerprint: base.fingerprint,
          vectors: Object.fromEntries(cache),
        }),
      );
    const lines = [
      '# Echo 固定样本评测',
      '',
      '状态：' + report.status + '。时间：' + report.created_at + '。',
      '',
      dataset.description,
      '',
      '| 策略 | 任意事实命中 | 完整覆盖 | 事实覆盖 | 中位检索 ms | 累计上下文字符 | 无答案题非空 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const [name, summary] of Object.entries(report.strategies))
      lines.push(
        '| ' +
          [
            name,
            summary.any_fact_hit,
            summary.complete_coverage,
            summary.fact_coverage,
            summary.median_latency_ms.toFixed(2),
            summary.cumulative_context_chars,
            summary.no_answer_nonempty,
          ].join(' | ') +
          ' |',
      );
    lines.push(
      '',
      '## 边界',
      '',
      ...report.limitations.map((text) => '- ' + text),
      '',
      '完整配置、逐题结果、标签和哈希见同目录 report.json。',
    );
    await writeFile(join(output, 'report.md'), lines.join('\n') + '\n');
    await writeFile(
      join(output, 'report.json.tmp'),
      JSON.stringify(report, null, 2),
      { flag: 'wx' },
    );
    await rename(join(output, 'report.json.tmp'), join(output, 'report.json'));
    return { output, report };
  } catch (error) {
    let recorded = true;
    try {
      await writeFile(
        join(output, 'failure.json'),
        JSON.stringify(
          {
            status: 'incomplete',
            error: error instanceof Error ? error.message : String(error),
            api_request_limit: options.maxApiCalls ?? null,
            api_usage: base?.usage?.() ?? null,
            cache_misses: cacheMisses,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    } catch {
      recorded = false;
    }
    throw new Error(
      'Evaluation failed' +
        (recorded
          ? '; see ' + join(output, 'failure.json')
          : '; failure ledger could not be saved') +
        ': ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}
