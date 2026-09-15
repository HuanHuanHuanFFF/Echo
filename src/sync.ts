import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import type { EchoConfig } from './config.js';
import { loadChunker, runChunker } from './chunker.js';
import { openDatabase } from './database.js';
import { hash, prepareSource } from './identity.js';
import { initializeStore, setMeta } from './store.js';

interface SourceRow {
  source_id: string;
  collection_id: string;
  path: string;
  relative_path: string;
  source_version: string;
  chunker_fingerprint: string;
}
export async function listMarkdown(root: string): Promise<string[]> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Collection root must be a real directory: ' + root);
  const files: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules'
      )
        await walk(resolve(dir, entry.name));
      else if (
        entry.isFile() &&
        !entry.name.startsWith('.') &&
        /\.md$/i.test(entry.name)
      )
        files.push(resolve(dir, entry.name));
    }
  }
  await walk(await realpath(root));
  return files.sort();
}
export interface SyncResult {
  status: 'ok';
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  wrote_ids: number;
  chunks: number;
}
export async function syncIndex(
  config: EchoConfig,
  signal?: AbortSignal,
): Promise<SyncResult> {
  if (!config.collections.length)
    throw new Error('Configure at least one collection before sync');
  const db = openDatabase(config.database);
  const result: SyncResult = {
    status: 'ok',
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    wrote_ids: 0,
    chunks: 0,
  };
  try {
    initializeStore(db);
    // Hold a single writer reservation across preparation. WAL readers keep the previous committed snapshot.
    db.exec('BEGIN IMMEDIATE');
    const { chunker, fingerprint } = await loadChunker(config.chunker);
    const previous = new Map(
      (db.prepare('SELECT * FROM sources').all() as SourceRow[]).map((s) => [
        s.source_id,
        s,
      ]),
    );
    const seen = new Set<string>();
    const checks: { path: string; version: string }[] = [];
    const inventories: { root: string; paths: string[] }[] = [];
    for (const collection of config.collections) {
      signal?.throwIfAborted();
      const paths = await listMarkdown(collection.root);
      const canonicalRoot = await realpath(collection.root);
      inventories.push({ root: collection.root, paths });
      for (const path of paths) {
        signal?.throwIfAborted();
        const source = await prepareSource(path);
        checks.push({ path, version: source.sourceVersion });
        if (source.wroteId) result.wrote_ids++;
        if (seen.has(source.sourceId))
          throw new Error(
            'Duplicate echo_id: ' + source.sourceId + ' at ' + path,
          );
        seen.add(source.sourceId);
        const relativePath = relative(canonicalRoot, path).replaceAll(
          String.fromCharCode(92),
          '/',
        );
        const old = previous.get(source.sourceId);
        const unchangedContent =
          old?.source_version === source.sourceVersion &&
          old.chunker_fingerprint === fingerprint;
        if (
          unchangedContent &&
          old.path === path &&
          old.collection_id === collection.id &&
          old.relative_path === relativePath
        ) {
          result.unchanged++;
          continue;
        }
        if (old) result.updated++;
        else result.added++;
        db.prepare(
          `INSERT INTO sources VALUES (?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET
          collection_id=excluded.collection_id,path=excluded.path,relative_path=excluded.relative_path,
          source_version=excluded.source_version,chunker_fingerprint=excluded.chunker_fingerprint`,
        ).run(
          source.sourceId,
          collection.id,
          path,
          relativePath,
          source.sourceVersion,
          fingerprint,
        );

        const chunks = await runChunker(chunker, {
          sourceId: source.sourceId,
          path,
          lines: source.lines,
          options: config.chunker.options,
        });
        db.prepare('DELETE FROM chunks WHERE source_id=?').run(source.sourceId);
        for (const chunk of chunks) {
          const chunkId = hash(
            JSON.stringify([
              source.sourceId,
              chunk.startLine,
              chunk.endLine,
              chunk.text,
            ]),
          );
          const retrievalText = [
            basename(path, '.md'),
            ...chunk.headingPath,
            chunk.text,
          ].join('\n');
          db.prepare(
            `INSERT INTO chunks(chunk_id,source_id,text,retrieval_text,heading_path,start_line,end_line,section_start_line,section_end_line)
            VALUES (?,?,?,?,?,?,?,?,?)`,
          ).run(
            chunkId,
            source.sourceId,
            chunk.text,
            retrievalText,
            JSON.stringify(chunk.headingPath),
            chunk.startLine,
            chunk.endLine,
            chunk.sectionStartLine ?? null,
            chunk.sectionEndLine ?? null,
          );
        }
      }
    }
    for (const old of previous.values())
      if (!seen.has(old.source_id)) {
        db.prepare('DELETE FROM sources WHERE source_id=?').run(old.source_id);
        result.removed++;
      }
    // Reject a changing corpus instead of claiming the snapshot matches an incomplete scan.
    for (const inventory of inventories)
      if (
        JSON.stringify(await listMarkdown(inventory.root)) !==
        JSON.stringify(inventory.paths)
      )
        throw new Error('Collection changed while syncing; retry');
    for (const check of checks)
      if (hash(await readFile(check.path, 'utf8')) !== check.version)
        throw new Error('Source changed while syncing; retry: ' + check.path);
    signal?.throwIfAborted();
    result.chunks = (
      db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }
    ).n;
    setMeta(db, 'last_sync', new Date().toISOString());
    setMeta(db, 'chunker_fingerprint', fingerprint);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}
