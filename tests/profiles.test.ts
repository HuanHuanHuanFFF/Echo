import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeWorkspace,
  listProfiles,
  useProfiles,
} from '../src/profile-manager.js';
import { loadConfig } from '../src/config.js';
import { profileChunker, profileTokenizer } from '../src/profiles.js';
import { runChunker } from '../src/chunker.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'echo-profiles-'));
  dirs.push(dir);
  const path = join(dir, 'echo.config.json');
  await initializeWorkspace(path);
  return { dir, path };
}
it('initializes without model calls and preserves user files on repeated initialization', async () => {
  const { dir, path } = await fixture();
  const file = join(dir, 'config/retrieval/balanced.json');
  const frozen = JSON.parse(
    await readFile(
      new URL(
        '../examples/profiles/config/retrieval/balanced.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(frozen);
  await writeFile(file, JSON.stringify({ id: 'balanced', topk: 3 }));
  expect((await initializeWorkspace(path)).created).toEqual([]);
  expect((await loadConfig(path)).retrieval.topk).toBe(3);
  expect((await listProfiles(path)).available.chunkers).toEqual([
    'heading-1000',
    'heading-500',
  ]);
});
it('selects profiles atomically and rejects mismatched IDs and parameter overlays', async () => {
  const { dir, path } = await fixture();
  await useProfiles(path, { chunker: 'heading-500', retrieval: 'bm25' });
  expect((await loadConfig(path)).profile!.active.chunker).toBe('heading-500');
  const old = await readFile(path, 'utf8');
  await expect(
    useProfiles(path, { embedding: 'missing', retrieval: 'balanced' }),
  ).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(old);
  await writeFile(
    join(dir, 'chunkers/wrong.mjs'),
    "export default {id:'different',version:'1',chunk(){return []}}",
  );
  await expect(useProfiles(path, { chunker: 'wrong' })).rejects.toThrow(
    'id must match',
  );
  expect(await readFile(path, 'utf8')).toBe(old);
  await writeFile(
    join(dir, 'config/embedding/invalid.json'),
    JSON.stringify({ id: 'invalid', base_url: 'ftp://provider.example' }),
  );
  await expect(useProfiles(path, { embedding: 'invalid' })).rejects.toThrow(
    'HTTP(S)',
  );
  expect(await readFile(path, 'utf8')).toBe(old);
  await writeFile(
    path,
    JSON.stringify({
      ...JSON.parse(old),
      chunker: { options: { max_chars: 42 } },
    }),
  );
  await expect(loadConfig(path)).rejects.toThrow();
});
it('retains module and dictionary snapshots while subsequent loads see changed rules', async () => {
  const { dir, path } = await fixture();
  await writeFile(join(dir, 'tokenizers/words.txt'), 'HTTPServer');
  await writeFile(
    join(dir, 'tokenizers/words.mjs'),
    "export default {id:'words',version:'1',resources:{dict:'words.txt'},tokenize(text,ctx){return text.includes(ctx.resources.dict)?['component']:[]}}",
  );
  await useProfiles(path, { tokenizer: 'words' });
  const first = await loadConfig(path);
  await writeFile(join(dir, 'tokenizers/words.txt'), 'URLParser');
  const second = await loadConfig(path);
  expect(second.profile!.tokenizer.fingerprint).not.toBe(
    first.profile!.tokenizer.fingerprint,
  );
  expect(
    await (
      await profileTokenizer(first.profile!.tokenizer)
    )('HTTPServer'),
  ).toHaveLength(1);
  expect(
    await (
      await profileTokenizer(second.profile!.tokenizer)
    )('HTTPServer'),
  ).toEqual([]);
  const chunker = await profileChunker(first.profile!.chunker);
  const chunks = await runChunker(chunker, {
    sourceId: 'id',
    path: 'a.md',
    lines: [
      { number: 4, text: '# Title' },
      { number: 5, text: 'original' },
    ],
    options: { max_chars: 1 },
  });
  expect(chunks[0]!.text).toBe('# Title\noriginal');
});
