// Interactive SDK bridge for isolated Agent acceptance. It does not change host MCP settings.
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const at = process.argv.indexOf('--config');
if (at < 0 || !process.argv[at + 1])
  throw new Error('Use --config /absolute/path/echo.config.json');
const client = new Client({ name: 'echo-agent-acceptance', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
    'serve',
    '--config',
    resolve(process.argv[at + 1]),
  ],
  stderr: 'pipe',
});
await client.connect(transport);
console.log(
  JSON.stringify({
    ready: true,
    commands:
      '{"op":"list"} | {"op":"call","name":"echo_search","arguments":{"query":"..."}} | {"op":"close"}',
  }),
);
const lines = createInterface({ input: process.stdin });
let calls = 0,
  totalChars = 0;
try {
  for await (const line of lines) {
    try {
      const command = JSON.parse(line);
      if (command.op === 'close') break;
      const result =
        command.op === 'list'
          ? await client.listTools()
          : command.op === 'call'
            ? await client.callTool({
                name: command.name,
                arguments: command.arguments ?? {},
              })
            : { error: 'Unknown operation' };
      const responseChars = JSON.stringify(result).length;
      calls++;
      totalChars += responseChars;
      console.log(
        JSON.stringify({
          call: calls,
          response_chars: responseChars,
          total_response_chars: totalChars,
          result,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
} finally {
  lines.close();
  await client.close();
}
