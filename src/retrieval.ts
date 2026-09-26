import { failureInfo } from './errors.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import {
  profileTables,
  checkProfiles,
  sqlName,
  hasProfiles,
  EchoError,
  corpusState,
} from './profile-store.js';
import { profileTokenizer } from './profiles.js';
import { uuidV4 } from './identity.js';
import type { EchoConfig, RetrievalConfig } from './config.js';
import { retrievalOptions, retrievalOverridesSchema } from './config.js';
import type { EmbeddingProvider } from './contracts.js';
import { createEmbeddingProvider, validateVectors } from './embedding.js';
import { openDatabase } from './database.js';
import { initializeStore } from './store.js';
import { lexicalFingerprint, tokenize } from './lexical.js';
import {
  prepareMiniIndex,
  clearMiniCache,
  type MiniLexicalIndex,
} from './minisearch.js';

export const filtersSchema = z
  .object({
    collections: z
      .array(z.string().min(1).max(100))
      .max(32)
      .optional()
      .describe(
        'Collection IDs from echo_status. Unknown IDs are errors; [] selects nothing.',
      ),
    source_ids: z
      .array(
        z
          .string()
          .regex(uuidV4)
          .transform((value) => value.toLowerCase()),
      )
      .max(100)
      .optional()
      .describe('Source UUIDs from returned evidence. [] selects nothing.'),
    path_prefix: z
      .string()
      .max(1000)
      .transform((v) => v.replaceAll(String.fromCharCode(92), '/'))
      .optional()
      .describe(
        'Literal prefix of the path relative to each collection root, using /, e.g. topics/. Not an absolute path or glob; applies to all selected collections.',
      ),
  })
  .strict();
export const singleSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    filters: filtersSchema.optional(),
    overrides: retrievalOverridesSchema.optional(),
    diagnostics: z
      .boolean()
      .optional()
      .describe(
        'Include full applied configuration, profile selection, candidate counts, relative paths, per-expression outcomes and ranking scores. Default false; included metadata consumes the response budget.',
      ),
  })
  .strict();
export type Filters = z.infer<typeof filtersSchema>;
export interface Evidence {
  chunk_id: string;
  source_id: string;
  collection_id: string;
  path: string;
  relative_path: string;
  source_version: string;
  text: string;
  heading_path: string[];
  start_line: number;
  end_line: number;
  section_start_line: number | null;
  section_end_line: number | null;
  matched_query_ids: string[];
  rankings?: {
    query_id: string;
    rrf_score: number;
    bm25_rank?: number;
    dense_rank?: number;
    similarity?: number;
  }[];
}
export type SearchEvidence = Omit<Evidence, 'relative_path'> & {
  relative_path?: string;
};
export interface Candidate {
  evidence: Evidence;
  score: number;
  bm25_rank?: number;
  dense_rank?: number;
  similarity?: number;
}
export interface QueryCandidates {
  query_id: string;
  status: 'ok' | 'empty' | 'error' | 'partial_failure';
  error?: string;
  candidates: Candidate[];
  variants?: { index: number; status: string; error?: string }[];
  counts: { bm25: number; dense: number; fused: number };
}
interface Row extends Omit<Evidence, 'heading_path' | 'matched_query_ids'> {
  heading_path: string;
  rowid: number;
  distance?: number;
}
const columns =
  'c.rowid,c.chunk_id,c.text,c.heading_path,c.start_line,c.end_line,c.section_start_line,c.section_end_line,s.source_id,s.collection_id,s.path,s.relative_path,s.source_version';
function scope(filters: Filters) {
  const clauses: string[] = [],
    values: string[] = [];
  for (const [column, list] of [
    ['s.collection_id', filters.collections],
    ['s.source_id', filters.source_ids],
  ] as const) {
    if (list !== undefined) {
      clauses.push(
        list.length
          ? column + ' IN (' + list.map(() => '?').join(',') + ')'
          : '0',
      );
      values.push(...list);
    }
  }
  if (filters.path_prefix !== undefined) {
    clauses.push('substr(s.relative_path,1,length(?))=?');
    values.push(filters.path_prefix, filters.path_prefix);
  }
  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', values };
}
export function getMeta(
  db: Database.Database,
  key: string,
): string | undefined {
  return (
    db.prepare('SELECT value FROM meta WHERE key=?').get(key) as
      { value: string } | undefined
  )?.value;
}
interface RetrievalIndex {
  mini?: MiniLexicalIndex;
  sources: string;
  chunks: string;
  fts: string;
  vectors?: string;
  embeddingFingerprint?: string;
  tokenize: (text: string) => Promise<string[]>;
}
function indexSql(sql: string, index?: RetrievalIndex) {
  if (!index) return sql;
  const names: Record<string, string> = {
    sources: index.sources,
    chunks: index.chunks,
    chunk_fts: index.fts,
    embeddings: index.vectors ?? 'missing_vectors',
  };
  return sql.replace(/\b(sources|chunks|chunk_fts|embeddings)\b/g, (name) =>
    sqlName(names[name]!),
  );
}
export async function retrieveQuery(
  db: Database.Database,
  config: EchoConfig,
  queryId: string,
  query: string,
  filters: Filters,
  options: RetrievalConfig,
  provider: EmbeddingProvider | null,
  signal?: AbortSignal,
  providerError?: string,
  index?: RetrievalIndex,
): Promise<QueryCandidates> {
  signal?.throwIfAborted();
  const filter = scope(filters),
    merged = new Map<string, Candidate>();
  const result: QueryCandidates = {
    query_id: queryId,
    status: 'empty',
    candidates: [],
    counts: { bm25: 0, dense: 0, fused: 0 },
  };
  const add = (rows: Row[], lane: 'bm25' | 'dense', weight: number) => {
    rows.forEach((row, index) => {
      let candidate = merged.get(row.chunk_id);
      if (!candidate) {
        const { rowid: _rowid, distance: _distance, ...data } = row;
        candidate = {
          evidence: {
            ...data,
            heading_path: JSON.parse(row.heading_path) as string[],
            matched_query_ids: [queryId],
          },
          score: 0,
        };
        merged.set(row.chunk_id, candidate);
      }
      candidate.score += weight / (options.rrf_k + index + 1);
      if (lane === 'bm25') candidate.bm25_rank = index + 1;
      else {
        candidate.dense_rank = index + 1;
        candidate.similarity = 1 - row.distance!;
      }
    });
  };
  if (options.mode !== 'dense') {
    const terms = [
      ...new Set(
        index ? await index.tokenize(query) : tokenize(query, config.lexical),
      ),
    ].slice(0, 128);
    let rows: Row[] = [];
    if (terms.length && options.lexical_engine === 'minisearch') {
      const tables = index ?? {
        chunks: 'chunks',
        fts: 'chunk_fts',
        sources: 'sources',
      };
      const allowed = filter.sql
        ? new Set(
            (
              db
                .prepare(
                  indexSql(
                    'SELECT c.chunk_id FROM chunks c JOIN sources s USING(source_id) WHERE 1' +
                      filter.sql,
                    index,
                  ),
                )
                .all(...filter.values) as { chunk_id: string }[]
            ).map((r) => r.chunk_id),
          )
        : undefined;
      if (allowed?.size !== 0) {
        const lexical =
          index?.mini ?? (await prepareMiniIndex(db, tables, signal));
        if (index) index.mini = lexical;
        const ranked = lexical.rank(terms, options, allowed);
        signal?.throwIfAborted();
        const get = db.prepare(
          indexSql(
            'SELECT ' +
              columns +
              ' FROM chunks c JOIN sources s USING(source_id) WHERE c.chunk_id=?' +
              filter.sql,
            index,
          ),
        );
        rows = ranked.map((hit) => {
          const row = get.get(hit.id, ...filter.values) as Row | undefined;
          if (!row) {
            clearMiniCache();
            throw new EchoError(
              'INDEX_STALE',
              'Lexical candidate is missing from the current snapshot',
              'Run echo-mcp sync',
            );
          }
          return row;
        });
      }
    } else if (terms.length) {
      const expression = terms.map((t) => JSON.stringify(t)).join(' OR ');
      rows = db
        .prepare(
          indexSql(
            'SELECT ' +
              columns +
              ' FROM chunk_fts JOIN chunks c ON c.rowid=chunk_fts.rowid JOIN sources s USING(source_id) WHERE chunk_fts MATCH ?' +
              filter.sql +
              ' ORDER BY bm25(chunk_fts,?,1),c.chunk_id LIMIT ?',
            index,
          ),
        )
        .all(
          expression,
          ...filter.values,
          options.title_weight,
          options.bm25_candidates,
        ) as Row[];
    }
    result.counts.bm25 = rows.length;
    add(rows, 'bm25', options.mode === 'bm25' ? 1 : options.bm25_weight);
  }
  if (options.mode !== 'bm25') {
    try {
      if (!provider)
        throw new Error(providerError ?? 'Embedding provider unavailable');
      if (
        (index?.embeddingFingerprint ??
          getMeta(db, 'embedding_fingerprint')) !== provider.fingerprint
      )
        throw new Error('Embedding configuration differs from index; run sync');
      const vector = validateVectors(
        await provider.embed([query], 'query', signal),
        1,
        provider.dimensions,
      )[0]!;
      signal?.throwIfAborted();
      const rows = db
        .prepare(
          indexSql(
            'SELECT ' +
              columns +
              ',vec_distance_cosine(v.embedding,?) AS distance FROM embeddings v JOIN chunks c ON c.rowid=v.chunk_rowid JOIN sources s USING(source_id) WHERE 1' +
              filter.sql +
              ' AND vec_distance_cosine(v.embedding,?) <= ? ORDER BY distance,c.chunk_id LIMIT ?',
            index,
          ),
        )
        .all(
          new Float32Array(vector),
          ...filter.values,
          new Float32Array(vector),
          1 - options.min_dense_similarity,
          options.dense_candidates,
        ) as Row[];
      result.counts.dense = rows.length;
      add(rows, 'dense', options.mode === 'dense' ? 1 : options.dense_weight);
    } catch (error) {
      signal?.throwIfAborted();
      result.status = options.mode === 'dense' ? 'error' : 'partial_failure';
      result.error =
        error instanceof Error ? error.message : 'Embedding failed';
    }
  }
  result.candidates = [...merged.values()]
    .filter((c) => c.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.evidence.chunk_id.localeCompare(b.evidence.chunk_id),
    );
  result.counts.fused = result.candidates.length;
  if (!result.error) result.status = result.candidates.length ? 'ok' : 'empty';
  return result;
}
export function packResults(
  queries: QueryCandidates[],
  options: RetrievalConfig,
  selection?: Record<string, unknown>,
  diagnostics = true,
) {
  const results: Evidence[] = [];
  const selected = new Map<string, Evidence>(),
    perSource = new Map<string, number>();
  const counts = { source_limit: 0, duplicate: 0, budget: 0, topk: 0 };
  const budgetRejected = new Set<string>();
  const reports = () =>
    queries.map((q) => ({
      query_id: q.query_id,
      status: q.status,
      ...(q.error ? { error: q.error, ...failureInfo(q.error) } : {}),
      ...(diagnostics ? { candidates: q.counts } : {}),
      ...(q.variants && (diagnostics || q.variants.some((v) => v.error))
        ? {
            variants: diagnostics
              ? q.variants
              : q.variants.filter((v) => v.error),
          }
        : {}),
      ...(!diagnostics &&
      q.status !== 'error' &&
      !results.some((e) => e.matched_query_ids.includes(q.query_id))
        ? {
            empty_reason:
              q.candidates.length === 0
                ? 'no_candidates'
                : q.candidates.some((c) =>
                      budgetRejected.has(c.evidence.chunk_id),
                    )
                  ? 'budget'
                  : 'limits',
          }
        : {}),
      returned: results.filter((e) => e.matched_query_ids.includes(q.query_id))
        .length,
    }));
  const response = () => ({
    status: queries.every((q) => q.status === 'error')
      ? 'error'
      : queries.some((q) => q.error)
        ? 'partial_failure'
        : 'ok',
    results: results.map((e): SearchEvidence => {
      if (diagnostics) return e;
      const { relative_path: _relative, rankings: _rankings, ...essential } = e;
      return essential;
    }),
    queries: reports(),
    ...(diagnostics
      ? {
          applied: options,
          excluded: counts,
          ...(selection ? { selection } : {}),
        }
      : {}),
    ...(!diagnostics && (counts.budget || counts.source_limit || counts.topk)
      ? {
          limits: (['budget', 'source_limit', 'topk'] as const).filter(
            (key) => counts[key] > 0,
          ),
        }
      : {}),
  });
  const matching = new Map<string, string[]>();
  const rankingMap = new Map<string, NonNullable<Evidence['rankings']>>();
  for (const q of queries)
    for (const c of q.candidates) {
      const list = matching.get(c.evidence.chunk_id) ?? [];
      list.push(q.query_id);
      matching.set(c.evidence.chunk_id, list);
      const ranks = rankingMap.get(c.evidence.chunk_id) ?? [];
      ranks.push({
        query_id: q.query_id,
        rrf_score: c.score,
        ...(c.bm25_rank === undefined ? {} : { bm25_rank: c.bm25_rank }),
        ...(c.dense_rank === undefined ? {} : { dense_rank: c.dense_rank }),
        ...(c.similarity === undefined ? {} : { similarity: c.similarity }),
      });
      rankingMap.set(c.evidence.chunk_id, ranks);
    }
  // Round-robin across independent intents; each intent keeps its own ranking.
  const length = Math.max(0, ...queries.map((q) => q.candidates.length));
  for (let rank = 0; rank < length; rank++)
    for (const q of queries) {
      const c = q.candidates[rank];
      if (!c) continue;
      if (selected.has(c.evidence.chunk_id)) {
        counts.duplicate++;
        continue;
      }
      if (results.length >= options.topk) {
        counts.topk++;
        continue;
      }
      if (
        (perSource.get(c.evidence.source_id) ?? 0) >=
        options.max_chunks_per_source
      ) {
        counts.source_limit++;
        continue;
      }
      const rankings = rankingMap.get(c.evidence.chunk_id)!;
      const evidence = {
        ...c.evidence,
        matched_query_ids: [...new Set(matching.get(c.evidence.chunk_id))],
        rankings,
      };
      results.push(evidence);
      if (JSON.stringify(response()).length > options.max_context_chars) {
        results.pop();
        counts.budget++;
        budgetRejected.add(evidence.chunk_id);
        continue;
      }
      selected.set(evidence.chunk_id, evidence);
      perSource.set(
        evidence.source_id,
        (perSource.get(evidence.source_id) ?? 0) + 1,
      );
    }
  while (
    results.length &&
    JSON.stringify(response()).length > options.max_context_chars
  ) {
    budgetRejected.add(results.pop()!.chunk_id);
    counts.budget++;
  }
  if (JSON.stringify(response()).length > options.max_context_chars)
    throw new Error(
      'max_context_chars is too small for query status and configuration',
    );
  return response();
}
export const querySpecSchema = z
  .object({
    query_id: z.string().trim().min(1).max(64),
    text: z.string().trim().min(1).max(2000),
    variants: z
      .array(z.string().trim().min(1).max(2000))
      .max(3)
      .default([])
      .describe(
        'Optional alternate wording of this same intent, not independent subquestions.',
      ),
  })
  .strict();
export const searchSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        'One complete retrieval question. Supply exactly one of query or queries.',
      ),
    queries: z
      .array(querySpecSchema)
      .min(1)
      .max(8)
      .optional()
      .describe(
        'Independent subquestions supplied by the Agent, with unique IDs. All share topk, per-source cap and budget. Supply exactly one of query or queries.',
      ),
    filters: filtersSchema.optional(),
    overrides: retrievalOverridesSchema.optional(),
    diagnostics: z
      .boolean()
      .optional()
      .describe(
        'Include full applied configuration, profile selection, candidate counts, relative paths, per-expression outcomes and ranking scores. Default false; included metadata consumes the response budget.',
      ),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.query === undefined) === (v.queries === undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'Provide exactly one of query or queries',
      });
    if (
      v.queries &&
      new Set(v.queries.map((q) => q.query_id)).size !== v.queries.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'query_id values must be unique',
      });
  });
export async function searchIndex(
  config: EchoConfig,
  rawInput: unknown,
  signal?: AbortSignal,
  customProvider?: EmbeddingProvider | null,
) {
  const input = searchSchema.parse(rawInput);
  const options = retrievalOptions(config.retrieval, input.overrides);
  const unknownCollections = input.filters?.collections?.filter(
    (id) => !config.collections.some((c) => c.id === id),
  );
  if (unknownCollections?.length)
    throw new EchoError(
      'INVALID_COLLECTION',
      'Unknown collection ID: ' + unknownCollections.join(', '),
      'Use collection IDs from echo_status.collections',
    );
  const prefix = input.filters?.path_prefix;
  if (
    prefix !== undefined &&
    (/^(?:[a-z]:|\/)/i.test(prefix) || prefix.split('/').includes('..'))
  )
    throw new EchoError(
      'INVALID_PATH_PREFIX',
      'path_prefix must be relative to a collection root',
      'Use a relative path such as topics/; see echo_status.collections',
    );
  if (options.mode === 'dense' || options.lexical_engine === 'sqlite')
    clearMiniCache();
  let provider = customProvider ?? null,
    providerError: string | undefined;
  if (customProvider === undefined && options.mode !== 'bm25') {
    try {
      provider = createEmbeddingProvider(config.embedding);
    } catch (error) {
      providerError = (error as Error).message;
    }
  }
  if (config.profile && !existsSync(config.database))
    throw new EchoError(
      'INDEX_REQUIRED',
      'Index database is missing',
      'Run echo-mcp sync',
    );
  const db = openDatabase(config.database, {
    readOnly: true,
    busyTimeout: config.runtime.sqlite_busy_timeout_ms,
  });
  try {
    initializeStore(db);
    db.exec('BEGIN');
    let index: RetrievalIndex | undefined;
    let selection: Record<string, unknown> | undefined;
    if (config.profile) {
      const tables = profileTables(config, customProvider);
      checkProfiles(db, config, tables, options.mode);
      index = {
        ...tables,
        tokenize: await profileTokenizer(config.profile.tokenizer),
      };
      selection = {
        ...config.profile.active,
        revision: config.profile.revision,
        source_snapshot: corpusState(db),
      };
    } else {
      if (hasProfiles(db))
        throw new EchoError(
          'LEGACY_CONFIG',
          'This database contains profile indexes',
          'Use the version 2 configuration',
        );
      if (!getMeta(db, 'last_sync'))
        throw new Error('Index is not synchronized; run sync');
      if (
        getMeta(db, 'lexical_fingerprint') !==
        lexicalFingerprint(config.lexical)
      )
        throw new Error('Lexical configuration differs from index; run sync');
    }
    index ??= {
      sources: 'sources',
      chunks: 'chunks',
      fts: 'chunk_fts',
      vectors: 'embeddings',
      tokenize: async (text) => tokenize(text, config.lexical),
    };
    const specs = input.queries ?? [
      { query_id: 'q0', text: input.query!, variants: [] },
    ];
    const queries: QueryCandidates[] = [];
    for (const spec of specs) {
      signal?.throwIfAborted();
      const expressions = [...new Set([spec.text, ...spec.variants])];
      const attempts: QueryCandidates[] = [];
      for (const expression of expressions)
        attempts.push(
          await retrieveQuery(
            db,
            config,
            spec.query_id,
            expression,
            input.filters ?? {},
            options,
            provider,
            signal,
            providerError,
            index,
          ),
        );
      const merged = new Map<string, Candidate>();
      for (const attempt of attempts)
        for (const c of attempt.candidates) {
          const old = merged.get(c.evidence.chunk_id);
          if (!old)
            merged.set(c.evidence.chunk_id, {
              ...c,
              score: c.score / expressions.length,
            });
          else {
            old.score += c.score / expressions.length;
            if (c.bm25_rank !== undefined)
              old.bm25_rank = Math.min(old.bm25_rank ?? Infinity, c.bm25_rank);
            if (c.dense_rank !== undefined)
              old.dense_rank = Math.min(
                old.dense_rank ?? Infinity,
                c.dense_rank,
              );
            if (c.similarity !== undefined)
              old.similarity = Math.max(
                old.similarity ?? -Infinity,
                c.similarity,
              );
          }
        }
      const candidates = [...merged.values()].sort(
        (a, b) =>
          b.score - a.score ||
          a.evidence.chunk_id.localeCompare(b.evidence.chunk_id),
      );
      const failures = attempts.filter((a) => a.error);
      queries.push({
        query_id: spec.query_id,
        status: failures.length
          ? attempts.every((a) => a.status === 'error')
            ? 'error'
            : 'partial_failure'
          : candidates.length
            ? 'ok'
            : 'empty',
        ...(failures.length
          ? { error: [...new Set(failures.map((a) => a.error!))].join('; ') }
          : {}),
        candidates,
        counts: {
          bm25: attempts.reduce((s, a) => s + a.counts.bm25, 0),
          dense: attempts.reduce((s, a) => s + a.counts.dense, 0),
          fused: candidates.length,
        },
        ...(expressions.length > 1
          ? {
              variants: attempts.map((a, index) => ({
                index,
                status: a.status,
                ...(a.error ? { error: a.error } : {}),
              })),
            }
          : {}),
      });
    }
    return packResults(queries, options, selection, input.diagnostics ?? false);
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
