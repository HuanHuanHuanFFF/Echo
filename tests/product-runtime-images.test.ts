import { expect, it, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const state = vi.hoisted(() => ({
  calls: [] as string[][],
  image: 'sha256:' + 'a'.repeat(64),
}));
vi.mock('node:child_process', () => ({
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, value: { stdout: string }) => void,
  ) => {
    state.calls.push(args);
    callback(null, { stdout: state.image + '\n' });
  },
}));
const { verifyRuntimeImages } = await import(
  pathToFileURL(path.resolve('evals/lib/product-freeze.mjs')).href
);
const pins = () =>
  [
    'khoj-product-comparison-server-1',
    'khoj-product-comparison-database-1',
  ].map((name) => ({ name, image_id: 'sha256:' + 'a'.repeat(64) }));
beforeEach(() => {
  state.calls.length = 0;
  state.image = 'sha256:' + 'a'.repeat(64);
});
it('checks both actual Khoj images without reading container environments', async () => {
  expect(await verifyRuntimeImages(pins(), 'khoj')).toEqual(pins());
  expect(state.calls).toEqual(
    pins().map((item) => ['inspect', '--format', '{{.Image}}', item.name]),
  );
});
it('rejects a running image that differs from the frozen deployment', async () => {
  state.image = 'sha256:' + 'b'.repeat(64);
  await expect(verifyRuntimeImages(pins(), 'khoj')).rejects.toThrow(
    'Runtime container image changed',
  );
});
it('rejects a missing container binding before querying the service', async () => {
  await expect(verifyRuntimeImages([], 'khoj')).rejects.toThrow(
    'Missing or duplicate',
  );
  expect(state.calls).toHaveLength(0);
});
