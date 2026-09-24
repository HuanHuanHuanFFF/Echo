import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const helperRoot = path.dirname(fileURLToPath(import.meta.url));

function sessionFileFor(options = {}) {
  if (options.sessionFile) return path.resolve(options.sessionFile);
  let root = options.root || process.env.DIFY_COMPARISON_ROOT || null;
  if (!root && path.basename(helperRoot).toLowerCase() === 'dify-runtime') {
    root = path.dirname(helperRoot);
  }
  if (!root) {
    throw new Error(
      '--root <comparison-root> is required to locate private-session.json',
    );
  }
  return path.join(path.resolve(root), 'dify-runtime', 'private-session.json');
}

function cookieHeader(session) {
  return (session.cookies || [])
    .map((item) => String(item.name) + '=' + String(item.value))
    .join('; ');
}

function parseCookie(line) {
  const first = String(line).split(';', 1)[0];
  const separator = first.indexOf('=');
  if (separator <= 0) return null;
  return {
    name: first.slice(0, separator).trim(),
    value: first.slice(separator + 1).trim(),
  };
}

function responseCookies(headers) {
  let lines = [];
  if (typeof headers.getSetCookie === 'function') {
    lines = headers.getSetCookie();
  } else {
    const combined = headers.get('set-cookie');
    if (combined) lines = combined.split(/,(?=\s*[^;,=\s]+\s*=)/);
  }
  return lines.map(parseCookie).filter(Boolean);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporary, file);
}

function baseUrlFor(session) {
  const value =
    process.env.DIFY_BASE_URL || session.base_url || 'http://localhost:15101';
  return value.replace(/\/+$/, '');
}

async function responseJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function refreshDifySession(options = {}) {
  const sessionFile = sessionFileFor(options);
  const session = await readJson(sessionFile);
  if (!session.email || !session.password) {
    throw new Error('Dify session file lacks saved login fields');
  }
  const baseUrl = baseUrlFor(session);
  const password = Buffer.from(String(session.password), 'utf8').toString(
    'base64',
  );
  let response;
  try {
    response = await fetch(baseUrl + '/console/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: session.email,
        password,
        remember_me: true,
      }),
      signal: AbortSignal.timeout(options.timeoutMs || 30000),
    });
  } catch (error) {
    throw new Error(
      'Dify login request did not return an HTTP response: ' +
        String(error?.name || 'network error'),
    );
  }
  const body = await responseJson(response);
  if (!response.ok || body?.result !== 'success') {
    throw new Error('Dify login failed with HTTP ' + response.status);
  }

  const received = responseCookies(response.headers);
  if (!received.some((item) => item.name === 'access_token')) {
    throw new Error('Dify login succeeded without an access_token cookie');
  }
  const merged = new Map(
    (session.cookies || []).map((item) => [String(item.name), item]),
  );
  for (const item of received) merged.set(item.name, item);
  session.base_url = baseUrl;
  session.cookies = [...merged.values()];
  session.session_refreshed_at = new Date().toISOString();
  await writeJsonAtomic(sessionFile, session);
  return {
    session,
    refreshed: true,
    cookie_names: received.map((item) => item.name),
    session_file: sessionFile,
  };
}

export async function loadDifySession(options = {}) {
  const sessionFile = sessionFileFor(options);
  let session = await readJson(sessionFile);
  const baseUrl = baseUrlFor(session);
  const forceRefresh = options.forceRefresh === true;
  if (!forceRefresh && session.cookies?.length) {
    let response;
    try {
      response = await fetch(baseUrl + '/console/api/account/profile', {
        headers: { Cookie: cookieHeader(session) },
        signal: AbortSignal.timeout(options.timeoutMs || 15000),
      });
    } catch (error) {
      throw new Error(
        'Dify session validation did not return an HTTP response: ' +
          String(error?.name || 'network error'),
      );
    }
    if (response.ok) {
      return {
        session,
        refreshed: false,
        cookie_names: (session.cookies || []).map((item) => item.name),
        session_file: sessionFile,
      };
    }
    if (response.status !== 401 && response.status !== 403) {
      throw new Error(
        'Dify session validation failed with HTTP ' + response.status,
      );
    }
  }
  const refreshed = await refreshDifySession({ ...options, sessionFile });
  session = refreshed.session;
  return refreshed;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (invokedPath === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'Dify local console session refresh. Use --root <comparison-root>; session is read from ROOT/dify-runtime/private-session.json.\n',
    );
  } else {
    const rootIndex = args.indexOf('--root');
    loadDifySession({
      forceRefresh: args.includes('--refresh'),
      root: rootIndex >= 0 ? args[rootIndex + 1] : undefined,
    })
      .then((result) => {
        process.stdout.write(
          JSON.stringify({
            refreshed: result.refreshed,
            cookie_names: result.cookie_names,
            session_file: result.session_file,
          }) + '\n',
        );
      })
      .catch((error) => {
        process.stderr.write(String(error.message || error) + '\n');
        process.exitCode = 1;
      });
  }
}
