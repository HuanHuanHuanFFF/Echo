import assert from 'node:assert/strict';

export const guidePaths = [
  'config/README.md',
  'config/embedding/README.md',
  'config/retrieval/README.md',
  'chunkers/README.md',
  'tokenizers/README.md',
];
export function verifyPackageFiles(paths) {
  const explicit = new Set([
    'package.json',
    'README.md',
    'LICENSE',
    'dist/strategies/markdown-structure-v1.mjs',
    ...guidePaths.map((path) => 'dist/templates/workspace/' + path),
  ]);
  for (const path of paths) {
    assert.ok(
      explicit.has(path) ||
        /^dist\/[a-z][a-z0-9-]*\.(?:js(?:\.map)?|d\.ts)$/.test(path),
      'Unexpected packed file: ' + path,
    );
  }
  for (const path of [
    ...explicit,
    'dist/cli.js',
    'dist/search-session-worker.js',
  ])
    assert.ok(paths.includes(path), 'Missing package asset: ' + path);
}
