import { copyFile, mkdir } from 'node:fs/promises';
const destination = new URL('../dist/strategies/', import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  new URL(
    '../examples/profiles/chunkers/markdown-structure-v1.mjs',
    import.meta.url,
  ),
  new URL('markdown-structure-v1.mjs', destination),
);
