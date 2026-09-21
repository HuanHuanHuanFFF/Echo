import { Worker } from 'node:worker_threads';
import type { EchoConfig } from './config.js';
import type { searchIndex } from './retrieval.js';

type Result = Awaited<ReturnType<typeof searchIndex>>;
interface Job {
  id: number;
  finish(error?: Error, result?: Result): void;
}
interface Slot {
  worker: Worker;
  job?: Job;
  stopping: boolean;
}
export class SearchWorkerPool {
  private readonly slots = new Set<Slot>();
  private readonly terminating = new Set<Promise<void>>();
  private nextId = 0;
  private created = 0;
  private closed = false;

  diagnostics() {
    return {
      created: this.created,
      workers: this.slots.size,
      active: [...this.slots].filter((slot) => slot.job).length,
    };
  }

  run(
    config: EchoConfig,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('Search pool closed'));
    if (signal?.aborted) return Promise.reject(new Error('Search cancelled'));
    let slot = [...this.slots].find((item) => !item.job && !item.stopping);
    if (!slot) {
      if (this.slots.size >= config.runtime.max_concurrent_searches)
        return Promise.reject(new Error('Echo busy; retry later'));
      slot = this.createSlot();
    }
    const current = slot;
    current.worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      let settled = false;
      let cancelReason: Error | undefined;
      let forced: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, result?: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forced);
        signal?.removeEventListener('abort', abort);
        const failure = cancelReason ?? error;
        // A cancelled/failed worker is discarded before its capacity is released.
        if (failure) {
          void this.stop(current).then(() => reject(failure), reject);
        } else {
          delete current.job;
          current.worker.unref();
          resolve(result!);
        }
      };
      const cancel = (reason: Error) => {
        if (settled || cancelReason) return;
        cancelReason = reason;
        current.worker.postMessage({ kind: 'abort', id });
        forced = setTimeout(() => finish(reason), 200);
      };
      const abort = () => cancel(new Error('Search cancelled'));
      const timeout = setTimeout(
        () => cancel(new Error('Search timed out')),
        config.runtime.search_timeout_ms,
      );
      current.job = { id, finish };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        current.worker.postMessage({ kind: 'search', id, config, input });
        if (signal?.aborted) abort();
      } catch (error) {
        finish(
          error instanceof Error ? error : new Error('Cannot start search'),
        );
      }
    });
  }

  private createSlot(): Slot {
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith('.ts')
          ? './search-session-worker.ts'
          : './search-session-worker.js',
        import.meta.url,
      ),
      { stdout: true, stderr: true },
    );
    worker.stdout.resume();
    worker.stderr.resume();
    const slot: Slot = { worker, stopping: false };
    this.created++;
    this.slots.add(slot);
    worker.on(
      'message',
      (message: {
        id: number;
        ok: boolean;
        result?: Result;
        error?: string;
        code?: string;
        next?: string;
      }) => {
        if (!slot.job || slot.job.id !== message.id || slot.stopping) return;
        if (message.ok) slot.job.finish(undefined, message.result);
        else
          slot.job.finish(
            Object.assign(new Error(message.error ?? 'Search failed'), {
              code: message.code,
              next: message.next,
            }),
          );
      },
    );
    worker.on('error', (error) => {
      if (slot.job) slot.job.finish(error);
      else void this.stop(slot);
    });
    worker.on('exit', (code) => {
      if (!slot.stopping) {
        if (slot.job)
          slot.job.finish(
            new Error('Search worker exited without a result: ' + code),
          );
        else this.slots.delete(slot);
      }
    });
    return slot;
  }

  private stop(slot: Slot): Promise<void> {
    if (slot.stopping) return Promise.resolve();
    slot.stopping = true;
    const pending = slot.worker.terminate().then(() => {
      this.slots.delete(slot);
    });
    this.terminating.add(pending);
    void pending.finally(() => this.terminating.delete(pending));
    return pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const slot of this.slots) {
      if (slot.job)
        slot.job.finish(new Error('Search cancelled: server closed'));
      else void this.stop(slot);
    }
    await Promise.all(this.terminating);
  }
}
