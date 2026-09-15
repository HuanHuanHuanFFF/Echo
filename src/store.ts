import type Database from 'better-sqlite3';

export function initializeStore(db: Database.Database) {
  const version = db.pragma('user_version', { simple: true });
  if (version !== 0 && version !== 1)
    throw new Error('Unsupported index schema; use a new database');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      source_id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, path TEXT NOT NULL,
      relative_path TEXT NOT NULL, source_version TEXT NOT NULL, chunker_fingerprint TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      rowid INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
      text TEXT NOT NULL, retrieval_text TEXT NOT NULL, heading_path TEXT NOT NULL,
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
      section_start_line INTEGER, section_end_line INTEGER
    );
    CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 1;
  `);
}
export function indexStatus(db: Database.Database) {
  initializeStore(db);
  return {
    sources: (
      db.prepare('SELECT count(*) AS n FROM sources').get() as { n: number }
    ).n,
    chunks: (
      db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }
    ).n,
    metadata: Object.fromEntries(
      (
        db.prepare('SELECT key,value FROM meta').all() as {
          key: string;
          value: string;
        }[]
      ).map((x) => [x.key, x.value]),
    ),
  };
}
export function setMeta(db: Database.Database, key: string, value: string) {
  db.prepare(
    'INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key, value);
}
