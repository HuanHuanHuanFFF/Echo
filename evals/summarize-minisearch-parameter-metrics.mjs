import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [privateRootArg, outArg] = process.argv.slice(2);
assert.ok(
  privateRootArg && outArg,
  'Usage: node evals/summarize-minisearch-parameter-metrics.mjs PRIVATE_ROOT OUT',
);
const privateRoot = path.resolve(privateRootArg);
const out = path.resolve(outArg);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const scopes = [
  'A-test',
  'B-test',
  'C-test',
  'D-test',
  'mixed-test',
  'paired-test',
];
const primaryScopes = scopes.slice(0, 5);
const freeze = await readJson(path.join(out, 'freeze.json'));
const arms = Object.keys(freeze.arms);
const labels = [
  ...arms.flatMap((arm) => [`${arm}-hybrid`, `${arm}-bm25`]),
  'dense-reference',
];
const ks = [1, 3, 5, 10];

const privateInfo = {
  'A-test': {
    database: 'A-development.sqlite',
    dataset: 'A-test.dataset.json',
  },
  'B-test': {
    database: 'B-development.sqlite',
    dataset: 'B-test.dataset.json',
  },
  'C-test': {
    database: 'C-development.sqlite',
    dataset: 'C-test.dataset.json',
  },
  'D-test': { database: 'D-test.sqlite', dataset: 'D-test.dataset.json' },
  'mixed-test': {
    database: 'mixed-test.sqlite',
    dataset: 'mixed-test.dataset.json',
  },
  'paired-test': {
    database: 'mixed-test.sqlite',
    dataset: 'paired-test.dataset.json',
  },
};

function key(collection, relative) {
  return JSON.stringify([collection, relative]);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readJsonl(file) {
  const rows = [];
  for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/))
    if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}

function quote(name) {
  assert.match(name, /^[a-z][a-z0-9_]*$/);
  return `"${name}"`;
}

function tableCount(db, name) {
  return db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get().n;
}

function sourceTable(db) {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .pluck()
    .all()
    .filter((name) => name === 'sources' || name.startsWith('sources_'));
  assert.ok(names.length);
  return names
    .map((name) => ({ name, count: tableCount(db, name) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0].name;
}

async function loadSources(database) {
  const db = new Database(database, { readonly: true });
  const table = sourceTable(db);
  const rows = db
    .prepare(
      `SELECT source_id,collection_id,relative_path,path,source_version FROM ${quote(table)}`,
    )
    .all();
  db.close();
  const sources = new Map();
  for (const row of rows)
    sources.set(key(row.collection_id, row.relative_path), {
      ...row,
      lines: (await fs.readFile(row.path, 'utf8')).split('\n'),
    });
  return sources;
}

function factCovered(fact, pieces, sources) {
  return fact.evidence.some((anchor) => {
    const source = sources.get(key(anchor.collection_id, anchor.path));
    assert.ok(source, `Missing source ${anchor.collection_id}/${anchor.path}`);
    const matching = pieces.filter(
      (piece) =>
        piece.collection_id === anchor.collection_id &&
        piece.relative_path === anchor.path,
    );
    for (let line = anchor.start_line; line <= anchor.end_line; line++)
      if (
        source.lines[line - 1]?.trim() &&
        !matching.some(
          (piece) => piece.start_line <= line && piece.end_line >= line,
        )
      )
        return false;
    return true;
  });
}

function prefixMetrics(question, dataset, pieces, sources, k) {
  const prefix = pieces.slice(0, k);
  const covered = question.required_facts.filter((id) =>
    factCovered(
      dataset.facts.find((fact) => fact.id === id),
      prefix,
      sources,
    ),
  );
  let singleRank = 0;
  for (let index = 0; index < prefix.length; index++) {
    const piece = prefix[index];
    if (
      question.required_facts.some((id) =>
        factCovered(
          dataset.facts.find((fact) => fact.id === id),
          [piece],
          sources,
        ),
      )
    ) {
      singleRank = index + 1;
      break;
    }
  }
  let firstFactRank = 0;
  for (let index = 0; index < prefix.length; index++) {
    if (
      question.required_facts.some((id) =>
        factCovered(
          dataset.facts.find((fact) => fact.id === id),
          prefix.slice(0, index + 1),
          sources,
        ),
      )
    ) {
      firstFactRank = index + 1;
      break;
    }
  }
  return {
    covered: covered.length,
    expected: question.required_facts.length,
    complete: covered.length === question.required_facts.length,
    any: covered.length > 0,
    single_hit: singleRank > 0,
    single_rr: singleRank ? 1 / singleRank : 0,
    first_fact_rr: firstFactRank ? 1 / firstFactRank : 0,
  };
}

function aggregate(rows, dataset, sources) {
  const answerable = rows.filter((row) => !row.no_answer);
  const byK = {};
  for (const k of ks) {
    const values = answerable.map((row) =>
      prefixMetrics(
        dataset.questions.find((question) => question.id === row.query_id),
        dataset,
        row.result.results,
        sources,
        k,
      ),
    );
    const covered = values.reduce((sum, value) => sum + value.covered, 0);
    const expected = values.reduce((sum, value) => sum + value.expected, 0);
    byK[k] = {
      strict_single_chunk_hit: `${values.filter((value) => value.single_hit).length}/${answerable.length}`,
      strict_single_chunk_mrr:
        values.reduce((sum, value) => sum + value.single_rr, 0) /
        answerable.length,
      fact_recall_micro: `${covered}/${expected}`,
      fact_recall_micro_rate: covered / expected,
      fact_recall_macro:
        values.reduce((sum, value) => sum + value.covered / value.expected, 0) /
        answerable.length,
      complete: `${values.filter((value) => value.complete).length}/${answerable.length}`,
      prefix_any_fact_hit: `${values.filter((value) => value.any).length}/${answerable.length}`,
      prefix_first_fact_rr:
        values.reduce((sum, value) => sum + value.first_fact_rr, 0) /
        answerable.length,
    };
  }
  return {
    questions: rows.length,
    answerable: answerable.length,
    no_answer: rows.length - answerable.length,
    byK,
  };
}

const result = {
  status: 'complete',
  created_at: new Date().toISOString(),
  source:
    'existing private retrieval JSONL; no new retrieval or embedding calls',
  primary: {},
  paired: {},
};
const sourceCache = new Map();
for (const scope of scopes) {
  const info = privateInfo[scope];
  const database = ['A-test', 'B-test', 'C-test'].includes(scope)
    ? path.join(
        privateRoot,
        '.echo',
        'structure-ab-2026-09-17-v3',
        info.database,
      )
    : path.join(
        privateRoot,
        '.echo',
        'final-four-arms-2026-09-18-v3',
        info.database,
      );
  const sources = sourceCache.get(database) ?? (await loadSources(database));
  sourceCache.set(database, sources);
  const dataset = await readJson(
    path.join(
      privateRoot,
      'evidence',
      'frozen-evaluation-2026-09-16-v1',
      info.dataset,
    ),
  );
  const scopeOutput = {};
  for (const label of labels) {
    const rows = await readJsonl(
      path.join(out, 'private', scope, `${label}.jsonl`),
    );
    assert.equal(rows.length, dataset.questions.length);
    scopeOutput[label] = aggregate(rows, dataset, sources);
  }
  (primaryScopes.includes(scope) ? result.primary : result.paired)[scope] =
    scopeOutput;
}
result.primary_overall = {};
for (const label of labels) {
  const parts = primaryScopes.map((scope) => result.primary[scope][label]);
  const answerable = parts.reduce((sum, part) => sum + part.answerable, 0);
  const byK = {};
  for (const k of ks) {
    const values = parts.map((part) => part.byK[k]);
    const parse = (value) => value.split('/').map(Number);
    const hit = values.reduce(
      (sum, value) => sum + parse(value.strict_single_chunk_hit)[0],
      0,
    );
    const hitDen = values.reduce(
      (sum, value) => sum + parse(value.strict_single_chunk_hit)[1],
      0,
    );
    const fact = values.reduce(
      (sum, value) => sum + parse(value.fact_recall_micro)[0],
      0,
    );
    const factDen = values.reduce(
      (sum, value) => sum + parse(value.fact_recall_micro)[1],
      0,
    );
    const complete = values.reduce(
      (sum, value) => sum + parse(value.complete)[0],
      0,
    );
    const any = values.reduce(
      (sum, value) => sum + parse(value.prefix_any_fact_hit)[0],
      0,
    );
    byK[k] = {
      strict_single_chunk_hit: `${hit}/${hitDen}`,
      strict_single_chunk_mrr:
        values.reduce(
          (sum, value) =>
            sum +
            value.strict_single_chunk_mrr *
              value.prefix_any_fact_hit.split('/').map(Number)[1],
          0,
        ) / answerable,
      fact_recall_micro: `${fact}/${factDen}`,
      fact_recall_micro_rate: fact / factDen,
      fact_recall_macro:
        values.reduce(
          (sum, value) =>
            sum +
            value.fact_recall_macro *
              value.prefix_any_fact_hit.split('/').map(Number)[1],
          0,
        ) / answerable,
      complete: `${complete}/${answerable}`,
      prefix_any_fact_hit: `${any}/${answerable}`,
      prefix_first_fact_rr:
        values.reduce(
          (sum, value) =>
            sum +
            value.prefix_first_fact_rr *
              value.prefix_any_fact_hit.split('/').map(Number)[1],
          0,
        ) / answerable,
    };
  }
  result.primary_overall[label] = { questions: 200, answerable, byK };
}
await fs.writeFile(
  path.join(out, 'private-score.json'),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(
  JSON.stringify({ status: result.status, scopes, conditions: labels.length }),
);
