import type { readStatus, StatusInput } from './status.js';
import { Worker } from 'node:worker_threads';
import type { EchoConfig } from './config.js';
import type { searchIndex } from './retrieval.js';
type SearchResult = Awaited<ReturnType<typeof searchIndex>>;
type StatusResult = Awaited<ReturnType<typeof readStatus>>;
export function runSearchInWorker(
  config: EchoConfig,
  input: unknown,
  signal?: AbortSignal,
) {
  return runIndexJob<SearchResult>(config, input, signal, 'search');
}
export function runStatusInWorker(
  config: EchoConfig,
  signal?: AbortSignal,
  input: StatusInput = {},
) {
  return runIndexJob<StatusResult>(config, input, signal, 'status');
}
function runIndexJob<T>(
  config: EchoConfig,
  input: unknown,
  signal: AbortSignal | undefined,
  kind: 'search' | 'status',
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith('.ts')
          ? './search-worker.ts'
          : './search-worker.js',
        import.meta.url,
      ),
      {
        workerData: { config, input, kind },
        stdout: true,
        stderr: true,
      },
    );
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    let cancelReason: Error | undefined;
    let forced: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | undefined, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forced) clearTimeout(forced);
      signal?.removeEventListener('abort', abort);
      void worker.terminate().then(() => {
        if (error) reject(error);
        else resolve(result!);
      }, reject);
    };
    const cancel = (reason: Error) => {
      if (settled || cancelReason) return;
      cancelReason = reason;
      worker.postMessage('abort');
      forced = setTimeout(() => finish(reason), 200);
    };
    const abort = () => cancel(new Error('Search cancelled'));
    const timeout = setTimeout(
      () => cancel(new Error('Search timed out')),
      config.runtime.search_timeout_ms,
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once(
      'message',
      (message: {
        ok: boolean;
        result?: T;
        error?: string;
        code?: string;
        next?: string;
      }) => {
        if (cancelReason) finish(cancelReason);
        else if (message.ok) finish(undefined, message.result);
        else
          finish(
            Object.assign(new Error(message.error ?? 'Search failed'), {
              code: message.code,
              next: message.next,
            }),
          );
      },
    );
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled)
        finish(
          cancelReason ??
            new Error('Search worker exited without a result: ' + code),
        );
    });
  });
}
