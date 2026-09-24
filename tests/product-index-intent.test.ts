import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { durableCreate, assertKnownDocuments } = await import(
  pathToFileURL(resolve('evals/lib/product-index-intent.mjs')).href
);
it('does not create twice after the server accepts a document but the response is lost', async () => {
  let saved: Record<string, unknown> = {};
  let state: Record<string, unknown> = {};
  let writes = 0;
  const save = async () => {
    saved = structuredClone(state);
  };
  const post = async () => {
    writes++;
    throw new Error('connection reset after acceptance');
  };
  await expect(durableCreate(state, 'document', save, post)).rejects.toThrow(
    'connection reset',
  );
  state = structuredClone(saved);
  await expect(durableCreate(state, 'document', save, post)).rejects.toThrow(
    'uncertain',
  );
  expect(writes).toBe(1);
});
it('reuses a durably saved response after a restart without another POST', async () => {
  let saved: Record<string, unknown> = {};
  let state: Record<string, unknown> = {};
  let writes = 0;
  const save = async () => {
    saved = structuredClone(state);
  };
  const post = async () => {
    writes++;
    return { id: 'native-id' };
  };
  await durableCreate(state, 'document', save, post);
  state = structuredClone(saved);
  await expect(durableCreate(state, 'document', save, post)).resolves.toEqual({
    id: 'native-id',
  });
  expect(writes).toBe(1);
});
it('rejects an untracked or missing native document even when expected local rows look complete', () => {
  expect(() =>
    assertKnownDocuments([{ id: 'known' }, { id: 'ghost' }], ['known']),
  ).toThrow('untracked');
  expect(() => assertKnownDocuments([], ['known'])).toThrow('missing');
  expect(() =>
    assertKnownDocuments([{ id: 'known' }], ['known']),
  ).not.toThrow();
});
