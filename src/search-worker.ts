import { parentPort, workerData } from 'node:worker_threads';
import type { EchoConfig } from './config.js';
import { searchIndex } from './retrieval.js';
import { openDatabase, databaseCapabilities } from './database.js';
import { indexStatus } from './store.js';
const data = workerData as {
  config: EchoConfig;
  input: unknown;
  kind: 'search' | 'status';
};
const controller = new AbortController();
parentPort?.on('message', () =>
  controller.abort(new Error('Search cancelled')),
);
try {
  let result: unknown;
  if (data.kind === 'status') {
    const db = openDatabase(data.config.database, { readOnly: true });
    try {
      result = { ...indexStatus(db), capabilities: databaseCapabilities(db) };
    } finally {
      db.close();
    }
  } else result = await searchIndex(data.config, data.input, controller.signal);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : 'Search failed',
  });
} finally {
  parentPort?.close();
}
