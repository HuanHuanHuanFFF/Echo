import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headingStrategy } from '../../src/profiles.js';

// Optional profiles are explicit test fixtures, not newly initialized defaults.
export async function installOptionalProfiles(directory: string) {
  for (const size of [1000, 500]) {
    await writeFile(
      join(directory, 'chunkers/heading-' + size + '.mjs'),
      headingStrategy(size),
    );
  }
  await copyFile(
    new URL(
      '../../examples/profiles/config/retrieval/bm25.json',
      import.meta.url,
    ),
    join(directory, 'config/retrieval/bm25.json'),
  );
}
