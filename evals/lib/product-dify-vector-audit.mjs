import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export async function auditDifyVectors(
  root,
  datasetId,
  kind,
  fingerprint,
  contractFile,
) {
  const directory = path.resolve(root, 'audit-snapshots');
  await fs.mkdir(directory, { recursive: true });
  const id = randomUUID();
  const snapshot = path.join(directory, id + '.sqlite');
  const remoteSnapshot = '/tmp/echo-model-audit-' + id + '.sqlite';
  const remoteContract = '/tmp/echo-model-audit-' + id + '.jsonl';
  assert.equal(path.dirname(snapshot), directory);
  const source = new Database(
    path.join(root, 'embedding-gateway/vectors.sqlite'),
    { readonly: true, fileMustExist: true },
  );
  try {
    await source.backup(snapshot, { progress: ({ totalPages }) => totalPages });
  } finally {
    source.close();
  }
  try {
    const copy = spawnSync(
      'docker',
      ['cp', snapshot, 'echo-compare-dify-api-1:' + remoteSnapshot],
      { encoding: 'utf8' },
    );
    assert.equal(
      copy.status,
      0,
      'Failed to stage read-only model cache snapshot',
    );
    if (contractFile) {
      const copied = spawnSync(
        'docker',
        ['cp', contractFile, 'echo-compare-dify-api-1:' + remoteContract],
        { encoding: 'utf8' },
      );
      assert.equal(copied.status, 0, 'Failed to stage frozen segment contract');
    }
    const result = spawnSync(
      'docker',
      [
        'exec',
        '--user',
        'root',
        '-i',
        'echo-compare-dify-api-1',
        '/app/api/.venv/bin/python',
        '-',
        datasetId,
        kind,
        fingerprint,
        remoteSnapshot,
        ...(contractFile ? [remoteContract] : []),
      ],
      {
        input: await fs.readFile(
          fileURLToPath(
            new URL('../audit-product-dify-vectors.py', import.meta.url),
          ),
          'utf8',
        ),
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    assert.ok(
      result.stdout.trim(),
      'Physical/model audit produced no JSON: ' + result.stderr.slice(-500),
    );
    return { exit_code: result.status, report: JSON.parse(result.stdout) };
  } finally {
    await fs.rm(snapshot, { force: true });
    const cleanup = spawnSync(
      'docker',
      [
        'exec',
        '--user',
        'root',
        'echo-compare-dify-api-1',
        '/app/api/.venv/bin/python',
        '-c',
        'import pathlib,sys; [pathlib.Path(p).unlink(missing_ok=True) for p in sys.argv[1:]]',
        remoteSnapshot,
        remoteContract,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(
      cleanup.status,
      0,
      'Audit finished but its temporary container snapshot needs cleanup',
    );
  }
}
