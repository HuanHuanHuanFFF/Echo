import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export function openDatabase(
  path: string,
  options: { readOnly?: boolean } = {},
): Database.Database {
  const readOnly = options.readOnly ?? false;
  if (!readOnly && path !== ':memory:')
    mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, {
    readonly: readOnly,
    fileMustExist: readOnly,
  });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (!readOnly) db.pragma('journal_mode = WAL');
    sqliteVec.load(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function databaseCapabilities(db: Database.Database) {
  return {
    sqlite: (
      db.prepare('select sqlite_version() as version').get() as {
        version: string;
      }
    ).version,
    vector: (
      db.prepare('select vec_version() as version').get() as { version: string }
    ).version,
  };
}
