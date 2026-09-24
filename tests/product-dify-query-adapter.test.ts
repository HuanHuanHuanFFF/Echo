import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
it('keeps full-document normalization independent of fixed-unit state', () => {
  const result = spawnSync(
    process.execPath,
    ['evals/product-dify-query.mjs', '--self-test'],
    { cwd: path.resolve('.'), encoding: 'utf8', timeout: 30000 },
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe('passed');
});
