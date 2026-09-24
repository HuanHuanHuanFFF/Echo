import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

export async function verifyExecutionFiles(root, files, required = []) {
  assert.ok(
    Array.isArray(files) && files.length,
    'Missing frozen execution files',
  );
  const paths = new Set();
  for (const item of files) {
    const file = path.resolve(root, item.path);
    assert.ok(!paths.has(file), 'Duplicate frozen path');
    paths.add(file);
    assert.equal(
      await fileSha256(file),
      item.sha256,
      'Frozen execution file changed: ' + file,
    );
  }
  for (const file of required)
    assert.ok(
      paths.has(path.resolve(file)),
      'Required execution file was not frozen',
    );
}

const containerNames = {
  dify: [
    'echo-compare-dify-api-1',
    'echo-compare-dify-worker-1',
    'echo-compare-dify-plugin_daemon-1',
    'echo-compare-dify-weaviate-1',
    'echo-compare-dify-redis-1',
    'echo-compare-dify-db_postgres-1',
  ],
  khoj: [
    'khoj-product-comparison-server-1',
    'khoj-product-comparison-database-1',
  ],
};
export async function verifyRuntimeImages(bindings, product) {
  const expected = containerNames[product];
  assert.ok(
    expected && Array.isArray(bindings),
    'Missing runtime image freeze',
  );
  const actual = [];
  for (const name of expected) {
    const matches = bindings.filter((item) => item.name === name);
    assert.equal(
      matches.length,
      1,
      'Missing or duplicate frozen runtime container',
    );
    const { stdout } = await promisify(execFile)(
      'docker',
      ['inspect', '--format', '{{.Image}}', name],
      { encoding: 'utf8', timeout: 30000 },
    );
    const imageId = stdout.trim();
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      imageId,
      matches[0].image_id,
      'Runtime container image changed: ' + name,
    );
    actual.push({ name, image_id: imageId });
  }
  return actual;
}
