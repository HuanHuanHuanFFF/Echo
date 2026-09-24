import assert from 'node:assert/strict';

export function inspectFixedIndexState(state, expectedUnits) {
  assert.equal(state.source_kind, 'official-fixed-unit');
  assert.equal(state.status, 'segments-verified-awaiting-vector-audit');
  assert.equal(state.total_units, expectedUnits);
  assert.equal(state.committed_units, expectedUnits);
  assert.equal(state.pending_batch, null);
  assert.equal(state.container_cleaned, true);
  assert.ok(
    state.documents &&
      typeof state.documents === 'object' &&
      !Array.isArray(state.documents),
  );
  assert.deepEqual(Object.keys(state.documents), ['container']);
  const container = state.documents.container;
  assert.match(
    String(container.document_id),
    /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,
  );
  assert.ok(['ready', 'completed'].includes(container.status));
  for (const value of [
    container.segment_count,
    container.vector_ready_segments,
    state.segment_audit?.expected,
    state.segment_audit?.actual,
    state.segment_audit?.exact_content_sha256_matches,
    state.segment_audit?.completed_enabled_with_index_ids,
    state.segment_audit?.unique_segment_ids,
    state.segment_audit?.unique_index_node_ids,
  ])
    assert.equal(
      value,
      expectedUnits,
      'Fixed Dify segment audit is incomplete',
    );
  return {
    bySource: new Map(),
    byDocument: new Map([
      [container.document_id, { document_id: container.document_id }],
    ]),
    containerDocumentId: container.document_id,
  };
}
