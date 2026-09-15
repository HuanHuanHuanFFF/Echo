#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { loadConfig } from './config.js';
import { syncIndex } from './sync.js';
import { openDatabase } from './database.js';
import { indexStatus } from './store.js';

async function main() {
  if (process.argv.includes('--help')) {
    console.log(
      'Echo Markdown evidence MCP\nUsage: echo-mcp serve | sync | status [--config echo.config.json]\nSync writes missing UUID v4 IDs into configured Markdown files.',
    );
    return;
  }
  const command = process.argv[2] ?? 'serve';
  const configIndex = process.argv.indexOf('--config');
  const configPath =
    configIndex < 0 ? 'echo.config.json' : process.argv[configIndex + 1];
  if (!configPath) throw new Error('--config requires a file path');
  if (command === 'serve') {
    await createServer().connect(new StdioServerTransport());
    return;
  }
  const config = await loadConfig(configPath);
  if (command === 'sync') {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Sync cancelled'));
    process.once('SIGINT', cancel);
    try {
      console.log(
        JSON.stringify(await syncIndex(config, controller.signal), null, 2),
      );
    } finally {
      process.removeListener('SIGINT', cancel);
    }
  } else if (command === 'status') {
    const db = openDatabase(config.database);
    try {
      console.log(JSON.stringify(indexStatus(db), null, 2));
    } finally {
      db.close();
    }
  } else throw new Error('Unknown command: ' + command);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
