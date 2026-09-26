import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inspect publication text, including JSON/JS escaping and URL-encoded paths.
export function machinePaths(text) {
  const decoded = text
    .replace(/\\\//g, '/')
    .replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    })
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  const patterns = [
    /(?<![a-z0-9])[a-z]:[\\/]+[^\s"'`<>()\[\]{},;，。；：、]+/gi,
    /\/(?:Users|home)\/[^\s/"'`<>()]+(?:\/[^\s"'`<>()]*)?/g,
    /(?<![a-z0-9\\:/])\\{2,}[\p{L}\p{N}_.-]+[\\/]+[\p{L}\p{N}_.$-]+(?:[\\/][^\s"'`<>()\[\]{},;]+)?/giu,
  ];
  return (
    patterns
      .flatMap((pattern) => [...decoded.matchAll(pattern)])
      .map((m) => ({
        path: m[0].replace(/[\\/]+/g, '/'),
        line: decoded.slice(0, m.index).split('\n').length,
      }))
      // Explicitly generic documentation and invalid-path test examples only.
      .filter(
        (m) =>
          !/[\u0000-\u001f]/.test(m.path) &&
          !/^c:\/path\/to\//i.test(m.path) &&
          m.path !== 'C:/notes/a' &&
          m.path !== '/server/share' &&
          m.path !== '/host/share',
      )
  );
}

export async function checkPublicPaths(
  root = fileURLToPath(new URL('../', import.meta.url)),
) {
  let files;
  try {
    files = execFileSync(
      'git',
      [
        '-c',
        'safe.directory=' + root.replaceAll('\\', '/').replace(/\/$/, ''),
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .split('\0')
      .filter(Boolean);
  } catch {
    return {
      files: 0,
      failures: [{ file: '.', code: 'GIT_FILES_UNAVAILABLE' }],
    };
  }
  const failures = [];
  for (const file of new Set(files)) {
    let bytes;
    try {
      bytes = await readFile(resolve(root, file));
    } catch (error) {
      if (error.code !== 'ENOENT')
        failures.push({ file, code: 'UNREADABLE_FILE' });
      continue;
    }
    if (bytes.includes(0)) continue;
    for (const hit of machinePaths(bytes.toString('utf8')))
      failures.push({ file, line: hit.line });
  }
  return { files: new Set(files).size, failures };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await checkPublicPaths();
  // Do not reproduce private values in CI logs.
  if (result.failures.length) {
    console.error(
      JSON.stringify({
        error: 'Machine-specific paths must be replaced before publication',
        locations: result.failures,
      }),
    );
    process.exitCode = 1;
  } else console.log(`Public path check passed (${result.files} files).`);
}
