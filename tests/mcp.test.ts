import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseConfig } from '../src/config.js';
import { syncIndex } from '../src/sync.js';
import { searchIndex } from '../src/retrieval.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'echo-mcp-')));
  dirs.push(dir);
  const root = join(dir, 'notes');
  await mkdir(root);
  await writeFile(
    join(root, 'apple.md'),
    '# 苹果\n苹果是一种水果。\n## 保存\n苹果可以低温保存。',
  );
  await writeFile(join(root, 'banana.md'), '# 香蕉\n香蕉含有淀粉。');
  const config = parseConfig({
    database: join(dir, 'index.sqlite'),
    collections: [{ id: 'sample', root }],
    retrieval: { mode: 'bm25' },
  });
  await syncIndex(config);
  const configPath = join(dir, 'echo.config.json');
  await writeFile(configPath, JSON.stringify(config));
  return { dir, root, config, configPath };
}
async function clientFor(configPath: string, env?: Record<string, string>) {
  const client = new Client({ name: 'echo-agent-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      import.meta.resolve('tsx'),
      resolve('src/cli.ts'),
      'serve',
      '--config',
      configPath,
    ],
    stderr: 'pipe',
    ...(env ? { env } : {}),
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
function decode(result: unknown) {
  const content = (result as { content: unknown }).content as {
    type: string;
    text: string;
  }[];
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe('text');
  return JSON.parse(content[0]!.text) as Awaited<
    ReturnType<typeof searchIndex>
  >;
}
it('keeps independent query ownership and shares one chunk without violating global source limits', async () => {
  const { config } = await fixture();
  const result = await searchIndex(config, {
    queries: [
      { query_id: 'apple', text: '苹果' },
      { query_id: 'banana', text: '香蕉' },
      { query_id: 'shared', text: '苹果', variants: ['苹果'] },
    ],
    overrides: { topk: 2, max_chunks_per_source: 1 },
  });
  expect(result.results).toHaveLength(2);
  const apple = result.results.find((e) => e.text.includes('苹果'))!;
  expect(apple.matched_query_ids).toEqual(['apple', 'shared']);
  expect(result.queries.map((q) => q.returned)).toEqual([1, 1, 1]);
  await expect(
    searchIndex(config, {
      query: 'x',
      queries: [{ query_id: 'q', text: 'x' }],
    }),
  ).rejects.toThrow();
  await expect(
    searchIndex(config, {
      queries: [
        { query_id: 'q', text: 'a' },
        { query_id: 'q', text: 'b' },
      ],
    }),
  ).rejects.toThrow();
});
it('a real MCP client gets compact evidence and host file reading reproduces the returned range', async () => {
  const { configPath } = await fixture();
  const client = await clientFor(configPath);
  try {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'echo_search',
      'echo_status',
    ]);
    const call = await client.callTool({
      name: 'echo_search',
      arguments: {
        queries: [
          { query_id: 'a', text: '苹果' },
          { query_id: 'b', text: '香蕉' },
        ],
        overrides: {
          topk: 2,
          max_chunks_per_source: 1,
          max_context_chars: 4000,
        },
      },
    });
    expect(call.isError).not.toBe(true);
    expect(call.structuredContent).toBeUndefined();
    const result = decode(call);
    expect(result.results).toHaveLength(2);
    const text = (call.content as { text: string }[])[0]!.text;
    expect(text.length).toBeLessThanOrEqual(4000);
    for (const evidence of result.results) {
      const original = (await readFile(evidence.path, 'utf8')).split(
        /\r\n|\n|\r/,
      );
      expect(
        original.slice(evidence.start_line - 1, evidence.end_line).join('\n'),
      ).toBe(evidence.text);
      expect(
        original
          .slice(evidence.section_start_line! - 1, evidence.section_end_line!)
          .join('\n'),
      ).toContain(evidence.text);
    }
    const empty = decode(
      await client.callTool({
        name: 'echo_search',
        arguments: { query: 'xyzNoMatch' },
      }),
    );
    expect(empty.queries[0]!.status).toBe('empty');
  } finally {
    await client.close();
  }
});
it('MCP preserves successful subquestions when another API query fails', async () => {
  const { config, configPath } = await fixture();
  const server = createHttpServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (p) => parts.push(p as Buffer));
    req.on('end', () => {
      const input = (
        JSON.parse(Buffer.concat(parts).toString()) as { input: string[] }
      ).input;
      if (input.some((text) => text.includes('FAIL'))) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: input.map((text, index) => ({
            index,
            embedding: text.includes('香蕉') ? [0, 1] : [1, 0],
          })),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const key = 'ECHO_MCP_TEST_KEY';
  process.env[key] = 'test-only';
  let client: Client | undefined;
  try {
    config.embedding = {
      ...config.embedding,
      base_url: 'http://127.0.0.1:' + address.port + '/v1',
      model: 'test',
      dimensions: 2,
      api_key_env: key,
    };
    config.retrieval.mode = 'hybrid';
    await syncIndex(config);
    await writeFile(configPath, JSON.stringify(config));
    client = await clientFor(configPath, { [key]: 'test-only' });
    const result = decode(
      await client.callTool({
        name: 'echo_search',
        arguments: {
          queries: [
            { query_id: 'a', text: '苹果' },
            { query_id: 'bad', text: 'FAIL' },
          ],
          overrides: { mode: 'dense' },
        },
      }),
    );
    expect(result.status).toBe('partial_failure');
    expect(result.queries.map((q) => q.status)).toEqual(['ok', 'error']);
    expect(result.results.length).toBeGreaterThan(0);
    expect(
      result.results.every(
        (e) =>
          e.matched_query_ids.includes('a') &&
          !e.matched_query_ids.includes('bad'),
      ),
    ).toBe(true);
  } finally {
    await client?.close();
    delete process.env[key];
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('MCP remains responsive during model I/O and cancellation closes the downstream request', async () => {
  const { config, configPath } = await fixture();
  let arrived: () => void = () => {},
    disconnected: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const server = createHttpServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (p) => parts.push(p as Buffer));
    req.on('end', () => {
      const input = (
        JSON.parse(Buffer.concat(parts).toString()) as { input: string[] }
      ).input;
      if (input.some((text) => text.includes('STALL'))) {
        res.on('close', disconnected);
        arrived();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: input.map((_, index) => ({ index, embedding: [1, 0] })),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const key = 'ECHO_CANCEL_TEST_KEY';
  process.env[key] = 'test-only';
  let client: Client | undefined;
  try {
    config.embedding = {
      ...config.embedding,
      base_url: 'http://127.0.0.1:' + address.port + '/v1',
      model: 'test',
      dimensions: 2,
      api_key_env: key,
      timeout_ms: 10000,
    };
    config.runtime.max_concurrent_searches = 1;
    config.retrieval.mode = 'hybrid';
    await syncIndex(config);
    await writeFile(configPath, JSON.stringify(config));
    client = await clientFor(configPath, { [key]: 'test-only' });
    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: 'echo_search',
        arguments: { query: 'STALL', overrides: { mode: 'dense' } },
      },
      undefined,
      { signal: controller.signal, timeout: 10000 },
    );
    const rejected = expect(pending).rejects.toThrow();
    await reached;
    const statusCall = await client.callTool(
      { name: 'echo_status', arguments: {} },
      undefined,
      { timeout: 2000 },
    );
    const status = JSON.parse(
      (statusCall.content as { text: string }[])[0]!.text,
    ) as { active_searches: number };
    expect(status.active_searches).toBe(1);
    const busy = await client.callTool({
      name: 'echo_search',
      arguments: { query: '苹果' },
    });
    expect(busy.isError).toBe(true);
    expect((busy.content as { text: string }[])[0]!.text).toContain('busy');
    controller.abort();
    await rejected;
    await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Downstream request was not closed')),
          2000,
        ),
      ),
    ]);
  } finally {
    await client?.close();
    delete process.env[key];
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('deduplicates same-intent variants while keeping one query identity', async () => {
  const { config } = await fixture();
  const result = await searchIndex(config, {
    queries: [{ query_id: 'fruit', text: '苹果', variants: ['水果', '苹果'] }],
  });
  expect(result.queries).toHaveLength(1);
  expect(result.queries[0]!.variants).toHaveLength(2);
  expect(
    result.results.every((e) => e.matched_query_ids.join(',') === 'fruit'),
  ).toBe(true);
});

it('status lock waits do not stall the main MCP channel', async () => {
  const { config, configPath } = await fixture();
  const { openDatabase } = await import('../src/database.js');
  const client = await clientFor(configPath);
  const writer = openDatabase(config.database);
  writer.pragma('locking_mode = EXCLUSIVE');
  writer.exec('BEGIN EXCLUSIVE');
  let unlocked = false;
  const unlock = () => {
    if (!unlocked) {
      unlocked = true;
      writer.exec('ROLLBACK');
      writer.close();
    }
  };
  const timer = setTimeout(unlock, 1500);
  try {
    const status = client.callTool({ name: 'echo_status', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const start = Date.now();
    await client.listTools();
    expect(Date.now() - start).toBeLessThan(900);
    unlock();
    await status;
  } finally {
    clearTimeout(timer);
    unlock();
    await client.close();
  }
});
it.each(['inner', 'outer'])(
  'bounds escaped %s validation errors as actual JSON text',
  async (placement) => {
    const { configPath } = await fixture();
    const client = await clientFor(configPath);
    try {
      const unknown = String.fromCharCode(92).repeat(400);
      const argumentsValue =
        placement === 'inner'
          ? {
              query: '苹果',
              overrides: { max_context_chars: 256, [unknown]: true },
            }
          : {
              query: '苹果',
              overrides: { max_context_chars: 256 },
              [unknown]: true,
            };
      const response = await client.callTool({
        name: 'echo_search',
        arguments: argumentsValue,
      });
      expect(response.isError).toBe(true);
      expect(
        (response.content as { text: string }[])[0]!.text.length,
      ).toBeLessThanOrEqual(256);
    } finally {
      await client.close();
    }
  },
);

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Deadline exceeded')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
it('stdin EOF closes the MCP process and cancels its downstream request', async () => {
  const { config, configPath } = await fixture();
  const { spawn } = await import('node:child_process');
  let reachedResolve!: () => void, closedResolve!: () => void;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  const api = createHttpServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part) => parts.push(part as Buffer));
    req.on('end', () => {
      const input = (
        JSON.parse(Buffer.concat(parts).toString()) as { input: string[] }
      ).input;
      if (input.some((text) => text.includes('STALL'))) {
        res.on('close', closedResolve);
        reachedResolve();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: input.map((_, index) => ({ index, embedding: [1, 0] })),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const key = 'ECHO_EOF_TEST_KEY';
  process.env[key] = 'test-only';
  let child: ReturnType<typeof spawn> | undefined,
    exited: Promise<void> | undefined;
  try {
    config.embedding = {
      ...config.embedding,
      base_url: 'http://127.0.0.1:' + address.port + '/v1',
      model: 'test',
      dimensions: 2,
      api_key_env: key,
      timeout_ms: 10000,
    };
    config.retrieval.mode = 'hybrid';
    await syncIndex(config);
    await writeFile(configPath, JSON.stringify(config));
    child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        resolve('src/cli.ts'),
        'serve',
        '--config',
        configPath,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, [key]: 'test-only' },
      },
    );
    exited = new Promise<void>((resolve) =>
      child!.once('exit', () => resolve()),
    );
    child.stderr!.resume();
    let initializedResolve!: () => void;
    const initialized = new Promise<void>((resolve) => {
      initializedResolve = resolve;
    });
    let buffer = '';
    child.stdout!.on('data', (chunk) => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line && (JSON.parse(line) as { id?: number }).id === 1)
          initializedResolve();
      }
    });
    child.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'eof-test', version: '1' },
        },
      }) + '\n',
    );
    await deadline(initialized, 3000);
    child.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
        '\n',
    );
    child.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'echo_search',
          arguments: { query: 'STALL', overrides: { mode: 'dense' } },
        },
      }) + '\n',
    );
    await deadline(reached, 3000);
    child.stdin!.end();
    await deadline(exited, 2000);
    await deadline(closed, 1000);
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (exited) await deadline(exited, 3000);
    delete process.env[key];
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});
