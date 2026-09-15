import type Database from 'better-sqlite3';
import { z } from 'zod';
import { uuidV4 } from './identity.js';
import type { EchoConfig, RetrievalConfig } from './config.js';
import { retrievalOptions } from './config.js';
import type { EmbeddingProvider } from './contracts.js';
import { createEmbeddingProvider, validateVectors } from './embedding.js';
import { openDatabase } from './database.js';
import { initializeStore } from './store.js';
import { lexicalFingerprint, matchExpression } from './lexical.js';

export const filtersSchema = z
  .object({
    collections: z.array(z.string().min(1).max(100)).max(32).optional(),
    source_ids: z
      .array(
        z
          .string()
          .regex(uuidV4)
          .transform((value) => value.toLowerCase()),
      )
      .max(100)
      .optional(),
    path_prefix: z
      .string()
      .max(1000)
      .transform((v) => v.replaceAll(String.fromCharCode(92), '/'))
      .optional(),
  })
  .strict();
export const singleSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    filters: filtersSchema.optional(),
    overrides: z.record(z.string(), z.unknown()).optional(),
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
    const expression = matchExpression(query, config.lexical);
    const rows = expression
      ? (db
          .prepare(
            'SELECT ' +
              columns +
              ' FROM chunk_fts JOIN chunks c ON c.rowid=chunk_fts.rowid JOIN sources s USING(source_id) WHERE chunk_fts MATCH ?' +
              filter.sql +
              ' ORDER BY bm25(chunk_fts,?,1),c.chunk_id LIMIT ?',
          )
          .all(
            expression,
            ...filter.values,
            options.title_weight,
            options.bm25_candidates,
          ) as Row[])
      : [];
    result.counts.bm25 = rows.length;
    add(rows, 'bm25', options.mode === 'bm25' ? 1 : options.bm25_weight);
  }
  if (options.mode !== 'bm25') {
    try {
      if (!provider)
        throw new Error(providerError ?? 'Embedding provider unavailable');
      if (getMeta(db, 'embedding_fingerprint') !== provider.fingerprint)
        throw new Error('Embedding configuration differs from index; run sync');
      const vector = validateVectors(
        await provider.embed([query], 'query', signal),
        1,
        provider.dimensions,
      )[0]!;
      signal?.throwIfAborted();
      const rows = db
        .prepare(
          'SELECT ' +
            columns +
            ',vec_distance_cosine(v.embedding,?) AS distance FROM embeddings v JOIN chunks c ON c.rowid=v.chunk_rowid JOIN sources s USING(source_id) WHERE 1' +
            filter.sql +
            ' AND vec_distance_cosine(v.embedding,?) <= ? ORDER BY distance,c.chunk_id LIMIT ?',
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
) {
  const results: Evidence[] = [];
  const selected = new Map<string, Evidence>(),
    perSource = new Map<string, number>();
  const counts = { source_limit: 0, duplicate: 0, budget: 0, topk: 0 };
  const reports = () =>
    queries.map((q) => ({
      query_id: q.query_id,
      status: q.status,
      ...(q.error ? { error: q.error } : {}),
      candidates: q.counts,
      returned: results.filter((e) => e.matched_query_ids.includes(q.query_id))
        .length,
    }));
  const response = () => ({
    status: queries.every((q) => q.status === 'error')
      ? 'error'
      : queries.some((q) => q.error)
        ? 'partial_failure'
        : 'ok',
    results,
    queries: reports(),
    applied: options,
    excluded: counts,
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
    results.pop();
    counts.budget++;
  }
  if (JSON.stringify(response()).length > options.max_context_chars)
    throw new Error(
      'max_context_chars is too small for query status and configuration',
    );
  return response();
}
export async function searchIndex(
  config: EchoConfig,
  rawInput: unknown,
  signal?: AbortSignal,
  customProvider?: EmbeddingProvider | null,
) {
  const input = singleSearchSchema.parse(rawInput);
  if (!input.query.trim() || input.query.length > 2000)
    throw new Error('query must contain 1-2000 characters');
  const options = retrievalOptions(config.retrieval, input.overrides);
  let provider = customProvider ?? null,
    providerError: string | undefined;
  if (customProvider === undefined && options.mode !== 'bm25') {
    try {
      provider = createEmbeddingProvider(config.embedding);
    } catch (error) {
      providerError = (error as Error).message;
    }
  }
  const db = openDatabase(config.database, { readOnly: true });
  try {
    initializeStore(db);
    db.exec('BEGIN');
    if (!getMeta(db, 'last_sync'))
      throw new Error('Index is not synchronized; run sync');
    if (
      getMeta(db, 'lexical_fingerprint') !== lexicalFingerprint(config.lexical)
    )
      throw new Error('Lexical configuration differs from index; run sync');
    const query = await retrieveQuery(
      db,
      config,
      'q0',
      input.query,
      input.filters ?? {},
      options,
      provider,
      signal,
      providerError,
    );
    return packResults([query], options);
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
