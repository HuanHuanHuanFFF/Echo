#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { EchoStdioTransport, boundedErrorText } from './transport.js';
import { createServer } from './server.js';
import { loadConfig, type EchoConfig } from './config.js';
import { syncIndex } from './sync.js';
import { openDatabase } from './database.js';
import { indexStatus } from './store.js';
import { searchIndex } from './retrieval.js';
import {
  initializeWorkspace,
  listProfiles,
  useProfiles,
  migrateConfiguration,
} from './profile-manager.js';
import { configurationRuntime } from './config-runtime.js';
import { profileStatus } from './profile-store.js';
import { createLogger } from './logging.js';
import { failureInfo } from './errors.js';
function status(config: EchoConfig) {
  if (!existsSync(config.database))
    return {
      ready: false,
      reason: { code: 'INDEX_REQUIRED', next: 'Run echo-mcp sync' },
    };
  const db = openDatabase(config.database, {
    readOnly: true,
    busyTimeout: config.runtime.sqlite_busy_timeout_ms,
  });
  try {
    return config.profile ? profileStatus(db, config) : indexStatus(db);
  } finally {
    db.close();
  }
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      config: { type: 'string' },
      query: { type: 'string' },
      overrides: { type: 'string' },
      filters: { type: 'string' },
      chunker: { type: 'string' },
      tokenizer: { type: 'string' },
      embedding: { type: 'string' },
      retrieval: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'Echo Markdown evidence MCP\nUsage: echo-mcp init | serve | sync | status | search --query TEXT [--config echo.config.json]\n       echo-mcp config list | show | migrate\n       echo-mcp config use [--chunker ID] [--tokenizer ID] [--embedding ID] [--retrieval ID]\nSync writes missing UUID v4 IDs into configured Markdown. Configuration switches take effect on the next MCP request.',
    );
    return;
  }
  const command = positionals[0] ?? 'serve',
    configPath = resolve(values.config ?? 'echo.config.json');
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (command === 'init') {
    print(await initializeWorkspace(configPath));
    return;
  }
  if (command === 'config') {
    const operation = positionals[1];
    if (operation === 'list') print(await listProfiles(configPath));
    else if (operation === 'use') {
      const selection: Record<string, string> = {};
      for (const kind of [
        'chunker',
        'tokenizer',
        'embedding',
        'retrieval',
      ] as const)
        if (values[kind]) selection[kind] = values[kind]!;
      if (!Object.keys(selection).length)
        throw new Error('config use requires at least one profile ID');
      const switched = await useProfiles(configPath, selection);
      print({ ...switched, index: status(await loadConfig(configPath)) });
    } else if (operation === 'migrate')
      print(await migrateConfiguration(configPath));
    else if (operation === 'show') {
      const config = await loadConfig(configPath);
      print({
        config: configPath,
        database: config.database,
        format: config.profile ? 2 : 1,
        active: config.profile?.active ?? null,
        revision: config.profile?.revision ?? null,
        sources: config.collections,
        runtime: config.runtime,
        logging: config.logging,
        embedding_configured: Boolean(
          config.embedding.model &&
          config.embedding.base_url &&
          config.embedding.dimensions,
        ),
        api_key_env: config.embedding.api_key_env,
        index: status(config),
      });
    } else throw new Error('Use config list, show, use, or migrate');
    return;
  }
  if (command === 'serve') {
    const initial = existsSync(configPath)
      ? await loadConfig(configPath)
      : undefined;
    if (values.config && !initial)
      throw new Error('Configuration file does not exist: ' + configPath);
    const runtime = configurationRuntime(configPath, initial),
      server = createServer(initial, () => runtime.snapshot());
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void server.close().catch((error) => {
        console.error(boundedErrorText(error));
        process.exitCode = 1;
      });
    };
    process.stdin.once('end', close);
    process.stdin.once('close', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    await server.connect(new EchoStdioTransport());
    return;
  }
  const config = await loadConfig(configPath),
    log = createLogger(config.logging),
    started = performance.now();
  try {
    if (command === 'sync') {
      const controller = new AbortController(),
        cancel = () => controller.abort(new Error('Sync cancelled'));
      process.once('SIGINT', cancel);
      try {
        const result = await syncIndex(config, controller.signal);
        print(result);
        log('info', 'sync.completed', {
          duration_ms: Math.round(performance.now() - started),
          chunks: result.chunks,
        });
      } finally {
        process.removeListener('SIGINT', cancel);
      }
    } else if (command === 'search') {
      if (!values.query) throw new Error('search requires --query');
      const result = await searchIndex(config, {
        query: values.query,
        ...(values.overrides
          ? { overrides: JSON.parse(values.overrides) }
          : {}),
        ...(values.filters ? { filters: JSON.parse(values.filters) } : {}),
      });
      print(result);
      log(result.status === 'ok' ? 'info' : 'warn', 'search.' + result.status, {
        duration_ms: Math.round(performance.now() - started),
        results: result.results.length,
      });
    } else if (command === 'status') print(status(config));
    else throw new Error('Unknown command: ' + command);
  } catch (error) {
    log('error', failureInfo(error).code);
    throw error;
  }
}
main().catch((error) => {
  console.error(boundedErrorText(error));
  process.exitCode = 1;
});
