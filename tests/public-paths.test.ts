import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const { machinePaths, checkPublicPaths } = await import(
  new URL('../scripts/check-public-paths.mjs', import.meta.url).href
);

it('detects drive, home, escaped and encoded machine paths while allowing role aliases and generic examples', () => {
  const drive = 'Q' + ':';
  const path =
    drive + '/' + ['Users', 'example-person', 'private', 'note.md'].join('/');
  for (const value of [
    path,
    path.replaceAll('/', '\\'),
    JSON.stringify(path.replaceAll('/', '\\')),
    encodeURIComponent(path),
  ])
    expect(machinePaths(value).length).toBeGreaterThan(0);
  for (const home of ['Users', 'home'])
    expect(
      machinePaths('/' + home + '/example-person/vault').length,
    ).toBeGreaterThan(0);
  expect(
    machinePaths(
      '\\\\' + ['office-host', 'private-share', 'note.md'].join('\\'),
    ).length,
  ).toBeGreaterThan(0);
  expect(machinePaths('${NOTES_ROOT}/note.md')).toEqual([]);
  expect(machinePaths('https://example.com/docs/readme')).toEqual([]);
  expect(machinePaths('C' + ':/notes/a')).toEqual([]);
  expect(machinePaths('C' + ':/path/to/echo')).toEqual([]);
});

it('binds each published redacted snapshot to its current bytes', () => {
  const manifest = JSON.parse(
    readFileSync('docs/evals/2026-09-26-path-redaction.manifest.json', 'utf8'),
  );
  for (const file of manifest.files) {
    // Git's canonical text form is LF on every checkout platform.
    const bytes = readFileSync(file.file, 'utf8').replaceAll('\r\n', '\n');
    expect(createHash('sha256').update(bytes).digest('hex'), file.file).toBe(
      file.redacted_sha256,
    );
  }
});

it('requires explicit local roots before the comparison freeze CLI can operate', () => {
  const script = resolve('evals/freeze-product-comparison.mjs');
  const missing = spawnSync(process.execPath, [script, '--dry-run'], {
    encoding: 'utf8',
  });
  expect(missing.status).toBe(2);
  expect(missing.stderr).toContain('--private-root PATH');
  expect(
    execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }),
  ).toContain('--public-root PATH');
});

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it('detects JSON escaped home slashes and single-character or Unicode UNC hosts', () => {
  const home = '/' + ['home', 'example-person', 'private'].join('/');
  expect(
    machinePaths(JSON.stringify(home).replaceAll('/', '\\/')).length,
  ).toBeGreaterThan(0);
  for (const host of ['x', '公司服务器']) {
    const unc = '\\\\' + [host, 'private-share', 'note.md'].join('\\');
    expect(machinePaths(unc).length).toBeGreaterThan(0);
    expect(machinePaths(encodeURIComponent(unc)).length).toBeGreaterThan(0);
  }
});
it('skips unstaged deletions and returns sanitized enumeration failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-public-paths-'));
  temporaryRoots.push(root);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), ...args],
      { cwd: root, stdio: 'pipe' },
    );
  git('init');
  const file = join(root, 'removed.md');
  await writeFile(file, 'temporary fixture');
  git('add', 'removed.md');
  await rm(file);
  expect((await checkPublicPaths(root)).failures).toEqual([]);
  const missingRoot = join(root, 'missing');
  const error = await checkPublicPaths(missingRoot);
  expect(error.failures).toEqual([
    { file: '.', code: 'GIT_FILES_UNAVAILABLE' },
  ]);
  expect(JSON.stringify(error)).not.toContain(root);
});
