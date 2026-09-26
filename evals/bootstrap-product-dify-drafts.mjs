import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadDifySession } from './lib/dify-auth.mjs';
const [rootArg] = process.argv.slice(2);
assert.ok(rootArg);
const root = path.resolve(rootArg);
const manifest = JSON.parse(
  await fs.readFile(path.join(root, 'corpus-v1/manifest.json'), 'utf8'),
);
const stateFile = path.join(root, 'dify-runtime/draft-bootstrap-state.json');
const state = await fs
  .readFile(stateFile, 'utf8')
  .then(JSON.parse)
  .catch((e) => {
    if (e.code !== 'ENOENT') throw e;
    return { apps: {} };
  });
const save = () =>
  fs.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n');
const { session } = await loadDifySession({
  sessionFile: path.join(root, 'dify-runtime/private-session.json'),
});
const cookie = (session.cookies ?? [])
  .map((x) => x.name + '=' + x.value)
  .join('; ');
const csrf = session.cookies.find((x) => x.name === 'csrf_token')?.value;
assert.ok(csrf);
async function call(route, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:15101/console/api' + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': csrf,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  const value = await response.json();
  return { status: response.status, ok: response.ok, value };
}
const graph = {
  nodes: [
    {
      id: 'start',
      type: 'custom',
      position: { x: 0, y: 0 },
      data: {
        type: 'start',
        title: 'Start',
        variables: [
          {
            variable: 'query',
            label: 'query',
            type: 'paragraph',
            required: true,
            max_length: 20000,
          },
        ],
      },
    },
    {
      id: 'end',
      type: 'custom',
      position: { x: 300, y: 0 },
      data: {
        type: 'end',
        title: 'End',
        outputs: [
          {
            variable: 'result',
            value_selector: ['start', 'query'],
            value_type: 'string',
          },
        ],
      },
    },
  ],
  edges: [
    {
      id: 'bootstrap-start-end',
      source: 'start',
      target: 'end',
      type: 'custom',
    },
  ],
  viewport: { x: 0, y: 0, zoom: 0.7 },
};
for (const scope of Object.keys(manifest.scopes)) {
  const name = 'Echo Dify formal retrieval ' + scope;
  const listing = await call('/apps?mode=workflow&limit=100&page=1');
  assert.ok(listing.ok);
  const matches = (listing.value.data ?? listing.value).filter(
    (x) => x.name === name,
  );
  assert.ok(matches.length <= 1, 'Ambiguous formal app name');
  let app = matches[0];
  if (!app) {
    assert.ok(
      !state.apps[scope]?.create_pending,
      'Uncertain app creation must be reconciled before retry',
    );
    state.apps[scope] = { create_pending: true };
    await save();
    const created = await call('/apps', 'POST', {
      name,
      mode: 'workflow',
      description:
        'Frozen retrieval comparison; draft initialized without executing a query.',
    });
    assert.ok(created.ok, 'App creation failed');
    app = created.value.data ?? created.value;
    assert.ok(app.id);
  }
  state.apps[scope] = {
    ...state.apps[scope],
    app_id: app.id,
    create_pending: false,
  };
  await save();
  const draft = await call('/apps/' + app.id + '/workflows/draft');
  if (draft.ok) {
    state.apps[scope].draft = 'already-present';
    await save();
    continue;
  }
  assert.equal(draft.status, 404);
  assert.equal(draft.value.code, 'draft_workflow_not_exist');
  assert.ok(
    !state.apps[scope].draft_pending,
    'Uncertain draft creation must be reconciled before retry',
  );
  state.apps[scope].draft_pending = true;
  await save();
  const result = await call('/apps/' + app.id + '/workflows/draft', 'POST', {
    graph,
    features: {},
    hash: null,
    _is_collaborative: false,
    environment_variable_patch: {
      environment_variables: [],
      deleted_environment_variable_ids: [],
    },
    conversation_variables: [],
  });
  assert.ok(
    result.ok,
    'Initial draft creation failed with HTTP ' + result.status,
  );
  const observed = await call('/apps/' + app.id + '/workflows/draft');
  assert.ok(observed.ok);
  assert.deepEqual((observed.value.data ?? observed.value).graph, graph);
  state.apps[scope].draft_pending = false;
  state.apps[scope].draft = 'initialized-not-published';
  await save();
  console.log(
    JSON.stringify({
      scope,
      status: 'initial-draft-ready',
      model_calls: 0,
      queries_executed: 0,
    }),
  );
}
