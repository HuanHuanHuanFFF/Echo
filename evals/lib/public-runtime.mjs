import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../prepare-public-benchmarks.mjs';
export async function runtimeContext(root) {
  const base = path.join(root, 'runtime/dist');
  const load = (name) =>
    import(pathToFileURL(path.join(base, name + '.js')).href);
  const [
    { openDatabase },
    { embeddingFingerprint },
    { loadConfig, parseConfig },
    retrieval,
    store,
    lexical,
  ] = await Promise.all(
    ['database', 'embedding', 'config', 'retrieval', 'store', 'lexical'].map(
      load,
    ),
  );
  const plan = JSON.parse(
    await fs.readFile(path.join(root, 'embedding-plan.json'), 'utf8'),
  );
  assert.equal(plan.fingerprint, embeddingFingerprint(plan.config));
  const cache = openDatabase(path.join(root, 'vectors.sqlite'), {
    readOnly: true,
  });
  const find = cache.prepare(
    'SELECT vector,vector_sha FROM entries WHERE key=?',
  );
  const getVector = (purpose, input) => {
    const key = digest(JSON.stringify([plan.fingerprint, purpose, input]));
    const saved = find.get(key);
    assert.ok(saved?.vector, 'Real vector not ready ' + key);
    assert.equal(
      digest(saved.vector),
      saved.vector_sha,
      'Corrupted real vector ' + key,
    );
    assert.equal(saved.vector.byteLength, 4096);
    return Array.from(
      new Float32Array(
        saved.vector.buffer.slice(
          saved.vector.byteOffset,
          saved.vector.byteOffset + saved.vector.byteLength,
        ),
      ),
    );
  };
  const provider = {
    fingerprint: plan.fingerprint,
    dimensions: 1024,
    async embed(texts, purpose) {
      return texts.map((t) => getVector(purpose, t));
    },
  };
  return {
    root,
    load,
    openDatabase,
    loadConfig,
    parseConfig,
    ...retrieval,
    ...store,
    ...lexical,
    plan,
    cache,
    getVector,
    provider,
  };
}
export function boundedRequest(
  query,
  sourceId,
  budget = 16000,
  overrides = {},
) {
  let allowance = budget;
  for (let i = 0; i < 5; i++) {
    const request = {
      query,
      filters: { source_ids: [sourceId] },
      overrides: { ...overrides, max_context_chars: allowance },
    };
    const next = budget - JSON.stringify(request).length;
    if (next >= allowance) {
      assert.ok(allowance >= 256);
      return request;
    }
    allowance = next;
  }
  throw Error('Request cannot fit context budget');
}
export function qasperScore(q, doc, result, markdown) {
  const lines = markdown.split('\n'),
    covered = new Set();
  for (const piece of result.results) {
    assert.equal(piece.source_id, doc.source_id);
    assert.equal(
      lines.slice(piece.start_line - 1, piece.end_line).join('\n'),
      piece.text,
    );
    for (let n = piece.start_line; n <= piece.end_line; n++)
      if (lines[n - 1].trim()) covered.add(n);
  }
  const full = doc.paragraphs.filter((p) => {
    for (let n = p.start_line; n <= p.end_line; n++)
      if (lines[n - 1].trim() && !covered.has(n)) return false;
    return true;
  });
  const ids = new Set(full.map((p) => p.id)),
    predicted = full.map((p) => p.text);
  const perAnnotation = q.annotations.map((a) => {
    const gold = new Set(a.evidence.map((e) => e.text));
    const correct = [...new Set(predicted)].filter((p) => gold.has(p)).length;
    const f1 =
      predicted.length + a.evidence.length === 0
        ? 1
        : (2 * correct) / (predicted.length + a.evidence.length);
    const coveredFacts = a.evidence.filter((e) =>
      e.paragraph_ids.some((id) => ids.has(id)),
    ).length;
    return {
      id: a.id,
      valid: a.valid,
      evidence_f1: f1,
      coverage: a.evidence.length ? coveredFacts / a.evidence.length : 0,
      complete: a.valid && coveredFacts === a.evidence.length,
    };
  });
  const valid = perAnnotation.filter((a) => a.valid);
  return {
    eligible: q.eligible,
    category: q.category,
    official_formula_evidence_f1: Math.max(
      ...perAnnotation.map((a) => a.evidence_f1),
    ),
    strict_coverage: valid.length
      ? Math.max(...valid.map((a) => a.coverage))
      : null,
    strict_complete: valid.some((a) => a.complete),
    selected_paragraphs: full.map((p) => p.id),
    per_annotation: perAnnotation,
  };
}
