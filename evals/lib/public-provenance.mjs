import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const sha = (x) => createHash('sha256').update(x).digest('hex');
export async function archiveSources(root, label, files) {
  const records = [];
  for (const file of files) {
    const data = await fs.readFile(file),
      hash = sha(data);
    const target = 'repro/sources/' + hash + '-' + path.basename(file);
    await fs.mkdir(path.dirname(path.join(root, target)), { recursive: true });
    try {
      await fs.writeFile(path.join(root, target), data, { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      assert.equal(
        sha(await fs.readFile(path.join(root, target))),
        hash,
        'Source archive mismatch',
      );
    }
    records.push({ source: path.basename(file), file: target, sha256: hash });
  }
  const receipt = {
    label,
    created: new Date().toISOString(),
    node: process.version,
    icu: process.versions.icu,
    sources: records,
  };
  await fs.mkdir(path.join(root, 'repro'), { recursive: true });
  await fs.appendFile(
    path.join(root, 'repro/source-history.jsonl'),
    JSON.stringify(receipt) + '\n',
  );
  return records;
}
