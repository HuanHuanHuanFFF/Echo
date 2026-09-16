import type Database from 'better-sqlite3';
import type { EchoConfig } from './config.js';
import type { EmbeddingProvider } from './contracts.js';
import { hash } from './identity.js';
import { embeddingFingerprint } from './embedding.js';
import { initializeStore } from './store.js';

export interface IndexSpec {
  key: string;
  kind: 'chunks' | 'fts' | 'vectors';
  identity: string;
  parent: string;
  table: string;
}
export interface ProfileTables {
  sources: string;
  chunks: string;
  fts: string;
  vectors?: string;
  chunk: IndexSpec;
  lexical: IndexSpec;
  vector?: IndexSpec;
  embeddingFingerprint?: string;
}
export interface IndexRecord {
  key: string;
  kind: string;
  identity: string;
  parent: string;
  table_name: string;
  corpus: string;
  scope: string;
  last_sync: string | null;
}
export class EchoError extends Error {
  constructor(
    public code: string,
    message: string,
    public next: string,
  ) {
    super(message);
  }
}
export function sqlName(name: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(name))
    throw new Error('Invalid internal SQL name');
  return '"' + name + '"';
}
const readable = (id: string) => id.replaceAll('-', '_');
export function profileTables(
  config: EchoConfig,
  provider?: Pick<EmbeddingProvider, 'fingerprint' | 'dimensions'> | null,
): ProfileTables {
  const p = config.profile;
  if (!p) throw new Error('Profile configuration required');
  const spec = (
    kind: IndexSpec['kind'],
    ids: string[],
    identity: unknown,
    parent = '',
  ): IndexSpec => {
    const encoded = JSON.stringify(identity),
      key = hash(encoded);
    return {
      key,
      kind,
      identity: encoded,
      parent,
      table:
        (kind === 'vectors' ? 'vec' : kind) +
        '_' +
        ids.map(readable).join('_') +
        '_' +
        key,
    };
  };
  const chunk = spec('chunks', [p.active.chunker], {
    chunker: p.active.chunker,
    fingerprint: p.chunker.fingerprint,
  });
  const lexical = spec(
    'fts',
    [p.active.chunker, p.active.tokenizer],
    {
      chunk: chunk.key,
      tokenizer: p.active.tokenizer,
      fingerprint: p.tokenizer.fingerprint,
    },
    chunk.key,
  );
  let vector: IndexSpec | undefined, embeddingVersion: string | undefined;
  if (
    provider ||
    (config.embedding.model &&
      config.embedding.base_url &&
      config.embedding.dimensions)
  ) {
    embeddingVersion =
      provider?.fingerprint ?? embeddingFingerprint(config.embedding);
    vector = spec(
      'vectors',
      [
        p.active.chunker,
        p.active.embedding,
        String(provider?.dimensions ?? config.embedding.dimensions),
      ],
      {
        chunk: chunk.key,
        embedding: p.active.embedding,
        dimensions: provider?.dimensions ?? config.embedding.dimensions,
        fingerprint: embeddingVersion,
      },
      chunk.key,
    );
  }
  return {
    sources: 'sources_' + readable(p.active.chunker) + '_' + chunk.key,
    chunks: chunk.table,
    fts: lexical.table,
    chunk,
    lexical,
    ...(vector
      ? {
          vectors: vector.table,
          vector,
          embeddingFingerprint: embeddingVersion!,
        }
      : {}),
  };
}
export function hasProfiles(db: Database.Database) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='echo_indexes'",
      )
      .get(),
  );
}
export function initializeProfiles(db: Database.Database) {
  initializeStore(db);
  db.exec(`CREATE TABLE IF NOT EXISTS echo_indexes(
    key TEXT PRIMARY KEY,kind TEXT NOT NULL,identity TEXT NOT NULL,parent TEXT NOT NULL,
    table_name TEXT NOT NULL UNIQUE,corpus TEXT NOT NULL DEFAULT '',scope TEXT NOT NULL DEFAULT '',last_sync TEXT);
    CREATE TABLE IF NOT EXISTS echo_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
}
export function registryRecord(
  db: Database.Database,
  spec: IndexSpec,
): IndexRecord | undefined {
  const record = db
    .prepare('SELECT * FROM echo_indexes WHERE key=?')
    .get(spec.key) as IndexRecord | undefined;
  if (
    record &&
    (record.identity !== spec.identity ||
      record.table_name !== spec.table ||
      record.kind !== spec.kind ||
      record.parent !== spec.parent)
  )
    throw new Error('Index registry identity mismatch');
  return record;
}
function register(db: Database.Database, spec: IndexSpec) {
  registryRecord(db, spec);
  db.prepare(
    'INSERT OR IGNORE INTO echo_indexes(key,kind,identity,parent,table_name) VALUES (?,?,?,?,?)',
  ).run(spec.key, spec.kind, spec.identity, spec.parent, spec.table);
}
export function ensureProfileTables(
  db: Database.Database,
  t: ProfileTables,
  withVector: boolean,
) {
  register(db, t.chunk);
  const sources = sqlName(t.sources),
    chunks = sqlName(t.chunks),
    fts = sqlName(t.fts);
  db.exec(`CREATE TABLE IF NOT EXISTS ${sources} (
    source_id TEXT PRIMARY KEY,collection_id TEXT NOT NULL,path TEXT NOT NULL,relative_path TEXT NOT NULL,
    source_version TEXT NOT NULL,chunker_fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${chunks} (
    rowid INTEGER PRIMARY KEY,chunk_id TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL REFERENCES ${sources}(source_id) ON DELETE CASCADE,
    text TEXT NOT NULL,retrieval_text TEXT NOT NULL,heading_path TEXT NOT NULL,start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,section_start_line INTEGER,section_end_line INTEGER);`);
  register(db, t.lexical);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(title,body);
    CREATE TRIGGER IF NOT EXISTS ${sqlName('delete_' + t.fts)} AFTER DELETE ON ${chunks}
    BEGIN DELETE FROM ${fts} WHERE rowid=old.rowid; END;`);
  if (withVector && t.vector) {
    register(db, t.vector);
    db.exec(`CREATE TABLE IF NOT EXISTS ${sqlName(t.vector.table)}(
      chunk_rowid INTEGER PRIMARY KEY REFERENCES ${chunks}(rowid) ON DELETE CASCADE,embedding BLOB NOT NULL);`);
  }
}
export const scopeFingerprint = (config: EchoConfig) =>
  hash(JSON.stringify(config.collections));
export function corpusState(db: Database.Database): string | undefined {
  return (
    db.prepare("SELECT value FROM echo_state WHERE key='corpus'").get() as
      { value: string } | undefined
  )?.value;
}
export function publishIndex(
  db: Database.Database,
  spec: IndexSpec,
  corpus: string,
  scope: string,
) {
  db.prepare(
    'UPDATE echo_indexes SET corpus=?,scope=?,last_sync=? WHERE key=?',
  ).run(corpus, scope, new Date().toISOString(), spec.key);
}
export function checkProfiles(
  db: Database.Database,
  config: EchoConfig,
  t: ProfileTables,
  mode: EchoConfig['retrieval']['mode'],
) {
  if (!hasProfiles(db))
    throw new EchoError(
      'INDEX_REQUIRED',
      'Selected index has not been synchronized',
      'Run echo-mcp sync',
    );
  const corpus = corpusState(db),
    scope = scopeFingerprint(config);
  for (const spec of [
    t.chunk,
    ...(mode === 'dense' ? [] : [t.lexical]),
    ...(mode === 'bm25' ? [] : [t.vector]),
  ]) {
    if (!spec)
      throw new EchoError(
        'MODEL_CONFIG',
        'Embedding model settings are incomplete',
        'Configure the selected embedding profile',
      );
    const record = registryRecord(db, spec);
    if (!record?.last_sync)
      throw new EchoError(
        'INDEX_REQUIRED',
        'Selected index combination is missing',
        'Run echo-mcp sync',
      );
    if (record.corpus !== corpus || record.scope !== scope)
      throw new EchoError(
        'INDEX_STALE',
        'Selected index is stale or its scan scope changed',
        'Run echo-mcp sync',
      );
  }
}
export function profileStatus(db: Database.Database, config: EchoConfig) {
  const t = profileTables(config);
  let ready = true,
    reason: unknown;
  try {
    checkProfiles(db, config, t, config.retrieval.mode);
  } catch (error) {
    ready = false;
    reason =
      error instanceof EchoError
        ? { code: error.code, next: error.next }
        : { code: 'INDEX_ERROR', next: 'Check database and configuration' };
  }
  const record = hasProfiles(db) ? registryRecord(db, t.chunk) : undefined;
  const count = (table: string) =>
    (
      db.prepare('SELECT count(*) AS n FROM ' + sqlName(table)).get() as {
        n: number;
      }
    ).n;
  return {
    active: config.profile!.active,
    revision: config.profile!.revision,
    ready,
    ...(reason ? { reason } : {}),
    last_sync: record?.last_sync ?? null,
    sources: record ? count(t.sources) : 0,
    chunks: record ? count(t.chunks) : 0,
    embeddings:
      hasProfiles(db) && t.vector && registryRecord(db, t.vector)
        ? count(t.vector.table)
        : 0,
    indexes: {
      chunks: t.chunk.key,
      fts: t.lexical.key,
      vectors: t.vector?.key ?? null,
    },
  };
}
