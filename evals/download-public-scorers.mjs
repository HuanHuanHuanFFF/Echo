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
await fs.writeFile(
  path.join(root, 'reference/manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    sources: manifest.length,
    executed:
      'QASPER evaluator/heuristics and FreshStack metrics only; loader/evaluation retained as protocol references',
  }),
);
