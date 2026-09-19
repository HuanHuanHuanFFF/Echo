import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeContext, qasperScore } from './lib/public-runtime.mjs';
import { jsonLines, digest } from './prepare-public-benchmarks.mjs';
const root = path.resolve(process.argv[2]),
  ctx = await runtimeContext(root);
try {
  const docs = new Map();
  for await (const d of jsonLines(
    path.join(root, 'prepared/qasper-docs.jsonl'),
  ))
    docs.set(d.id, { ...d, markdown: await fs.readFile(d.file, 'utf8') });
  const queries = new Map();
  for await (const q of jsonLines(
    path.join(root, 'prepared/qasper-queries.jsonl'),
  ))
    queries.set(q.id, q);
  const { profileTables } = await ctx.load('profile-store'),
    { profileTokenizer } = await ctx.load('profiles');
  const all = [];
  for (const arm of ['p0', 'p1', 'p2']) {
    const cfg = await ctx.loadConfig(path.join(root, 'qasper', arm + '.json')),
      db = ctx.openDatabase(cfg.database, { readOnly: true });
    const index = {
      ...profileTables(cfg, ctx.provider),
      tokenize: await profileTokenizer(cfg.profile.tokenizer),
    };
    const before = digest(await fs.readFile(cfg.database));
    let examined = 0;
    try {
      for await (const row of jsonLines(
        path.join(root, 'qasper', arm + '-results.jsonl'),
      )) {
        if (!row.score.eligible || row.score.strict_complete) continue;
        const q = queries.get(row.id),
          doc = docs.get(q.paper_id);
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
        assert.ok(['ok', 'empty'].includes(pool.status), pool.error);
        const pieces = pool.candidates.map((c) => c.evidence);
        const prefix3 = qasperScore(
          q,
          doc,
          { results: pieces.slice(0, 3) },
          doc.markdown,
        );
        assert.equal(prefix3.strict_complete, row.score.strict_complete);
        assert.ok(
          Math.abs(prefix3.strict_coverage - row.score.strict_coverage) < 1e-12,
        );
        let first = null;
        for (let k = 4; k <= pieces.length; k++)
          if (
            qasperScore(q, doc, { results: pieces.slice(0, k) }, doc.markdown)
              .strict_complete
          ) {
            first = k;
            break;
          }
        all.push({
          arm,
          id: q.id,
          paper_id: q.paper_id,
          candidate_count: pieces.length,
          complete_group_first_prefix: first,
          observed_returned: row.result.results.length,
          observed_excluded: row.result.excluded,
        });
        examined++;
        if (examined % 100 === 0)
          console.log(JSON.stringify({ arm, diagnosed: examined }));
      }
    } finally {
      db.close();
    }
    assert.equal(digest(await fs.readFile(cfg.database)), before);
  }
  const summary = Object.fromEntries(
    ['p0', 'p1', 'p2'].map((arm) => {
      const rows = all.filter((r) => r.arm === arm);
      return [
        arm,
        {
          incomplete: rows.length,
          complete_support_in_candidates: rows.filter(
            (r) => r.complete_group_first_prefix !== null,
          ).length,
          no_complete_group_in_candidates: rows.filter(
            (r) => r.complete_group_first_prefix === null,
          ).length,
          prefix_histogram: Object.fromEntries(
            [...new Set(rows.map((r) => r.complete_group_first_prefix))].map(
              (k) => [
                String(k),
                rows.filter((r) => r.complete_group_first_prefix === k).length,
              ],
            ),
          ),
        },
      ];
    }),
  );
  await fs.writeFile(
    path.join(root, 'analysis/qasper-candidate-diagnosis.json'),
    JSON.stringify(
      {
        summary,
        rows: all,
        scope:
          'Same input/parameters; offline candidate tracing; no relaxed-limit result claimed.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(summary));
} finally {
  ctx.cache.close();
}
