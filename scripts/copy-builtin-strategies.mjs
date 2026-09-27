import { copyFile, mkdir, cp } from 'node:fs/promises';
const destination = new URL('../dist/strategies/', import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  new URL(
    '../examples/profiles/chunkers/markdown-structure-v1.mjs',
    import.meta.url,
  ),
  new URL('markdown-structure-v1.mjs', destination),
);

await cp(
  new URL('../templates/workspace/', import.meta.url),
  new URL('../dist/templates/workspace/', import.meta.url),
  { recursive: true },
);
