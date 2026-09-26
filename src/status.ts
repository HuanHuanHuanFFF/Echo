import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { EchoConfig } from './config.js';
import { openDatabase, databaseCapabilities } from './database.js';
import { hash } from './identity.js';
import { listMarkdown } from './sync.js';
import { indexStatus } from './store.js';
import { lexicalFingerprint } from './lexical.js';
import { embeddingFingerprint } from './embedding.js';
import {
  profileStatus,
  profileTables,
  hasProfiles,
  registryRecord,
  sqlName,
} from './profile-store.js';

export const statusSchema = z
  .object({
    check_sources: z
      .boolean()
      .optional()
      .describe(
        'Read all Markdown in the configured scan scope and compare SHA-256 hashes and file paths with the selected chunk index. Read-only; no sync or embedding API calls. Omitted/false skips source reads.',
      ),
  })
  .strict();
export type StatusInput = z.infer<typeof statusSchema>;
interface SourceSnapshot {
  collection_id: string;
  path: string;
  source_version: string;
}
export interface Freshness {
  state: 'unchecked' | 'unchanged' | 'changed' | 'unknown';
  checked_at?: string;
  duration_ms?: number;
  files_checked?: number;
  bytes_read?: number;
  changes?: { added: number; modified: number; removed: number };
  reason?: string;
  next?: string;
}
const sourceKey = (collection: string, path: string) =>
  JSON.stringify([collection, path]);

async function checkSources(
  config: EchoConfig,
  previous: SourceSnapshot[],
  signal?: AbortSignal,
): Promise<Freshness> {
  const started = performance.now();
  let filesChecked = 0,
    bytesRead = 0;
  const measurement = () => ({
    checked_at: new Date().toISOString(),
    duration_ms: Math.round(performance.now() - started),
    files_checked: filesChecked,
    bytes_read: bytesRead,
  });
  try {
    const remaining = new Map(
      previous.map((s) => [sourceKey(s.collection_id, s.path), s]),
    );
    const changes = { added: 0, modified: 0, removed: 0 };
    const inventories: {
      collection: EchoConfig['collections'][number];
      paths: string[];
    }[] = [];
    for (const collection of config.collections) {
      signal?.throwIfAborted();
      const paths = await listMarkdown(collection.root, collection, signal);
      inventories.push({ collection, paths });
      for (const path of paths) {
        signal?.throwIfAborted();
        const before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink())
          throw new Error('Source is no longer a regular file: ' + path);
        const maxBytes = collection.max_file_bytes ?? 10 * 1024 * 1024;
        if (before.size > maxBytes)
          throw new Error('Source exceeds max_file_bytes: ' + path);
        const bytes = await readFile(path, { signal });
        if (bytes.length > maxBytes)
          throw new Error('Source exceeds max_file_bytes: ' + path);
        const raw = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        const digest = hash(raw);
        const after = await lstat(path);
        if (
          !after.isFile() ||
          after.isSymbolicLink() ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          before.ino !== after.ino
        )
          throw new Error('Source changed while checking; retry: ' + path);
        const key = sourceKey(collection.id, path),
          old = remaining.get(key);
        if (!old) changes.added++;
        else if (old.source_version !== digest) changes.modified++;
        remaining.delete(key);
        filesChecked++;
        bytesRead += bytes.length;
      }
    }
    for (const { collection, paths } of inventories)
      if (
        JSON.stringify(
          await listMarkdown(collection.root, collection, signal),
        ) !== JSON.stringify(paths)
      )
        throw new Error('Scan scope changed while checking; retry');
    signal?.throwIfAborted();
    changes.removed = remaining.size;
    const changed = Object.values(changes).some((n) => n > 0);
    return {
      state: changed ? 'changed' : 'unchanged',
      ...measurement(),
      changes,
      ...(changed ? { next: 'Run echo-mcp sync' } : {}),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      state: 'unknown',
      ...measurement(),
      reason: (error instanceof Error
        ? error.message
        : 'Source check failed'
      ).slice(0, 500),
      next: 'Fix source access or scan settings, then retry status with check_sources',
    };
  }
}

/** Status and source hashes share one database read snapshot; source files are not locked. */
export async function readStatus(
  config: EchoConfig,
  rawInput: unknown = {},
  signal?: AbortSignal,
) {
  const input = statusSchema.parse(rawInput);
  const collections = config.collections.map((c) => ({
    id: c.id,
    root: c.root,
  }));
  const unavailable = {
    ready: false,
    last_sync: null,
    sources: 0,
    chunks: 0,
    embeddings: 0,
    reason: { code: 'INDEX_REQUIRED', next: 'Run echo-mcp sync' },
  };
  const unchecked: Freshness = { state: 'unchecked' };
  const noBaseline: Freshness = input.check_sources
    ? {
        state: 'unknown',
        reason: 'Selected chunk index has no successful sync to compare.',
        next: 'Run echo-mcp sync',
      }
    : unchecked;
  if (!existsSync(config.database))
    return {
      ...unavailable,
      collections,
      freshness: noBaseline,
      needs_sync: true,
    };
  const db = openDatabase(config.database, {
    readOnly: true,
    busyTimeout: config.runtime.sqlite_busy_timeout_ms,
  });
  try {
    db.exec('BEGIN');
    let status;
    let sourceTable: string | undefined;
    if (config.profile) {
      status = profileStatus(db, config);
      const tables = profileTables(config);
      if (hasProfiles(db) && registryRecord(db, tables.chunk)?.last_sync)
        sourceTable = tables.sources;
    } else {
      const legacy = indexStatus(db);
      const reason = hasProfiles(db)
        ? { code: 'LEGACY_CONFIG', next: 'Use the version 2 configuration' }
        : !legacy.metadata.last_sync
          ? { code: 'INDEX_REQUIRED', next: 'Run echo-mcp sync' }
          : legacy.metadata.lexical_fingerprint !==
              lexicalFingerprint(config.lexical)
            ? {
                code: 'INDEX_STALE',
                next: 'Run echo-mcp sync with the selected tokenizer settings',
              }
            : config.retrieval.mode !== 'bm25'
              ? !config.embedding.model ||
                !config.embedding.base_url ||
                !config.embedding.dimensions
                ? {
                    code: 'MODEL_CONFIG',
                    next: 'Configure embedding model settings',
                  }
                : legacy.metadata.embedding_fingerprint !==
                    embeddingFingerprint(config.embedding)
                  ? {
                      code: 'INDEX_STALE',
                      next: 'Run echo-mcp sync with the selected embedding settings',
                    }
                  : undefined
              : undefined;
      status = {
        ...legacy,
        ready: !reason,
        ...(reason ? { reason } : {}),
        last_sync: legacy.metadata.last_sync ?? null,
      };
      if (legacy.metadata.last_sync && !hasProfiles(db))
        sourceTable = 'sources';
    }
    const previous = sourceTable
      ? (db
          .prepare(
            'SELECT collection_id,path,source_version FROM ' +
              sqlName(sourceTable),
          )
          .all() as SourceSnapshot[])
      : [];
    const freshness =
      input.check_sources && sourceTable
        ? await checkSources(config, previous, signal)
        : noBaseline;
    return {
      ...status,
      collections: collections.map((c) => ({
        ...c,
        indexed_sources: previous.filter((s) => s.collection_id === c.id)
          .length,
      })),
      freshness,
      needs_sync:
        !status.ready || freshness.state === 'changed'
          ? true
          : freshness.state === 'unchanged'
            ? false
            : null,
      capabilities: databaseCapabilities(db),
    };
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
