import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadConfig } from '../dist/config.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const configPath = resolve(
  process.argv[2] ?? 'examples/echo.bm25.example.json',
);
const profile = await loadConfig(configPath);
const keyName = profile.embedding.api_key_env;
const key = process.env[keyName];
const client = new Client({ name: 'echo-example-agent', version: '1.0.0' });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'serve', '--config', configPath],
      stderr: 'pipe',
      ...(key ? { env: { [keyName]: key } } : {}),
    }),
  );
  const response = await client.callTool({
    name: 'echo_search',
    arguments: process.argv[3]
      ? { query: process.argv[3] }
      : {
          queries: [
            { query_id: 'recovery', text: '事务失败时怎样恢复' },
            { query_id: 'custom', text: '如何自定义切块规则' },
          ],
          overrides: { topk: 2, max_chunks_per_source: 1 },
        },
  });
  for (const item of response.content ?? [])
    if (item.type === 'text') console.log(item.text);
  if (response.isError) process.exitCode = 1;
} finally {
  await client.close();
}
