import MiniSearch from 'minisearch';
import type Database from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { RetrievalConfig } from './config.js';
import { sqlName } from './profile-store.js';

export interface LexicalTables {
  chunks: string;
  fts: string;
}
interface IndexedTerms {
  id: string;
  title: string;
  body: string;
}
export interface LexicalHit {
  id: string;
  score: number;
}
export interface MiniLexicalIndex {
  readonly documents: number;
  rank(
    terms: string[],
    options: RetrievalConfig,
    allowed?: ReadonlySet<string>,
  ): LexicalHit[];
}
let cached: { key: string; index: MiniLexicalIndex } | undefined;
let builds = 0,
  hits = 0;
export const miniCacheDiagnostics = () => ({
  builds,
  hits,
  documents: cached?.index.documents ?? 0,
});
export const clearMiniCache = () => {
  cached = undefined;
};

export async function prepareMiniIndex(
  db: Database.Database,
  tables: LexicalTables,
  signal?: AbortSignal,
): Promise<MiniLexicalIndex> {
  signal?.throwIfAborted();
  // Read under the caller's SQLite transaction, alongside readiness and data.
  const revision = (
    db.prepare("SELECT value FROM meta WHERE key='index_revision'").get() as
      { value: string } | undefined
  )?.value;
  const key =
    revision && db.name !== ':memory:'
      ? JSON.stringify([
          realpathSync(db.name),
          tables.chunks,
          tables.fts,
          revision,
        ])
      : undefined;
  if (key && cached?.key === key) {
    hits++;
    return cached.index;
  }
  // At most one retained lexical namespace per worker; active callers retain their snapshot.
  cached = undefined;
  const mini = new MiniSearch<IndexedTerms>({
    fields: ['title', 'body'],
    storeFields: [],
    tokenize: (text) => text.split(' ').filter(Boolean),
    processTerm: (term) => term,
    searchOptions: { prefix: false, fuzzy: false, combineWith: 'OR' },
  });
  const chunks = sqlName(tables.chunks),
    fts = sqlName(tables.fts);
  let count = 0;
  for (const row of db
    .prepare(
      `SELECT c.chunk_id id,f.title,f.body FROM ${chunks} c JOIN ${fts} f ON f.rowid=c.rowid ORDER BY c.rowid`,
    )
    .iterate() as Iterable<IndexedTerms>) {
    signal?.throwIfAborted();
    if (typeof row.title !== 'string' || typeof row.body !== 'string')
      throw new Error('Invalid lexical terms; run sync');
    mini.add(row);
    if (++count % 256 === 0) await yieldToLoop();
  }
  signal?.throwIfAborted();
  const index: MiniLexicalIndex = {
    documents: count,
    rank(terms, options, allowed) {
      if (!terms.length || allowed?.size === 0) return [];
      const all = mini.search(terms.join(' '), {
        fields: options.title_weight === 0 ? ['body'] : ['title', 'body'],
        boost: { title: options.title_weight, body: 1 },
        bm25: {
          k: options.minisearch_k,
          b: options.minisearch_b,
          d: options.minisearch_d,
        },
        ...(allowed ? { filter: (hit) => allowed.has(hit.id as string) } : {}),
      });
      return all
        .map((hit) => {
          // Native MiniSearch multiplies its field/term sum by matched query count.
          // Undo it for ALL matches, before sorting and selecting the candidate cap.
          const divisor = hit.queryTerms.length;
          const score = hit.score / divisor;
          if (!divisor || !Number.isFinite(score) || score < 0)
            throw new Error('Invalid MiniSearch score');
          return { id: hit.id as string, score };
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, options.bm25_candidates);
    },
  };
  builds++;
  // Older indexes stay readable, but cannot safely reuse an unversioned cache
  // across requests. The next successful sync publishes an atomic revision.
  if (key) cached = { key, index };
  return index;
}
