import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import assert from 'node:assert/strict';
const root = path.resolve(process.argv[2] ?? '');
assert.ok(
  process.argv[2],
  'Usage: node evals/download-public-benchmarks.mjs ROOT',
);
const specs = [
  [
    'qasper',
    'https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-train-dev-v0.3.tgz',
    'qasper-train-dev-v0.3.tgz',
  ],
  ...[
    [
      'freshstack/corpus-oct-2024',
      '069f66dc323e163b48b10d08408d282733d4393b',
      [
        'README.md',
        'langchain/train-00000-of-00001.parquet',
        'godot/train-00000-of-00001.parquet',
      ],
    ],
    [
      'freshstack/queries-oct-2024',
      '023ac3a14caf9d6ebb13d01adcfb8fa05e5a9630',
      [
        'README.md',
        'langchain/test-00000-of-00001.parquet',
        'godot/test-00000-of-00001.parquet',
      ],
    ],
    [
      'C-MTEB/DuRetrieval',
      'a1a333e290fe30b10f3f56498e3a0d911a693ced',
      [
        'README.md',
        'data/corpus-00000-of-00001-19b9e924cb33e4d5.parquet',
        'data/queries-00000-of-00001-7c7edb40be6b560c.parquet',
      ],
    ],
    [
      'C-MTEB/DuRetrieval-qrels',
      '497b7bd1bbb25cb3757ff34d95a8be50a3de2279',
      ['README.md', 'data/dev-00000-of-00001-d3c385852a7c0c9d.parquet'],
    ],
  ].flatMap(([repo, sha, files]) =>
    files.map((file) => [
      repo,
      'https://huggingface.co/datasets/' +
        repo +
        '/resolve/' +
        sha +
        '/' +
        file,
      repo + '/' + file,
    ]),
  ),
];
await fs.mkdir(path.join(root, 'downloads'), { recursive: true });
const manifestFile = path.join(root, 'download-manifest.json');
let entries = [];
try {
  entries = JSON.parse(await fs.readFile(manifestFile, 'utf8')).files;
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
for (const [dataset, url, relative] of specs) {
  const out = path.join(root, 'downloads', relative);
  if (entries.some((e) => e.url === url)) {
    const old = entries.find((e) => e.url === url);
    const content = await fs.readFile(out);
    assert.equal(
      createHash('sha256').update(content).digest('hex'),
      old.sha256,
    );
    continue;
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(240000) });
  assert.ok(response.ok, 'Download HTTP ' + response.status + ' ' + dataset);
  const hash = createHash('sha256');
  let bytes = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (c) => {
    hash.update(c);
    bytes += c.length;
  });
  await pipeline(source, createWriteStream(out + '.partial'));
  await fs.rename(out + '.partial', out);
  entries.push({
    dataset,
    url,
    file: 'downloads/' + relative,
    sha256: hash.digest('hex'),
    bytes,
  });
  await fs.writeFile(
    manifestFile,
    JSON.stringify({ version: 1, files: entries }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      downloaded: relative,
      bytes,
      completed: entries.length,
      total: specs.length,
    }),
  );
}
console.log('DOWNLOADS_COMPLETE');
