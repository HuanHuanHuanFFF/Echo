import assert from 'node:assert/strict';

export async function durableCreate(state, key, save, submit) {
  const previous = state[key];
  if (previous?.status === 'completed') return previous.result;
  assert.ok(
    !previous,
    'Prior create result is uncertain; reconcile before retry: ' + key,
  );
  state[key] = { status: 'pending', started_at: new Date().toISOString() };
  await save();
  try {
    const result = await submit();
    state[key] = { status: 'completed', result };
    await save();
    return result;
  } catch (error) {
    state[key] = { status: 'uncertain', error_name: error.name };
    await save();
    throw error;
  }
}

export function assertKnownDocuments(actual, tracked) {
  const ids = actual.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate remote document IDs');
  assert.deepEqual(
    [...ids].sort(),
    [...tracked].sort(),
    'Remote dataset has missing or untracked documents',
  );
}
