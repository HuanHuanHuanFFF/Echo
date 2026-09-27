import assert from 'node:assert/strict';
import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const output = join(root, 'dist');
try {
  const info = await lstat(output);
  assert.ok(
    info.isDirectory() && !info.isSymbolicLink(),
    'dist must be a generated directory, not a link',
  );
  assert.equal(dirname(await realpath(output)), root);
  await rm(output, { recursive: true, force: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
