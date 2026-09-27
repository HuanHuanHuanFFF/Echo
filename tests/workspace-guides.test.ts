import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeWorkspace, listProfiles } from '../src/profile-manager.js';
import { retrievalSchema } from '../src/config.js';
import { workspaceGuides } from '../src/workspace-guides.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
it('installs readable guides without replacing existing root or directory documentation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-guides-'));
  dirs.push(dir);
  await mkdir(join(dir, 'config'));
  await writeFile(join(dir, 'README.md'), 'my knowledge base');
  await writeFile(join(dir, 'config/README.md'), 'my configuration guide');
  const config = join(dir, 'echo.config.json');
  await initializeWorkspace(config);
  expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe(
    'my knowledge base',
  );
  expect(await readFile(join(dir, 'config/README.md'), 'utf8')).toBe(
    'my configuration guide',
  );
  const guides = await workspaceGuides();
  for (const [path, expected] of Object.entries(guides)) {
    if (path !== 'config/README.md')
      expect(await readFile(join(dir, path), 'utf8')).toBe(expected);
    for (const match of expected.matchAll(/\]\(([^)]+\.md)\)/g)) {
      // Every relative guide link must resolve inside the generated workspace.
      const { dirname, resolve } = await import('node:path');
      expect(
        await readFile(resolve(dirname(join(dir, path)), match[1]!), 'utf8'),
      ).not.toBe('');
    }
  }
  const table = await readFile(join(dir, 'config/retrieval/README.md'), 'utf8');
  for (const [name, value] of Object.entries(retrievalSchema.parse({})))
    expect(table).toContain('| ' + name + ' | ' + JSON.stringify(value) + ' |');
  expect(table).toContain('≥ 256; ≤ 100000');
  expect(table).not.toContain('<!-- RETRIEVAL_PARAMETERS -->');
  expect((await listProfiles(config)).available.retrieval).toEqual([
    'balanced',
  ]);
  expect((await initializeWorkspace(config)).created).toEqual([]);
});
