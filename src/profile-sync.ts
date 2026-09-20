import { setMeta } from './store.js';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import type { EchoConfig } from './config.js';
import type { EmbeddingProvider } from './contracts.js';
import { openDatabase } from './database.js';
import { hash, prepareSource } from './identity.js';
import { loadChunker, runChunker } from './chunker.js';
import { createEmbeddingProvider, validateVectors } from './embedding.js';
import { lexicalFingerprint } from './lexical.js';
import {
  headingStrategy,
  defaultTokenizer,
  profileChunker,
  profileTokenizer,
} from './profiles.js';
import { listMarkdown, type SyncResult } from './sync.js';
import {
  ensureProfileTables,
  initializeProfiles,
  profileTables,
  sqlName,
  publishIndex,
  scopeFingerprint,
  EchoError,
} from './profile-store.js';

interface SourceRow {
  source_id: string;
  collection_id: string;
  path: string;
  relative_path: string;
  source_version: string;
  chunker_fingerprint: string;
}
interface ChunkRow {
  rowid: number;
  source_id: string;
  text: string;
  retrieval_text: string;
  heading_path: string;
}
export async function syncProfiles(
  config: EchoConfig,
  signal?: AbortSignal,
  customProvider?: EmbeddingProvider | null,
): Promise<SyncResult> {
  if (!config.collections.length)
    throw new EchoError(
      'SOURCES_CONFIG',
      'No note collections configured',
      'Edit the sources configuration before sync',
    );
  const withVector =
    config.retrieval.mode !== 'bm25' && customProvider !== null;
  const t = profileTables(config, customProvider);
  if (withVector && !t.vector)
    throw new EchoError(
      'MODEL_CONFIG',
      'Embedding model settings are incomplete',
      'Configure the selected embedding profile',
    );
  const db = openDatabase(config.database, {
    busyTimeout: config.runtime.sqlite_busy_timeout_ms,
  });
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
    db.exec('BEGIN IMMEDIATE');
    initializeProfiles(db);
    ensureProfileTables(db, t, withVector);
    const sources = sqlName(t.sources),
      chunks = sqlName(t.chunks),
      fts = sqlName(t.fts);
    const prepared: {
      source: Awaited<ReturnType<typeof prepareSource>>;
      collection: string;
      path: string;
      relative: string;
    }[] = [];
    const inventories: {
      collection: EchoConfig['collections'][number];
      paths: string[];
    }[] = [];
    const seen = new Set<string>();
    for (const collection of config.collections) {
      signal?.throwIfAborted();
      const paths = await listMarkdown(collection.root, collection),
        root = await realpath(collection.root);
      inventories.push({ collection, paths });
      for (const path of paths) {
        signal?.throwIfAborted();
        const source = await prepareSource(path, collection.max_file_bytes);
        if (seen.has(source.sourceId))
          throw new Error(
            'Duplicate echo_id: ' + source.sourceId + ' at ' + path,
          );
        seen.add(source.sourceId);
        if (source.wroteId) result.wrote_ids++;
        prepared.push({
          source,
          collection: collection.id,
          path,
          relative: relative(root, path).replaceAll('\\', '/'),
        });
      }
    }
    // Import only the known equivalent built-in legacy rule and matching captured sources.
    // Legacy tables remain intact; all adoption and publication are inside this transaction.
    if (
      (db.prepare('SELECT count(*) AS n FROM ' + chunks).get() as { n: number })
        .n === 0
    ) {
      const max = Number(
        config.profile!.active.chunker.replace('heading-', ''),
      );
      const legacyMeta = Object.fromEntries(
        (
          db.prepare('SELECT key,value FROM meta').all() as {
            key: string;
            value: string;
          }[]
        ).map((r) => [r.key, r.value]),
      );
      if (
        Number.isInteger(max) &&
        config.profile!.chunker.code === headingStrategy(max)
      ) {
        const legacyChunker = await loadChunker({
          version: '1',
          options: { max_chars: max },
        });
        const legacyLexical = lexicalFingerprint({
          locale: 'zh-CN',
          dictionary: [],
        });
        if (legacyMeta.chunker_fingerprint === legacyChunker.fingerprint) {
          const combined = hash(
            JSON.stringify([
              legacyChunker.fingerprint,
              legacyMeta.lexical_fingerprint,
              legacyMeta.embedding_fingerprint || 'bm25-only',
            ]),
          );
          for (const item of prepared) {
            const old = db
              .prepare('SELECT * FROM sources WHERE source_id=?')
              .get(item.source.sourceId) as SourceRow | undefined;
            if (
              !old ||
              old.source_version !== item.source.sourceVersion ||
              old.path !== item.path ||
              old.collection_id !== item.collection ||
              old.relative_path !== item.relative ||
              old.chunker_fingerprint !== combined
            )
              continue;
            db.prepare(
              'INSERT OR IGNORE INTO ' + sources + ' VALUES (?,?,?,?,?,?)',
            ).run(
              old.source_id,
              old.collection_id,
              old.path,
              old.relative_path,
              old.source_version,
              config.profile!.chunker.fingerprint,
            );
            db.prepare(
              'INSERT OR IGNORE INTO ' +
                chunks +
                ' SELECT * FROM chunks WHERE source_id=?',
            ).run(old.source_id);
            if (
              config.profile!.tokenizer.code === defaultTokenizer &&
              legacyMeta.lexical_fingerprint === legacyLexical
            )
              db.prepare(
                'INSERT INTO ' +
                  fts +
                  '(rowid,title,body) SELECT f.rowid,f.title,f.body FROM chunk_fts f JOIN chunks c ON c.rowid=f.rowid WHERE c.source_id=? AND NOT EXISTS(SELECT 1 FROM ' +
                  fts +
                  ' x WHERE x.rowid=f.rowid)',
              ).run(old.source_id);
            if (
              withVector &&
              t.vector &&
              legacyMeta.embedding_fingerprint === t.embeddingFingerprint
            )
              db.prepare(
                'INSERT OR IGNORE INTO ' +
                  sqlName(t.vector.table) +
                  ' SELECT v.* FROM embeddings v JOIN chunks c ON c.rowid=v.chunk_rowid WHERE c.source_id=?',
              ).run(old.source_id);
          }
        }
      }
    }
    const previous = new Map(
      (db.prepare('SELECT * FROM ' + sources).all() as SourceRow[]).map((s) => [
        s.source_id,
        s,
      ]),
    );
    let invalidated = false;
    const invalidateChildren = () => {
      if (invalidated) return;
      // A restored corpus hash cannot revive FTS/vector rows removed by cascades.
      db.prepare("UPDATE echo_indexes SET corpus='' WHERE parent=?").run(
        t.chunk.key,
      );
      invalidated = true;
    };
    const chunker = await profileChunker(config.profile!.chunker);
    for (const item of prepared) {
      signal?.throwIfAborted();
      const { source, path } = item,
        old = previous.get(source.sourceId);
      if (
        old &&
        old.source_version === source.sourceVersion &&
        old.path === path &&
        old.collection_id === item.collection &&
        old.relative_path === item.relative
      ) {
        result.unchanged++;
        continue;
      }
      invalidateChildren();
      if (old) result.updated++;
      else result.added++;
      db.prepare(
        'INSERT INTO ' +
          sources +
          ' VALUES (?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET collection_id=excluded.collection_id,path=excluded.path,relative_path=excluded.relative_path,source_version=excluded.source_version,chunker_fingerprint=excluded.chunker_fingerprint',
      ).run(
        source.sourceId,
        item.collection,
        path,
        item.relative,
        source.sourceVersion,
        config.profile!.chunker.fingerprint,
      );
      const ranges = await runChunker(chunker, {
        sourceId: source.sourceId,
        path,
        lines: source.lines,
        options: {},
      });
      db.prepare('DELETE FROM ' + chunks + ' WHERE source_id=?').run(
        source.sourceId,
      );
      for (const c of ranges) {
        db.prepare(
          'INSERT INTO ' +
            chunks +
            '(chunk_id,source_id,text,retrieval_text,heading_path,start_line,end_line,section_start_line,section_end_line) VALUES (?,?,?,?,?,?,?,?,?)',
        ).run(
          hash(
            JSON.stringify([source.sourceId, c.startLine, c.endLine, c.text]),
          ),
          source.sourceId,
          c.text,
          [basename(path, '.md'), ...c.headingPath, c.text].join('\n'),
          JSON.stringify(c.headingPath),
          c.startLine,
          c.endLine,
          c.sectionStartLine ?? null,
          c.sectionEndLine ?? null,
        );
      }
    }
    for (const old of previous.values())
      if (!seen.has(old.source_id)) {
        invalidateChildren();
        db.prepare('DELETE FROM ' + sources + ' WHERE source_id=?').run(
          old.source_id,
        );
        result.removed++;
      }
    const tokenize = await profileTokenizer(config.profile!.tokenizer);
    const missingFts = db
      .prepare(
        'SELECT c.*,s.path FROM ' +
          chunks +
          ' c JOIN ' +
          sources +
          ' s USING(source_id) WHERE NOT EXISTS(SELECT 1 FROM ' +
          fts +
          ' f WHERE f.rowid=c.rowid)',
      )
      .all() as (ChunkRow & { path: string })[];
    for (const c of missingFts) {
      signal?.throwIfAborted();
      const title = await tokenize(
        [
          basename(c.path, '.md'),
          ...(JSON.parse(c.heading_path) as string[]),
        ].join('\n'),
      );
      const body = await tokenize(c.text);
      db.prepare(
        'INSERT INTO ' + fts + '(rowid,title,body) VALUES (?,?,?)',
      ).run(c.rowid, title.join(' '), body.join(' '));
    }
    if (withVector && t.vector) {
      const vectors = sqlName(t.vector.table);
      const missing = db
        .prepare(
          'SELECT c.* FROM ' +
            chunks +
            ' c WHERE NOT EXISTS(SELECT 1 FROM ' +
            vectors +
            ' v WHERE v.chunk_rowid=c.rowid)',
        )
        .all() as ChunkRow[];
      // Key availability is only required if new vectors really need to be generated.
      if (missing.length) {
        const provider =
          customProvider ?? createEmbeddingProvider(config.embedding);
        if (provider.fingerprint !== t.embeddingFingerprint)
          throw new Error('Embedding identity changed during sync');
        for (
          let offset = 0;
          offset < missing.length;
          offset += config.embedding.batch_size
        ) {
          signal?.throwIfAborted();
          const batch = missing.slice(
            offset,
            offset + config.embedding.batch_size,
          );
          const embeddings = validateVectors(
            await provider.embed(
              batch.map((c) => c.retrieval_text),
              'document',
              signal,
            ),
            batch.length,
            provider.dimensions,
          );
          for (const [index, c] of batch.entries())
            db.prepare('INSERT INTO ' + vectors + ' VALUES (?,?)').run(
              c.rowid,
              new Float32Array(embeddings[index]!),
            );
        }
      }
    }
    for (const { collection, paths } of inventories)
      if (
        JSON.stringify(await listMarkdown(collection.root, collection)) !==
        JSON.stringify(paths)
      )
        throw new Error('Collection changed while syncing; retry');
    for (const item of prepared)
      if (hash(await readFile(item.path, 'utf8')) !== item.source.sourceVersion)
        throw new Error('Source changed while syncing; retry: ' + item.path);
    signal?.throwIfAborted();
    const corpus = hash(
      JSON.stringify(
        prepared
          .map((p) => [
            p.source.sourceId,
            p.collection,
            p.path,
            p.relative,
            p.source.sourceVersion,
          ])
          .sort((a, b) => a[0]!.localeCompare(b[0]!)),
      ),
    );
    const scope = scopeFingerprint(config);
    publishIndex(db, t.chunk, corpus, scope);
    publishIndex(db, t.lexical, corpus, scope);
    if (withVector && t.vector) publishIndex(db, t.vector, corpus, scope);
    db.prepare(
      "INSERT INTO echo_state VALUES ('corpus',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(corpus);
    result.chunks = (
      db.prepare('SELECT count(*) AS n FROM ' + chunks).get() as { n: number }
    ).n;
    setMeta(db, 'index_revision', randomUUID());
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}
