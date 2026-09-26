// Isolated, local-only measurement. Source reads are warm after writing/syncing.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../dist/config.js';
import { syncIndex } from '../dist/sync.js';
import { readStatus } from '../dist/status.js';
import { searchIndex } from '../dist/retrieval.js';

const directory = await realpath(
  await mkdtemp(join(tmpdir(), 'echo-hash-measure-')),
);
try {
  const root = join(directory, 'notes');
  await mkdir(root);
  const files = 1000;
  const body =
    '# Transaction notes\n\n' +
    'A failed transaction rolls back uncommitted changes. 修改笔记后同步索引。\n'.repeat(
      40,
    );
  let bytes = 0;
  for (let n = 0; n < files; n++) {
    const raw = `---\necho_id: 00000000-0000-4000-8000-${String(n).padStart(12, '0')}\n---\n${body}`;
    bytes += Buffer.byteLength(raw);
    await writeFile(join(root, `${n}.md`), raw);
  }
  const config = parseConfig({
    database: join(directory, 'index.sqlite'),
    collections: [{ id: 'sample', root }],
    retrieval: { mode: 'bm25' },
  });
  await syncIndex(config);
  const quickStart = performance.now();
  const quick = await readStatus(config);
  const quickMs = Math.round(performance.now() - quickStart);
  assert.equal(quick.freshness.state, 'unchecked');
  const measurements = [];
  for (let n = 0; n < 3; n++) {
    const status = await readStatus(config, { check_sources: true });
    assert.equal(status.needs_sync, false);
    assert.equal(status.freshness.files_checked, files);
    assert.equal(status.freshness.bytes_read, bytes);
    measurements.push(status.freshness.duration_ms);
  }
  const compact = await searchIndex(config, { query: 'transaction rollback' });
  const diagnostic = await searchIndex(config, {
    query: 'transaction rollback',
    diagnostics: true,
  });
  for (const result of [compact, diagnostic])
    assert.ok(
      JSON.stringify(result).length <= config.retrieval.max_context_chars,
    );
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        files,
        bytes,
        source: 'generated local fixture; SHA-256 matches index; no API calls',
        cache: 'warm after fixture creation and sync; three consecutive scans',
        quick_status_ms: quickMs,
        hash_scan_ms: measurements,
        retrieval: config.retrieval,
        compact: {
          chunks: compact.results.length,
          response_chars: JSON.stringify(compact).length,
        },
        diagnostics: {
          chunks: diagnostic.results.length,
          response_chars: JSON.stringify(diagnostic).length,
        },
      },
      null,
      2,
    ),
  );
} finally {
  // directory is exactly the temporary folder returned by mkdtemp above.
  await rm(directory, { recursive: true, force: true });
}
