import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
export async function runPool(
  workerUrl,
  workerData,
  jobs,
  concurrency,
  onResult,
) {
  assert.ok(
    Number.isInteger(concurrency) && concurrency > 0,
    'Invalid worker count',
  );
  const workers = [],
    result = new Array(jobs.length);
  let next = 0,
    finished = 0,
    failed = false;
  try {
    await new Promise((resolve, reject) => {
      const fail = (e) => {
        if (!failed) {
          failed = true;
          reject(e);
        }
      };
      for (let i = 0; i < Math.min(concurrency, jobs.length); i++) {
        const worker = new Worker(workerUrl, { workerData });
        workers.push(worker);
        const dispatch = () => {
          if (!failed && next < jobs.length) {
            const job = next++;
            worker.postMessage({ job, ...jobs[job] });
          }
        };
        worker.on('error', fail);
        worker.on('exit', (code) => {
          if (finished < jobs.length && !failed)
            fail(Error('Worker exited before completion: ' + code));
        });
        worker.on('message', (message) => {
          if (failed) return;
          if (message.ready) {
            dispatch();
            return;
          }
          if (message.error) {
            fail(Error(message.error));
            return;
          }
          if (
            !Number.isInteger(message.job) ||
            message.job < 0 ||
            message.job >= jobs.length ||
            result[message.job] !== undefined
          ) {
            fail(Error('Unexpected worker result'));
            return;
          }
          result[message.job] = message.row;
          finished++;
          try {
            onResult?.(finished, jobs.length);
          } catch (e) {
            fail(e);
            return;
          }
          if (finished === jobs.length) resolve();
          else dispatch();
        });
      }
      if (jobs.length === 0) resolve();
    });
    return result;
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}
