import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { score, summarize } from './lib/evidence-metrics.mjs';

const hash = (x) => createHash('sha256').update(x).digest('hex');
const digest = async (p) => hash(await fs.readFile(p));
const get = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const json = (x) => JSON.stringify(x, null, 2) + '\n';
export function reviseLabels(dataset, revision) {
  assert.equal(
    dataset.split,
    'development',
    'Final labels are outside this revision',
  );
  const result = structuredClone(dataset);
  for (const change of revision.amendments) {
    const fact = result.facts.find((f) => f.id === change.fact_id);
    if (!fact) continue;
    assert.equal(
      hash(JSON.stringify(fact)),
      change.original_fact_sha256,
      'Original label drift',
    );
    assert.ok(change.additional_evidence.length > 0);
    for (const anchor of change.additional_evidence) {
      assert.ok(anchor.quote.trim());
      assert.equal(
        anchor.quote.split('\n').length,
        anchor.end_line - anchor.start_line + 1,
      );
      assert.ok(
        !fact.evidence.some(
          (a) => JSON.stringify(a) === JSON.stringify(anchor),
        ),
        'Duplicate amendment',
      );
      fact.evidence.push(anchor);
    }
  }
  assert.deepEqual(result.questions, dataset.questions);
  assert.deepEqual(result.corpus, dataset.corpus);
  return result;
}
const historicalRoots = [
  'development-bm25-2026-09-16-v2',
  'development-paired-bm25-2026-09-16-v1',
  'development-api-2026-09-17-v1',
  'development-parameters-2026-09-17-v1',
  'structure-ab-2026-09-17-v3',
  'structure-decomposition-2026-09-17-v1',
  'structure-source-limit-2026-09-17-v1',
  'structure-bm25-weight-2026-09-17-v1',
  'structure-rrf-k-2026-09-17-v1',
  'structure-title-weight-2026-09-17-v1',
  'structure-dense-threshold-2026-09-17-v1',
  'structure-context-budget-2026-09-17-v1',
  'structure-rrf-budget-combined-2026-09-18-v1',
  'structure-rrf40-budget16000-2026-09-18-v1',
  'structure-bm25-02-current-2026-09-18-v1',
  'structure-bm25-025-current-2026-09-18-v1',
  'structure-rrf10-current-2026-09-18-v1',
  'structure-bm25-03-rrf10-2026-09-18-v1',
  'structure-bm25-04-rrf10-2026-09-18-v1',
];
async function main() {
  const { values } = parseArgs({
    options: {
      lab: { type: 'string' },
      'run-id': { type: 'string' },
      revision: { type: 'string' },
      'new-run': { type: 'string' },
    },
  });
  assert.ok(
    values.lab &&
      values.revision &&
      /^[a-z0-9-]+$/.test(values['run-id'] ?? ''),
  );
  const lab = path.resolve(values.lab),
    evidence = path.join(lab, 'evidence'),
    out = path.join(evidence, values['run-id']);
  const revision = await get(values.revision);
  assert.equal(revision.scope, 'development');
  const roots = [
    ...historicalRoots,
    ...(values['new-run'] ? [values['new-run']] : []),
  ];
  if (values['new-run']) assert.match(values['new-run'], /^[a-z0-9-]+$/);
  // Validate before creating a versioned output; never modify original reports or labels.
  const dirs = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (
      entries.some((e) => e.name === 'report.json') &&
      entries.some((e) => e.name === 'dataset.json')
    )
      dirs.push(dir);
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !['query-responses', 'reviews', 'comparisons'].includes(entry.name)
      )
        await walk(path.join(dir, entry.name));
  }
  for (const name of roots) await walk(path.join(evidence, name));
  await fs.mkdir(out);
  await fs.mkdir(path.join(out, 'datasets'));
  await fs.copyFile(
    fileURLToPath(import.meta.url),
    path.join(out, 'execution-analyzer.mjs'),
    fs.constants.COPYFILE_EXCL,
  );
  const sources = new Map(),
    groups = new Map(),
    artifacts = [],
    datasetCopies = new Set(),
    rowChanges = [];
  let rowsChecked = 0,
    piecesChecked = 0;
  async function source(file) {
    if (!sources.has(file)) {
      const text = await fs.readFile(file, 'utf8');
      sources.set(file, {
        hash: hash(text),
        lines: text.replaceAll('\r\n', '\n').split('\n'),
      });
    }
    return sources.get(file);
  }
  for (const dir of dirs) {
    const data = await get(path.join(dir, 'dataset.json')),
      manifest = await get(path.join(dir, 'manifest.json')),
      report = await get(path.join(dir, 'report.json'));
    assert.equal(data.split, 'development');
    assert.equal(report.status, 'complete');
    const rows = (await fs.readFile(path.join(dir, 'rows.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse);
    assert.deepEqual(rows, report.rows);
    assert.equal(
      await digest(path.join(dir, 'dataset.json')),
      manifest.dataset.sha256,
    );
    assert.equal(rows.length, data.questions.length);
    const amended = reviseLabels(data, revision),
      dataSha = hash(json(amended));
    if (!datasetCopies.has(dataSha)) {
      await fs.writeFile(
        path.join(out, 'datasets', dataSha + '.json'),
        json(amended),
        { flag: 'wx' },
      );
      datasetCopies.add(dataSha);
    }
    const relative = path.relative(evidence, dir).replaceAll('\\', '/');
    const rootName = relative.split('/')[0],
      leaf = path.basename(dir);
    const scope = leaf.match(/^(A|B|C|mixed)-development-/)?.[1] ?? 'paired';
    const condition =
      rootName + '/' + leaf.replace(/^(A|B|C|mixed)-development-/, '');
    if (!groups.has(condition))
      groups.set(condition, {
        condition,
        root: rootName,
        variant: leaf.replace(/^(A|B|C|mixed)-development-/, ''),
        selection: manifest.selection,
        retrieval: manifest.retrieval,
        budget_chars: manifest.budget_chars,
        old: [],
        revised: [],
        byScope: {},
        context_chars: 0,
        chunks: 0,
        budget_exclusions: 0,
        under_topk: 0,
        changes: [],
        runs: [],
      });
    const group = groups.get(condition);
    assert.deepEqual(group.retrieval, manifest.retrieval);
    assert.equal(group.budget_chars, manifest.budget_chars);
    const oldScores = [],
      newScores = [];
    for (const [i, row] of rows.entries()) {
      const q = data.questions[i];
      assert.equal(row.query_id, q.id);
      assert.equal(row.status, 'ok');
      assert.equal(row.request_chars, JSON.stringify(row.request).length);
      assert.equal(row.response_chars, JSON.stringify(row.result).length);
      assert.equal(row.context_chars, row.request_chars + row.response_chars);
      assert.ok(row.context_chars <= manifest.budget_chars);
      assert.ok(row.result.results.length <= manifest.retrieval.topk);
      const counts = new Map();
      for (const piece of row.result.results) {
        const src = await source(piece.path);
        assert.equal(src.hash, piece.source_version);
        const bound = data.corpus.find(
          (s) =>
            s.collection_id === piece.collection_id &&
            s.path === piece.relative_path,
        );
        assert.ok(bound);
        assert.equal(src.hash, bound.sha256);
        assert.equal(
          src.lines.slice(piece.start_line - 1, piece.end_line).join('\n'),
          piece.text,
        );
        counts.set(piece.source_id, (counts.get(piece.source_id) ?? 0) + 1);
        piecesChecked++;
      }
      assert.ok(
        [...counts.values()].every(
          (n) => n <= manifest.retrieval.max_chunks_per_source,
        ),
      );
      const oldScore = score(q, data.facts, row.result.results),
        newScore = score(q, amended.facts, row.result.results);
      if (!oldScore.noAnswer)
        assert.deepEqual(oldScore.fullCovered, row.covered_facts);
      oldScores.push(oldScore);
      newScores.push(newScore);
      rowsChecked++;
      group.context_chars += row.context_chars;
      group.chunks += row.result.results.length;
      group.budget_exclusions += Number(row.result.excluded.budget > 0);
      group.under_topk += Number(
        row.result.results.length < manifest.retrieval.topk,
      );
      // K1/3/5 changes matter even when K10 was already complete.
      if (JSON.stringify(oldScore) !== JSON.stringify(newScore)) {
        const change = {
          condition,
          id: q.id,
          old: oldScore,
          revised: newScore,
        };
        group.changes.push(change);
        rowChanges.push(change);
      }
    }
    group.old.push(...oldScores);
    group.revised.push(...newScores);
    assert.ok(!group.byScope[scope], 'Duplicate scope in one condition');
    group.byScope[scope] = {
      old: summarize(oldScores),
      revised: summarize(newScores),
    };
    group.runs.push({
      dir: relative,
      original_dataset_sha256: manifest.dataset.sha256,
      revised_dataset_sha256: dataSha,
    });
    for (const name of [
      'dataset.json',
      'manifest.json',
      'rows.jsonl',
      'report.json',
    ])
      artifacts.push({
        file: relative + '/' + name,
        sha256: await digest(path.join(dir, name)),
      });
  }
  const conditions = [...groups.values()].map(({ old, revised, ...g }) => ({
    ...g,
    old: summarize(old),
    revised: summarize(revised),
  }));
  const summary = {
    status: 'complete',
    revision_id: revision.id,
    revision_sha256: await digest(values.revision),
    roots,
    conditions,
    runs_checked: dirs.length,
    rows_checked: rowsChecked,
    pieces_checked: piecesChecked,
    new_retrieval_calls: 0,
    final_queries: 0,
    network_requests: 0,
    dataset_variants: datasetCopies.size,
    changed_rows: rowChanges.length,
    source_hashes: [...sources.values()].map((s) => s.hash).sort(),
    artifacts,
    code: {
      analyzer: await digest(fileURLToPath(import.meta.url)),
      metrics: await digest(
        new URL('./lib/evidence-metrics.mjs', import.meta.url),
      ),
    },
  };
  await fs.writeFile(path.join(out, 'rescore.public.json'), json(summary), {
    flag: 'wx',
  });
  console.log(
    json({
      conditions: conditions.length,
      runs: dirs.length,
      rows: rowsChecked,
      pieces: piecesChecked,
      changed_rows: rowChanges.length,
      latest: conditions
        .filter(
          (c) =>
            c.root === values['new-run'] ||
            c.root === 'structure-rrf10-current-2026-09-18-v1',
        )
        .map((c) => ({
          id: c.condition,
          old: c.old.k[10],
          revised: c.revised.k[10],
        })),
    }),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
