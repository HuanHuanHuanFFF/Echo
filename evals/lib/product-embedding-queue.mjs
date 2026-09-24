// Coalesce concurrent one-text product calls into the already configured API
// batch size. Texts, ordering, model inputs, and cached vectors stay unchanged.
export function createEmbeddingQueue({
  cached,
  remote,
  batchSize,
  delayMs = 20,
  onHit = () => {},
}) {
  const pending = new Map();
  const queued = [];
  let running = false;
  async function drain() {
    running = true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    while (queued.length) {
      const jobs = queued.splice(0, batchSize);
      try {
        const texts = jobs
          .map((job) => job.text)
          .filter((text) => !cached(text));
        if (texts.length) await remote(texts);
        for (const job of jobs) {
          const vector = cached(job.text);
          if (!vector) throw new Error('Missing completed vector');
        }
        for (const job of jobs) job.resolve(cached(job.text));
      } catch (error) {
        for (const job of jobs) job.reject(error);
      } finally {
        for (const job of jobs) pending.delete(job.text);
      }
    }
    running = false;
  }
  return async function embeddings(inputs) {
    return Promise.all(
      inputs.map((text) => {
        const hit = cached(text);
        if (hit) {
          onHit();
          return hit;
        }
        if (!pending.has(text)) {
          let resolve, reject;
          const promise = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          });
          pending.set(text, promise);
          queued.push({ text, resolve, reject });
        }
        const promise = pending.get(text);
        if (!running) void drain();
        return promise;
      }),
    );
  };
}
