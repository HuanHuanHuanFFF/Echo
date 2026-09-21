import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseConfig } from '../src/config.js';
import { syncIndex } from '../src/sync.js';
import { openDatabase } from '../src/database.js';
import { tokenize } from '../src/lexical.js';
import type { EmbeddingProvider } from '../src/contracts.js';

const { lane } = await import(
  pathToFileURL(resolve('evals/run-minisearch-parameter-exploration.mjs')).href
);

it('isolates actual cached lexical results across RRF, candidate cap and title-weight arms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-eval-cache-'));
  const notes = join(dir, 'notes');
  await mkdir(notes);
  await writeFile(join(notes, 'a.md'), '# Alpha\napple apple');
  await writeFile(join(notes, 'b.md'), '# Beta\napple');
  await writeFile(join(notes, 'c.md'), '# apple\nunrelated');
  const config = parseConfig({
    database: join(dir, 'index.sqlite'),
    collections: [{ id: 'notes', root: notes }],
    retrieval: { mode: 'bm25' },
  });
  const provider: EmbeddingProvider = {
    fingerprint: 'isolated-cache-test-v1',
    dimensions: 2,
    async embed(texts, kind) {
      return texts.map((text) =>
        kind === 'query' || text.includes('Alpha')
          ? [1, 0]
          : text.includes('Beta')
            ? [0.8, 0.6]
            : [0, 1],
      );
    },
  };
  await syncIndex(config, undefined, provider);
  const db = openDatabase(config.database);
  // Isolate a title-only index hit; Markdown headings otherwise also appear in body.
  const changed = db
    .prepare(
      "UPDATE chunk_fts SET body=? WHERE rowid IN (SELECT c.rowid FROM chunks c JOIN sources s USING(source_id) WHERE s.relative_path='c.md')",
    )
    .run(tokenize('unrelated', config.lexical).join(' '));
  expect(changed.changes).toBe(1);
  try {
    const context = {
      db,
      config,
      laneCache: new Map(),
      provider,
      index: undefined,
    };
    const arm = {
      minisearch_k: 1.2,
      minisearch_b: 0.7,
      minisearch_d: 0.5,
      bm25_weight: 0.5,
      dense_weight: 1,
      rrf_k: 10,
      retrieval: { bm25_candidates: 1 },
    };
    const first = await lane(context, 'q', 'apple', {}, arm, 'bm25');
    expect(first.counts.bm25).toBe(1);
    expect(first.candidates[0].score).toBeCloseTo(1 / 11, 14);
    const rrf5 = await lane(
      context,
      'q',
      'apple',
      {},
      { ...arm, rrf_k: 5 },
      'bm25',
    );
    expect(rrf5.candidates[0].score).toBeCloseTo(1 / 6, 14);
    const expanded = await lane(
      context,
      'q',
      'apple',
      {},
      { ...arm, retrieval: { bm25_candidates: 3 } },
      'bm25',
    );
    expect(expanded.counts.bm25).toBe(3);
    const noTitle = await lane(
      context,
      'q',
      'apple',
      {},
      { ...arm, retrieval: { bm25_candidates: 3, title_weight: 0 } },
      'bm25',
    );
    expect(noTitle.counts.bm25).toBe(2);
    expect(
      noTitle.candidates.every((c: { evidence: { text: string } }) =>
        c.evidence.text.includes('apple'),
      ),
    ).toBe(true);
    const packedOnly = await lane(
      context,
      'q',
      'apple',
      {},
      {
        ...arm,
        retrieval: {
          ...arm.retrieval,
          topk: 5,
          max_chunks_per_source: 6,
          max_context_chars: 20000,
        },
      },
      'bm25',
    );
    expect(packedOnly).toBe(first);
    const denseOne = await lane(
      context,
      'q',
      'apple',
      {},
      { ...arm, retrieval: { dense_candidates: 1, min_dense_similarity: -1 } },
      'dense',
    );
    expect(denseOne.counts.dense).toBe(1);
    const denseAll = await lane(
      context,
      'q',
      'apple',
      {},
      { ...arm, retrieval: { dense_candidates: 3, min_dense_similarity: -1 } },
      'dense',
    );
    expect(denseAll.counts.dense).toBe(3);
    const denseStrict = await lane(
      context,
      'q',
      'apple',
      {},
      { ...arm, retrieval: { dense_candidates: 3, min_dense_similarity: 0.9 } },
      'dense',
    );
    expect(denseStrict.counts.dense).toBe(1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
