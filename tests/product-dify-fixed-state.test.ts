import { expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { inspectFixedIndexState } = await import(
  pathToFileURL(path.resolve('evals/lib/product-dify-fixed-state.mjs')).href
);
const documentId = '06119535-bb7e-4c79-ad03-78db07088563';
function state(count = 2) {
  return {
    source_kind: 'official-fixed-unit',
    status: 'segments-verified-awaiting-vector-audit',
    total_units: count,
    committed_units: count,
    pending_batch: null,
    container_cleaned: true,
    documents: {
      container: {
        document_id: documentId,
        status: 'ready',
        segment_count: count,
        vector_ready_segments: count,
      },
    },
    segment_audit: {
      expected: count,
      actual: count,
      exact_content_sha256_matches: count,
      completed_enabled_with_index_ids: count,
      unique_segment_ids: count,
      unique_index_node_ids: count,
    },
  };
}
it('accepts one native Dify container holding multiple distinct official units', () => {
  const result = inspectFixedIndexState(state(), 2);
  expect(result.containerDocumentId).toBe(documentId);
  expect([...result.byDocument.keys()]).toEqual([documentId]);
  expect(result.bySource.size).toBe(0);
});
it('rejects an incomplete segment or vector audit', () => {
  const value = state();
  value.segment_audit.unique_segment_ids--;
  expect(() => inspectFixedIndexState(value, 2)).toThrow(
    'Fixed Dify segment audit is incomplete',
  );
});
it('rejects an extra document or an unfinished write checkpoint', () => {
  const extra = state();
  (extra.documents as Record<string, unknown>).stray = { document_id: 'stray' };
  expect(() => inspectFixedIndexState(extra, 2)).toThrow();
  const pending = state();
  (pending as Record<string, unknown>).pending_batch = { start: 1, count: 1 };
  expect(() => inspectFixedIndexState(pending, 2)).toThrow();
});
