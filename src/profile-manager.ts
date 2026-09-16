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
import { loadConfig } from './config.js';
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
    const files: Record<string, string> = {
      'chunkers/heading-1000.mjs': headingStrategy(1000),
      'chunkers/heading-500.mjs': headingStrategy(500),
      'tokenizers/icu-zh.mjs': defaultTokenizer,
      'config/embedding/default.json': json({
        id: 'default',
        provider: 'http',
        api_key_env: 'ECHO_EMBEDDING_API_KEY',
      }),
      'config/retrieval/balanced.json': json({
        id: 'balanced',
        mode: 'hybrid',
      }),
      'config/retrieval/bm25.json': json({ id: 'bm25', mode: 'bm25' }),
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
    next: 'Configure config/sources.json and embedding/default.json, then run echo-mcp sync. For local keyword search select retrieval bm25.',
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
