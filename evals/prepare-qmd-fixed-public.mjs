import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const [comparisonArg, qmdArg] = process.argv.slice(2);
assert.ok(
  comparisonArg && qmdArg,
  'Usage: node evals/prepare-qmd-fixed-public.mjs COMPARISON_ROOT QMD_ROOT',
);
const comparisonRoot = path.resolve(comparisonArg);
const qmdRoot = path.resolve(qmdArg);
const scopes = ['langchain', 'godot'];
const counts = {
  langchain: { documents: 49505, questions: 203 },
  godot: { documents: 25477, questions: 99 },
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fileSha = async (file) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
};
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
async function* jsonLines(file) {
  let pending = '';
  const input = createReadStream(file, { encoding: 'utf8' });
  for await (const chunk of input) {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  const finalLine = pending.replace(/\r$/, '');
  if (finalLine.trim()) yield JSON.parse(finalLine);
}

const manifestFile = path.join(comparisonRoot, 'corpus-v1/manifest.json');
const manifestBytes = await fs.readFile(manifestFile);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const publicDataRoot = path.join(qmdRoot, 'public-data');
await fs.mkdir(publicDataRoot);
const preparation = {
  schema: 'echo-qmd-public-fixed-preparation-v1',
  date: '2026-09-26',
  comparison_root: comparisonRoot,
  qmd_root: qmdRoot,
  corpus_manifest_sha256: sha(manifestBytes),
  scopes: {},
};
const modelManifest = await readJson(
  path.join(qmdRoot, 'download-manifest.json'),
);
assert.equal(modelManifest.version, '2.8.3');
const modelHashes = Object.fromEntries(
  modelManifest.models.map((row) => [row.file, row.sha256]),
);

for (const scope of scopes) {
  const info = manifest.scopes[scope];
  assert.equal(info.kind, 'official-fixed-unit');
  assert.equal(info.questions, counts[scope].questions);
  assert.equal(info.documents, counts[scope].documents);
  const corpusFile = path.join(
    comparisonRoot,
    'corpus-v1',
    `${scope}-documents.jsonl`,
  );
  const queryFile = path.join(
    comparisonRoot,
    'corpus-v1',
    `${scope}-queries.jsonl`,
  );
  const corpusSha = await fileSha(corpusFile);
  const queriesSha = await fileSha(queryFile);
  assert.equal(corpusSha, info.corpus.sha256);
  assert.equal(queriesSha, info.queries.sha256);
  const directory = path.join(publicDataRoot, scope);
  await fs.mkdir(directory);
  const mapFile = path.join(publicDataRoot, `${scope}-map.jsonl`);
  const map = await fs.open(mapFile, 'wx');
  const ids = new Set();
  let documents = 0;
  let characters = 0;
  const indexName = `qmd-public-${scope}`;
  const collectionName = scope;
  const configFile = path.join(qmdRoot, 'config', `${indexName}.yml`);
  const config = [
    'collections: {}',
    'models:',
    `  embed: ${modelManifest.embedding_model}`,
    '  generate: hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf',
    '  rerank: hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf',
    '',
  ].join('\n');
  await fs.writeFile(configFile, config, { flag: 'wx' });
  try {
    for await (const row of jsonLines(corpusFile)) {
      const id = String(row.id);
      assert.ok(id && id !== 'undefined' && !ids.has(id));
      assert.equal(sha(row.text), row.text_sha256);
      ids.add(id);
      const filename = `${String(documents).padStart(8, '0')}.md`;
      const file = path.join(directory, filename);
      await fs.writeFile(file, row.text, { flag: 'wx' });
      const mapping = {
        file: filename,
        id,
        text_sha256: row.text_sha256,
        characters: row.text.length,
      };
      await map.write(JSON.stringify(mapping) + '\n');
      documents++;
      characters += row.text.length;
      if (documents % 5000 === 0)
        console.log(
          `${scope}: prepared ${documents}/${counts[scope].documents}`,
        );
    }
  } finally {
    await map.close();
  }
  assert.equal(documents, counts[scope].documents);
  const queryRows = [];
  for await (const row of jsonLines(queryFile)) queryRows.push(row);
  assert.equal(queryRows.length, counts[scope].questions);
  assert.equal(new Set(queryRows.map((row) => row.id)).size, queryRows.length);
  preparation.scopes[scope] = {
    index_name: indexName,
    collection: collectionName,
    documents,
    questions: queryRows.length,
    characters,
    corpus_sha256: corpusSha,
    queries_sha256: queriesSha,
    map_sha256: await fileSha(mapFile),
    qmd_directory: directory,
    config_sha256: await fileSha(configFile),
  };
}
preparation.model_sha256 = modelHashes;
const output = path.join(qmdRoot, 'public-preparation.json');
await fs.writeFile(output, JSON.stringify(preparation, null, 2) + '\n', {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    status: 'prepared',
    corpus_manifest_sha256: preparation.corpus_manifest_sha256,
    scopes: Object.fromEntries(
      Object.entries(preparation.scopes).map(([scope, row]) => [
        scope,
        {
          documents: row.documents,
          questions: row.questions,
          characters: row.characters,
        },
      ]),
    ),
    output,
  }),
);
