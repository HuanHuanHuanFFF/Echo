import { expect, it } from 'vitest';
import { guidePaths, verifyPackageFiles } from '../scripts/package-files.mjs';

const valid = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/cli.js',
  'dist/search-session-worker.js',
  'dist/strategies/markdown-structure-v1.mjs',
  ...guidePaths.map((path) => 'dist/templates/workspace/' + path),
];
it('rejects residual data and secrets even inside the distribution directory', () => {
  expect(() => verifyPackageFiles(valid)).not.toThrow();
  for (const path of [
    'dist/.env',
    'dist/.env.local',
    'dist/notes.md',
    'dist/index.sqlite',
    'dist/config/default.json',
    'docs/private.md',
    'dist/templates/workspace/config/secret.md',
  ])
    expect(() => verifyPackageFiles([...valid, path])).toThrow(
      'Unexpected packed file',
    );
  expect(() =>
    verifyPackageFiles(
      valid.filter((path) => !path.endsWith('chunkers/README.md')),
    ),
  ).toThrow('Missing package asset');
});
