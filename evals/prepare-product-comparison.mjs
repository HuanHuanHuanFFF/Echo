import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSource } from '../dist/identity.js';
import { openDatabase } from '../dist/database.js';
import {
  discoverTables,
  publicQueryText,
} from './run-minisearch-parameter-exploration.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const SCOPES = {
  'A-test': ['structure-ab-2026-09-17-v3', 'A-development.sqlite', 50, 150],
  'B-test': ['structure-ab-2026-09-17-v3', 'B-development.sqlite', 35],
  'C-test': ['structure-ab-2026-09-17-v3', 'C-development.sqlite', 25],
  'D-test': ['final-four-arms-2026-09-18-v3', 'D-test.sqlite', 30],
  'mixed-test': ['final-four-arms-2026-09-18-v3', 'mixed-test.sqlite', 60],
};

async function shaFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function* jsonLines(file) {
  let pending = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (pending.trim()) yield JSON.parse(pending);
}

export function sourceDocument(raw, metadata) {
  const parsed = parseSource(raw);
  assert.equal(digest(raw), metadata.source_version, 'Source content changed');
  assert.equal(parsed.sourceId, metadata.source_id, 'Source identity changed');
  const bodyStart = parsed.frontmatterEnd + 1;
  const text = parsed.lines.slice(bodyStart).join('\n');
  return {
    id: metadata.source_id,
    collection_id: metadata.collection_id,
    relative_path: metadata.relative_path,
    title: path.basename(metadata.relative_path),
    source_path: metadata.path,
    source_sha256: metadata.source_version,
    original_first_line: bodyStart + 1,
    text,
    text_sha256: digest(text),
  };
}

async function writeRows(file, rows) {
  const handle = await fs.open(file, 'wx');
  try {
    for (const row of rows) await handle.write(JSON.stringify(row) + '\n');
  } finally {
    await handle.close();
  }
}

async function fileReceipt(file) {
  return {
    path: file,
    bytes: (await fs.stat(file)).size,
    sha256: await shaFile(file),
  };
}

async function privateScope(root, out, scope, spec) {
  const [folder, dbName, expectedQueries, expectedSources] = spec;
  const database = path.join(root, '.echo', folder, dbName);
  const labelFile = path.join(
    root,
    'evidence/frozen-evaluation-2026-09-16-v1',
    `${scope}.dataset.json`,
  );
  const labels = JSON.parse(await fs.readFile(labelFile, 'utf8'));
  assert.equal(labels.questions.length, expectedQueries);
  const before = await shaFile(database);
  const db = openDatabase(database, { readOnly: true });
  let sources;
  try {
    const tables = discoverTables(db);
    assert.match(tables.sources, /^[a-z0-9_]+$/);
    sources = db
      .prepare(
        `SELECT source_id,collection_id,path,relative_path,source_version FROM "${tables.sources}" ORDER BY source_id`,
      )
      .all();
  } finally {
    db.close();
  }
  if (expectedSources !== undefined)
    assert.equal(sources.length, expectedSources);
  assert.equal(
    new Set(sources.map((row) => row.source_id)).size,
    sources.length,
  );
  const documents = [];
  for (const source of sources)
    documents.push(
      sourceDocument(await fs.readFile(source.path, 'utf8'), source),
    );
  const queries = labels.questions.map((q) => ({
    id: q.id,
    text: q.query.trim(),
    queries: (q.subquestions ?? [{ id: 'q0', text: q.query }]).map((sub) => ({
      id: sub.id,
      text: sub.text.trim(),
    })),
  }));
  const corpusFile = path.join(out, `${scope}-documents.jsonl`);
  const queryFile = path.join(out, `${scope}-queries.jsonl`);
  await writeRows(corpusFile, documents);
  await writeRows(queryFile, queries);
  assert.equal(
    await shaFile(database),
    before,
    'Source database changed during export',
  );
  return {
    kind: 'full-document',
    documents: documents.length,
    questions: queries.length,
    query_inputs: queries.reduce((sum, row) => sum + row.queries.length, 0),
    answerable: labels.questions.filter((q) => !q.no_answer).length,
    facts: labels.facts.length,
    source_database: { path: database, sha256: before },
    labels: await fileReceipt(labelFile),
    corpus: await fileReceipt(corpusFile),
    queries: await fileReceipt(queryFile),
  };
}

async function qasperScope(root, out) {
  const docsFile = path.join(root, 'prepared/qasper-docs.jsonl');
  const queriesFile = path.join(root, 'prepared/qasper-queries.jsonl');
  const documents = [];
  for await (const row of jsonLines(docsFile)) {
    const raw = await fs.readFile(row.file, 'utf8');
    documents.push(
      sourceDocument(raw, {
        source_id: row.source_id,
        collection_id: 'qasper',
        relative_path: row.relative_path,
        path: row.file,
        source_version: row.sha256,
      }),
    );
  }
  const queries = [];
  for await (const row of jsonLines(queriesFile))
    queries.push({
      id: row.id,
      text: row.text.trim(),
      queries: [{ id: 'q0', text: row.text.trim() }],
      source_id: row.source_id,
    });
  assert.equal(documents.length, 281);
  assert.equal(queries.length, 1005);
  const corpusFile = path.join(out, 'qasper-documents.jsonl');
  const queryFile = path.join(out, 'qasper-queries.jsonl');
  await writeRows(corpusFile, documents);
  await writeRows(queryFile, queries);
  return {
    kind: 'full-document-known-source',
    documents: 281,
    questions: 1005,
    source_docs: await fileReceipt(docsFile),
    labels: await fileReceipt(queriesFile),
    corpus: await fileReceipt(corpusFile),
    queries: await fileReceipt(queryFile),
  };
}

async function fixedScope(
  root,
  out,
  scope,
  expectedQuestions,
  expectedDocuments,
) {
  const stem = scope === 'du' ? 'du' : `freshstack-${scope}`;
  const corpusFile = path.join(root, 'data', `${stem}-corpus.jsonl`);
  const queryFile = path.join(root, 'data', `${stem}-queries.jsonl`);
  const documents = new Map();
  let sourceRows = 0;
  for await (const row of jsonLines(corpusFile)) {
    sourceRows++;
    const id = String(row._id ?? row.id);
    assert.ok(id && id !== 'undefined');
    documents.set(id, { id, text: row.text, text_sha256: digest(row.text) });
  }
  const queries = [];
  for await (const row of jsonLines(queryFile)) {
    const id = String(row.query_id ?? row.id);
    const text = publicQueryText(scope, row);
    queries.push({ id, text });
  }
  assert.equal(queries.length, expectedQuestions);
  assert.equal(documents.size, expectedDocuments);
  const exportedCorpus = path.join(out, `${scope}-documents.jsonl`);
  const exportedQueries = path.join(out, `${scope}-queries.jsonl`);
  await writeRows(exportedCorpus, documents.values());
  await writeRows(exportedQueries, queries);
  return {
    kind: 'official-fixed-unit',
    questions: queries.length,
    documents: documents.size,
    source_rows: sourceRows,
    duplicate_rule: 'last official row per ID wins',
    source_corpus: await fileReceipt(corpusFile),
    source_queries: await fileReceipt(queryFile),
    corpus: await fileReceipt(exportedCorpus),
    queries: await fileReceipt(exportedQueries),
  };
}

async function main() {
  const [privateRoot, publicRoot, outArg] = process.argv.slice(2);
  assert.ok(
    privateRoot && publicRoot && outArg,
    'Expected PRIVATE_ROOT PUBLIC_ROOT NEW_OUT',
  );
  const out = path.resolve(outArg);
  await fs.mkdir(out); // Refuse an existing export rather than replacing it.
  const scopes = {};
  for (const [scope, spec] of Object.entries(SCOPES))
    scopes[scope] = await privateScope(privateRoot, out, scope, spec);
  scopes.qasper = await qasperScope(publicRoot, out);
  for (const [scope, questions, documents] of [
    ['langchain', 203, 49505],
    ['godot', 99, 25477],
    ['du', 2000, 100001],
  ])
    scopes[scope] = await fixedScope(
      publicRoot,
      out,
      scope,
      questions,
      documents,
    );
  const total = Object.values(scopes).reduce(
    (sum, row) => sum + row.questions,
    0,
  );
  assert.equal(total, 3507);
  const manifest = {
    version: 1,
    status: 'corpus-prepared-not-evaluated',
    created_at: new Date().toISOString(),
    parent_questions: total,
    scopes,
  };
  await fs.writeFile(path.join(out, 'manifest.json'), json(manifest), {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      status: manifest.status,
      questions: total,
      scopes: Object.fromEntries(
        Object.entries(scopes).map(([scope, row]) => [
          scope,
          { documents: row.documents, questions: row.questions },
        ]),
      ),
    }),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
