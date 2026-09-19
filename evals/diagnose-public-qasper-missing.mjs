import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeContext } from './lib/public-runtime.mjs';
import { jsonLines } from './prepare-public-benchmarks.mjs';
const root = path.resolve(process.argv[2]),
  ctx = await runtimeContext(root),
  out = [];
try {
  const qs = new Map();
  for await (const q of jsonLines(
    path.join(root, 'prepared/qasper-queries.jsonl'),
  ))
    qs.set(q.id, q);
  const docs = new Map();
  for await (const d of jsonLines(
    path.join(root, 'prepared/qasper-docs.jsonl'),
  ))
    docs.set(d.id, d);
  const diag = JSON.parse(
    await fs.readFile(
      path.join(root, 'analysis/qasper-candidate-diagnosis.json'),
      'utf8',
    ),
  );
  const cfg = await ctx.loadConfig(path.join(root, 'qasper/p2.json'));
  const { profileTables, sqlName } = await ctx.load('profile-store'),
    { profileTokenizer } = await ctx.load('profiles'),
    { validateVectors } = await ctx.load('embedding');
  const index = {
      ...profileTables(cfg, ctx.provider),
      tokenize: await profileTokenizer(cfg.profile.tokenizer),
    },
    db = ctx.openDatabase(cfg.database, { readOnly: true });
  try {
    for (const item of diag.rows.filter(
      (r) => r.arm === 'p2' && r.complete_group_first_prefix === null,
    )) {
      const q = qs.get(item.id),
        doc = docs.get(q.paper_id),
        vector = validateVectors(
          [ctx.getVector('query', q.text.trim())],
          1,
          1024,
        )[0];
      const all = db
        .prepare(
          'SELECT c.chunk_id,c.start_line,c.end_line,c.text,vec_distance_cosine(v.embedding,?) distance FROM ' +
            sqlName(index.chunks) +
            ' c JOIN ' +
            sqlName(index.vectors) +
            ' v ON v.chunk_rowid=c.rowid WHERE c.source_id=? ORDER BY distance,c.chunk_id',
        )
        .all(new Float32Array(vector), q.source_id);
      const pool = await ctx.retrieveQuery(
        db,
        cfg,
        'q0',
        q.text.trim(),
        { source_ids: [q.source_id] },
        cfg.retrieval,
        ctx.provider,
        undefined,
        undefined,
        index,
      );
      const covered = new Set(
        pool.candidates.flatMap((c) =>
          Array.from(
            { length: c.evidence.end_line - c.evidence.start_line + 1 },
            (_, i) => i + c.evidence.start_line,
          ),
        ),
      );
      const missing = [];
      for (const a of q.annotations.filter((a) => a.valid))
        for (const e of a.evidence) {
          if (
            e.paragraph_ids.some((id) => {
              const p = doc.paragraphs[id];
              return Array.from(
                { length: p.end_line - p.start_line + 1 },
                (_, i) => i + p.start_line,
              ).every((n) => covered.has(n));
            })
          )
            continue;
          const supporting = all
            .map((c, i) => ({ ...c, unfiltered_dense_rank: i + 1 }))
            .filter((c) =>
              e.paragraph_ids.some((id) => {
                const p = doc.paragraphs[id];
                return c.start_line <= p.start_line && c.end_line >= p.end_line;
              }),
            );
          missing.push({
            annotation: a.id,
            paragraph_ids: e.paragraph_ids,
            supporting_chunks: supporting.map((c) => ({
              id: c.chunk_id,
              start: c.start_line,
              end: c.end_line,
              unfiltered_dense_rank: c.unfiltered_dense_rank,
              cosine: 1 - c.distance,
              in_bm25:
                pool.candidates.find((x) => x.evidence.chunk_id === c.chunk_id)
                  ?.bm25_rank ?? null,
            })),
          });
        }
      out.push({
        id: q.id,
        paper_id: q.paper_id,
        question: q.text,
        index_chunks: all.length,
        returned_candidates: pool.candidates.length,
        missing,
      });
    }
  } finally {
    db.close();
  }
  await fs.writeFile(
    path.join(root, 'analysis/qasper-candidate-missing-detail.json'),
    JSON.stringify(
      {
        scope:
          'Same-query diagnostic of three candidate misses; no changed-parameter run',
        rows: out,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(out));
} finally {
  ctx.cache.close();
}
