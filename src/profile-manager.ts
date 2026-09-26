import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, retrievalSchema } from './config.js';
import {
  defaultMain,
  defaultTokenizer,
  headingStrategy,
  mainSchema,
  activeSchema,
  profileId,
} from './profiles.js';
import { openDatabase } from './database.js';
import { initializeStore } from './store.js';

export async function initializeWorkspace(path: string) {
  const configPath = resolve(path),
    base = dirname(configPath);
  await mkdir(base, { recursive: true });
  let exists = false;
  try {
    await stat(configPath);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const created: string[] = [];
  if (!exists) {
    const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
    const structureStrategy = await readFile(
      new URL(
        import.meta.url.endsWith('.ts')
          ? '../examples/profiles/chunkers/markdown-structure-v1.mjs'
          : './strategies/markdown-structure-v1.mjs',
        import.meta.url,
      ),
      'utf8',
    );
    const files: Record<string, string> = {
      'chunkers/markdown-structure-v1.mjs': structureStrategy,
      'tokenizers/icu-zh.mjs': defaultTokenizer,
      'config/embedding/default.json': json({
        id: 'default',
        provider: 'http',
        api_key_env: 'ECHO_EMBEDDING_API_KEY',
      }),
      'config/retrieval/balanced.json': json({
        id: 'balanced',
        ...retrievalSchema.parse({}),
      }),
      'config/sources.json': json({ collections: [] }),
      'config/runtime.json': json({
        search_timeout_ms: 120000,
        max_concurrent_searches: 2,
        sqlite_busy_timeout_ms: 5000,
      }),
      'config/logging.json': json({
        level: 'warn',
        file: '.echo/logs/echo.jsonl',
        max_file_bytes: 1048576,
        retain: 3,
      }),
    };
    for (const [relative, content] of Object.entries(files)) {
      const file = resolve(base, relative);
      await mkdir(dirname(file), { recursive: true });
      try {
        await writeFile(file, content, { flag: 'wx' });
        created.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    // Publish the entrypoint only after all defaults exist; never replace user files.
    try {
      await writeFile(configPath, json(defaultMain), { flag: 'wx' });
      created.push(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const config = await loadConfig(configPath);
  const db = openDatabase(config.database);
  try {
    initializeStore(db);
  } finally {
    db.close();
  }
  return {
    status: 'ok',
    config: configPath,
    created,
    next: 'Configure config/sources.json and config/embedding/default.json, then run echo-mcp sync. For local keyword search set mode=bm25 in config/retrieval/balanced.json.',
  };
}

export async function listProfiles(path: string) {
  const base = dirname(resolve(path)),
    main = mainSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const available: Record<string, string[]> = {};
  for (const [kind, directory] of Object.entries(main.directories)) {
    const extension =
      kind === 'chunkers' || kind === 'tokenizers' ? '.mjs' : '.json';
    available[kind] = (
      await readdir(resolve(base, directory), { withFileTypes: true })
    )
      .filter((e) => e.isFile() && e.name.endsWith(extension))
      .map((e) => e.name.slice(0, -extension.length))
      .filter((id) => profileId.safeParse(id).success)
      .sort();
  }
  return { active: main.active, available };
}
export async function useProfiles(
  path: string,
  selection: Partial<typeof defaultMain.active>,
) {
  const configPath = resolve(path),
    lockPath = configPath + '.lock';
  const lock = await open(lockPath, 'wx').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST')
        throw new Error(
          'Configuration busy: another config command holds ' + lockPath,
        );
      throw error;
    },
  );
  const temporary = configPath + '.' + randomUUID() + '.tmp';
  try {
    const old = await readFile(configPath, 'utf8'),
      info = await stat(configPath);
    const main = mainSchema.parse(JSON.parse(old));
    main.active = activeSchema.parse({ ...main.active, ...selection });
    await writeFile(temporary, JSON.stringify(main, null, 2) + '\n', {
      flag: 'wx',
      mode: info.mode,
    });
    await loadConfig(temporary); // Resolve every selected file before publishing.
    if (process.platform !== 'win32')
      await chmod(temporary, info.mode & 0o7777);
    if ((await readFile(configPath, 'utf8')) !== old)
      throw new Error('Configuration changed concurrently; retry');
    await rename(temporary, configPath);
    return {
      status: 'ok',
      active: main.active,
      effective: 'next_request',
      next: 'The next MCP request resolves this selection. Run sync if its index is missing or stale.',
    };
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function migrateConfiguration(path: string) {
  const configPath = resolve(path),
    base = dirname(configPath),
    original = await readFile(configPath, 'utf8');
  const raw = JSON.parse(original) as { version?: number };
  if (raw.version === 2)
    return {
      status: 'ok',
      changed: false,
      next: 'Configuration already uses profiles',
    };
  const legacy = await loadConfig(configPath);
  const { hash } = await import('./identity.js');
  const { loadChunker } = await import('./chunker.js');
  await loadChunker(legacy.chunker); // Validate the old behavior before producing a replacement.
  let chunkId: string, chunkCode: string;
  if (legacy.chunker.module) {
    const source = await readFile(legacy.chunker.module, 'utf8');
    chunkId =
      'legacy-' +
      hash(JSON.stringify([source, legacy.chunker.options])).slice(0, 16);
    chunkCode =
      "const old=(await import('data:text/javascript;base64," +
      Buffer.from(source).toString('base64') +
      "')).default;\nexport default {id:" +
      JSON.stringify(chunkId) +
      ',version:old.version,chunk(input){return old.chunk({...input,options:' +
      JSON.stringify(legacy.chunker.options) +
      '});}};\n';
  } else {
    const max = Number(legacy.chunker.options.max_chars ?? 1000);
    chunkId = 'heading-' + max;
    chunkCode = headingStrategy(max);
  }
  const tokenId = 'legacy-' + hash(JSON.stringify(legacy.lexical)).slice(0, 16);
  const tokenizer =
    'export default {id:' +
    JSON.stringify(tokenId) +
    ",version:'1',tokenize(text,context){return context.icu(text," +
    JSON.stringify(legacy.lexical) +
    ');}};\n';
  const modelId =
    'legacy-' + hash(JSON.stringify(legacy.embedding)).slice(0, 16);
  const retrievalId =
    'legacy-' + hash(JSON.stringify(legacy.retrieval)).slice(0, 16);
  const main = {
    ...defaultMain,
    database: legacy.database,
    active: {
      chunker: chunkId,
      tokenizer: tokenId,
      embedding: modelId,
      retrieval: retrievalId,
    },
  };
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  const files: Record<string, string> = {
    ['chunkers/' + chunkId + '.mjs']: chunkCode,
    ['tokenizers/' + tokenId + '.mjs']: tokenizer,
    ['config/embedding/' + modelId + '.json']: json({
      id: modelId,
      ...legacy.embedding,
    }),
    ['config/retrieval/' + retrievalId + '.json']: json({
      id: retrievalId,
      ...legacy.retrieval,
    }),
    'config/sources.json': json({ collections: legacy.collections }),
    'config/runtime.json': json(legacy.runtime),
    'config/logging.json': json(legacy.logging),
  };
  const lock = await open(configPath + '.lock', 'wx'),
    temporary = configPath + '.' + randomUUID() + '.tmp';
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = resolve(base, relative);
      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(target, content, { flag: 'wx' });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await readFile(target, 'utf8')) !== content
        )
          throw new Error(
            'Migration will not overwrite existing file: ' + target,
          );
      }
    }
    await writeFile(temporary, json(main), { flag: 'wx' });
    await loadConfig(temporary); // Self-contained legacy modules can be wrapped; unsupported imports fail before replacement.
    if ((await readFile(configPath, 'utf8')) !== original)
      throw new Error('Configuration changed during migration; retry');
    const backup =
      configPath + '.legacy-' + hash(original).slice(0, 16) + '.json';
    try {
      await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await readFile(backup, 'utf8')) !== original
      )
        throw error;
    }
    if (process.platform !== 'win32')
      await chmod(temporary, (await stat(configPath)).mode & 0o7777);
    await rename(temporary, configPath);
    return {
      status: 'ok',
      changed: true,
      backup,
      active: main.active,
      next: 'Run sync. Compatible old chunks and vectors are reused; other data may require new embedding calls.',
    };
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(configPath + '.lock', { force: true });
  }
}
