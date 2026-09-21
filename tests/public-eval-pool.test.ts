import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { runPool } = await import(
  pathToFileURL(resolve('evals/lib/public-eval-pool.mjs')).href
);
it('keeps job identity while workers finish out of order and terminates failed workers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-eval-pool-')),
    file = join(dir, 'worker.mjs');
  try {
    await writeFile(
      file,
      `import {parentPort} from 'node:worker_threads';parentPort.on('message',({job,value,fail})=>{if(fail){parentPort.postMessage({job,error:'fixture failure'});return;}setTimeout(()=>parentPort.postMessage({job,row:value*2}),value===1?80:1);});parentPort.postMessage({ready:true});`,
    );
    const got = await runPool(
      pathToFileURL(file),
      {},
      [{ value: 1 }, { value: 2 }, { value: 3 }],
      2,
    );
    expect(got).toEqual([2, 4, 6]);
    await expect(
      runPool(pathToFileURL(file), {}, [{ value: 1 }, { fail: true }], 2),
    ).rejects.toThrow('fixture failure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
