import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { runtimeContext } from './lib/public-runtime.mjs';
import {
  jsonLines,
  lastRowsById,
  digest,
} from './prepare-public-benchmarks.mjs';
const root = path.resolve(process.argv[2] ?? ''),
  scope = process.argv[3],
  phase = process.argv[4];
assert.ok(
  process.argv[2] &&
    ['langchain', 'godot', 'du'].includes(scope) &&
    ['index', 'vectors', 'run'].includes(phase),
);
const ctx = await runtimeContext(root);
const dir = path.join(root, 'fixed');
await fs.mkdir(dir, { recursive: true });
const corpusFile = path.join(
  root,
  'data',
  scope === 'du' ? 'du-corpus.jsonl' : 'freshstack-' + scope + '-corpus.jsonl',
);
const dbFile = path.join(dir, scope + '.sqlite');
const config = ctx.parseConfig({
  database: dbFile,
  embedding: ctx.plan.config,
  retrieval: { rrf_k: 30 },
});
try {
  if (phase === 'index') {
    const db = ctx.openDatabase(dbFile);
    try {
      ctx.initializeStore(db);
      assert.equal(
        db.prepare('SELECT count(*) n FROM chunks').get().n,
        0,
        'Refuse rebuilding existing fixed index',
      );
      const rows = await lastRowsById(corpusFile);
      const sources = db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?)');
      const chunks = db.prepare(
        'INSERT INTO chunks(chunk_id,source_id,text,retrieval_text,heading_path,start_line,end_line,section_start_line,section_end_line) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      const fts = db.prepare(
        'INSERT INTO chunk_fts(rowid,title,body) VALUES (?,?,?)',
      );
      db.exec('BEGIN');
      let n = 0;
      try {
        for (const [id, row] of rows) {
          const text = row.text,
            version = digest(text);
          sources.run(
            id,
            scope,
            corpusFile,
            id,
            version,
            'official-fixed-unit-v1',
          );
          const inserted = chunks.run(
            id,
            id,
            text,
            text,
            '[]',
            1,
            text.split('\n').length,
            null,
            null,
          );
          fts.run(
            inserted.lastInsertRowid,
            '',
            ctx.tokenize(text, config.lexical).join(' '),
          );
          n++;
          if (n % 5000 === 0)
            console.log(
              JSON.stringify({ scope, indexed: n, total: rows.size }),
            );
        }
        ctx.setMeta(db, 'embedding_fingerprint', ctx.plan.fingerprint);
        ctx.setMeta(
          db,
          'lexical_fingerprint',
          ctx.lexicalFingerprint(config.lexical),
        );
        ctx.setMeta(db, 'last_sync', new Date().toISOString());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      const receipt = {
        scope,
        unique_documents: rows.size,
        corpus_sha256: digest(await fs.readFile(corpusFile)),
        duplicate_policy: 'official external ID; last input row wins',
        title_field: 'empty; original official text only',
        retrieval_adapter:
          'production retrieveQuery; not MCP/importer end-to-end',
        config,
      };
      await fs.writeFile(
        path.join(dir, scope + '-index.json'),
        JSON.stringify(receipt, null, 2) + '\n',
      );
      console.log(JSON.stringify({ scope, index_complete: rows.size }));
    } finally {
      db.close();
    }
  } else if (phase === 'vectors') {
    const db = ctx.openDatabase(dbFile);
    try {
      const rows = db
        .prepare(
          'SELECT c.rowid,c.text FROM chunks c LEFT JOIN embeddings e ON e.chunk_rowid=c.rowid WHERE e.chunk_rowid IS NULL',
        )
        .all();
      const put = db.prepare('INSERT INTO embeddings VALUES (?,?)');
      db.exec('BEGIN');
      try {
        for (const r of rows)
          put.run(r.rowid, new Float32Array(ctx.getVector('document', r.text)));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      const total = db.prepare('SELECT count(*) n FROM chunks').get().n;
      assert.equal(
        db.prepare('SELECT count(*) n FROM embeddings').get().n,
        total,
      );
      console.log(
        JSON.stringify({ scope, vectors: total, inserted: rows.length }),
      );
    } finally {
      db.close();
    }
  } else {
    const db = ctx.openDatabase(dbFile, { readOnly: true });
    try {
      const total = db.prepare('SELECT count(*) n FROM chunks').get().n;
      assert.equal(
        db.prepare('SELECT count(*) n FROM embeddings').get().n,
        total,
        'Cannot run partially embedded corpus',
      );
      const queryFile = path.join(
        root,
        'data',
        scope === 'du'
          ? 'du-queries.jsonl'
          : 'freshstack-' + scope + '-queries.jsonl',
      );
      const queries = [];
      for await (const q of jsonLines(queryFile))
        queries.push({
          id: q.query_id ?? q.id,
          text:
            scope === 'du'
              ? q.text.trim()
              : (q.query_title + ' ' + q.query_text).trim(),
        });
      assert.equal(new Set(queries.map((q) => q.id)).size, queries.length);
      assert.equal(
        queries.length,
        { langchain: 203, godot: 99, du: 2000 }[scope],
      );
      const before = digest(await fs.readFile(dbFile));
      for (const k of [30, 10]) {
        const file = await fs.open(
          path.join(dir, scope + '-rrf' + k + '.jsonl'),
          'wx',
        );
        let n = 0;
        try {
          for (const q of queries) {
            const started = performance.now();
            const result = await ctx.retrieveQuery(
              db,
              config,
              q.id,
              q.text,
              {},
              { ...config.retrieval, rrf_k: k },
              ctx.provider,
            );
            const ms = performance.now() - started;
            assert.ok(
              ['ok', 'empty'].includes(result.status),
              'Retrieval failure ' + result.status,
            );
            const rankings = result.candidates.map((c, i) => ({
              id: c.evidence.chunk_id,
              rank: i + 1,
              rank_score: result.candidates.length - i,
              rrf_score: c.score,
              bm25_rank: c.bm25_rank ?? null,
              dense_rank: c.dense_rank ?? null,
              similarity: c.similarity ?? null,
            }));
            await file.write(
              JSON.stringify({
                id: q.id,
                query_chars: q.text.length,
                rrf_k: k,
                candidates: result.counts,
                rankings,
                offline_ms: ms,
              }) + '\n',
            );
            n++;
            if (n % 100 === 0)
              console.log(
                JSON.stringify({
                  scope,
                  rrf: k,
                  completed: n,
                  total: queries.length,
                }),
              );
          }
        } finally {
          await file.close();
        }
        console.log(
          JSON.stringify({ scope, rrf: k, completed: n, index_sha256: before }),
        );
      }
      assert.equal(
        digest(await fs.readFile(dbFile)),
        before,
        'Query mutated fixed index',
      );
    } finally {
      db.close();
    }
  }
} finally {
  ctx.cache.close();
}
