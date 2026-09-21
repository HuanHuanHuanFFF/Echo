import { parentPort } from 'node:worker_threads';
import type { EchoConfig } from './config.js';
import { searchIndex } from './retrieval.js';
import { failureInfo } from './errors.js';

let active: { id: number; controller: AbortController } | undefined;
parentPort!.on(
  'message',
  async (message: {
    kind: 'search' | 'abort';
    id: number;
    config: EchoConfig;
    input: unknown;
  }) => {
    if (message.kind === 'abort') {
      if (active?.id === message.id)
        active.controller.abort(new Error('Search cancelled'));
      return;
    }
    // Each session accepts one request at a time; never share a SQLite snapshot.
    if (active) throw new Error('Search worker received concurrent jobs');
    const controller = new AbortController();
    active = { id: message.id, controller };
    try {
      const result = await searchIndex(
        message.config,
        message.input,
        controller.signal,
      );
      parentPort!.postMessage({ id: message.id, ok: true, result });
    } catch (error) {
      parentPort!.postMessage({
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : 'Search failed',
        ...failureInfo(error),
      });
    } finally {
      active = undefined;
    }
  },
);
