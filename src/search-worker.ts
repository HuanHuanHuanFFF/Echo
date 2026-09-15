import { parentPort, workerData } from 'node:worker_threads';
import type { EchoConfig } from './config.js';
import { searchIndex } from './retrieval.js';
const data = workerData as { config: EchoConfig; input: unknown };
const controller = new AbortController();
parentPort?.on('message', () =>
  controller.abort(new Error('Search cancelled')),
);
try {
  const result = await searchIndex(data.config, data.input, controller.signal);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : 'Search failed',
  });
} finally {
  parentPort?.close();
}
