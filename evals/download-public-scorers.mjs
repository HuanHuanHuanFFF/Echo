import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] ?? '');
assert.ok(
  process.argv[2],
  'Usage: node evals/download-public-scorers.mjs ROOT',
);
const specs = [
  [
    'FlagOpen/FlagEmbedding',
    'fd1a2bdf69488ffebe0327999d4400d8c8058a0b',
    'research/C_MTEB/C_MTEB/tasks/Retrieval.py',
    'c-mteb-retrieval-task.py',
  ],
  [
    'allenai/qasper-led-baseline',
    'afd0fb96bf78ce8cd8157639c6f6a6995e4f9089',
    'scripts/evaluator.py',
    'qasper_evaluator.py',
  ],
  [
    'allenai/qasper-led-baseline',
    'afd0fb96bf78ce8cd8157639c6f6a6995e4f9089',
    'scripts/evidence_retrieval_heuristic_baselines.py',
    'qasper_heuristics.py',
  ],
  [
    'fresh-stack/freshstack',
    'f1c4ec96477f5100f10c83798d33b3101db727fa',
    'freshstack/retrieval/metrics.py',
    'freshstack_metrics.py',
  ],
  [
    'fresh-stack/freshstack',
    'f1c4ec96477f5100f10c83798d33b3101db727fa',
    'freshstack/retrieval/evaluation.py',
    'freshstack_evaluation.py',
  ],
  [
    'fresh-stack/freshstack',
    'f1c4ec96477f5100f10c83798d33b3101db727fa',
    'freshstack/datasets/data_loader.py',
    'freshstack_loader.py',
  ],
];
await fs.mkdir(path.join(root, 'reference'), { recursive: true });
const manifest = [];
for (const [repo, commit, source, dest] of specs) {
  const response = await fetch(
    'https://raw.githubusercontent.com/' + repo + '/' + commit + '/' + source,
    { signal: AbortSignal.timeout(30000) },
  );
  assert.ok(response.ok, 'Official source download failed ' + response.status);
  const data = Buffer.from(await response.arrayBuffer()),
    file = 'reference/' + dest;
  try {
    await fs.writeFile(path.join(root, file), data, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    assert.deepEqual(await fs.readFile(path.join(root, file)), data);
  }
  manifest.push({
    repo,
    commit,
    path: source,
    file,
    sha256: createHash('sha256').update(data).digest('hex'),
  });
}
const text = JSON.stringify(manifest, null, 2) + '\n';
try {
  await fs.writeFile(path.join(root, 'reference/manifest.json'), text, {
    flag: 'wx',
  });
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
  const old = JSON.parse(
    await fs.readFile(path.join(root, 'reference/manifest.json'), 'utf8'),
  );
  for (const entry of old)
    assert.ok(
      manifest.some(
        (x) =>
          x.repo === entry.repo &&
          x.commit === entry.commit &&
          x.path === entry.path &&
          x.sha256 === entry.sha256,
      ),
      'Historical source manifest mismatch',
    );
}
await fs.writeFile(
  path.join(root, 'reference/scorer-source-manifest.json'),
  text,
);
const protocol = manifest.find((x) => x.repo === 'FlagOpen/FlagEmbedding');
const protocolFile = path.join(
  root,
  'reference/c-mteb-retrieval-task-receipt.json',
);
try {
  await fs.writeFile(
    protocolFile,
    JSON.stringify(
      {
        repository: protocol.repo,
        commit: protocol.commit,
        path: protocol.path,
        url:
          'https://raw.githubusercontent.com/' +
          protocol.repo +
          '/' +
          protocol.commit +
          '/' +
          protocol.path,
        sha256: protocol.sha256,
        purpose: 'Read-only protocol reference; not executed',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
  const old = JSON.parse(await fs.readFile(protocolFile, 'utf8'));
  assert.equal(old.commit, protocol.commit);
  assert.equal(old.sha256, protocol.sha256);
}
console.log(
  JSON.stringify({
    sources: manifest.length,
    executed:
      'QASPER evaluator/heuristics and FreshStack metrics only; loader/evaluation/C-MTEB task retained as protocol references',
  }),
);
