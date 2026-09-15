#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  if (process.argv.includes('--help')) {
    console.log(
      'Echo Markdown evidence MCP\nUsage: npm run dev -- serve\nFoundation: echo_status over MCP stdio. See README.md.',
    );
    return;
  }
  const command = process.argv[2] ?? 'serve';
  if (command !== 'serve') throw new Error('Unknown command: ' + command);
  await createServer().connect(new StdioServerTransport());
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
