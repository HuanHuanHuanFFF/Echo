import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mapDifyPartition } from './lib/dify-evidence.mjs';
import {
  sourceLineSpans,
  spansCover,
  packProductEvidence,
} from './lib/product-evidence.mjs';
import { jsonLines } from './prepare-product-comparison.mjs';

const [pilotArg, baselineArg] = process.argv.slice(2);
assert.ok(pilotArg && baselineArg, 'Expected PILOT_ROOT BASELINE_ROOT');
const pilotRoot = path.resolve(pilotArg);
const baselineRoot = path.resolve(baselineArg);
const manifest = JSON.parse(
  await fs.readFile(path.join(pilotRoot, 'corpus-v1/manifest.json'), 'utf8'),
);
const freeze = JSON.parse(
  await fs.readFile(path.join(pilotRoot, 'freeze.json'), 'utf8'),
);
const baselineManifest = JSON.parse(
  await fs.readFile(path.join(baselineRoot, 'corpus-v1/manifest.json'), 'utf8'),
);
assert.equal(freeze.status, 'frozen');
const digest = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(
  digest(await fs.readFile(path.join(pilotRoot, 'corpus-v1/manifest.json'))),
  freeze.corpus_manifest_sha256,
);
const rows = async (file) => {
  const result = [];
  for await (const row of jsonLines(file)) result.push(row);
  return result;
};
const sourceKey = (collection, relative) =>
  JSON.stringify([collection, relative]);
const covers = (anchor, pieces, sourceByPath) => {
  const source = sourceByPath.get(sourceKey(anchor.collection_id, anchor.path));
  assert.ok(source);
  const available = pieces
    .filter((piece) => piece.source_id === source.id)
    .flatMap((piece) => piece.spans);
  return sourceLineSpans(source, anchor.start_line, anchor.end_line).every(
    ([start, end]) => spansCover(available, start, end),
  );
};
const mean = (items) =>
  items.length ? items.reduce((sum, item) => sum + item, 0) / items.length : 0;
const summary = {
  status: 'single-variable-pilot-scored',
  condition: 'dify-parent-separator-triple-newline',
  baseline: 'original-dify-double-newline',
  scopes: {},
};
for (const [scope, info] of Object.entries(manifest.scopes)) {
  const originalScope = scope.startsWith('A-') ? 'A-test' : 'C-test';
  assert.equal(scope, `${originalScope[0]}-s3b-0925`);
  for (const field of ['corpus', 'queries', 'labels']) {
    assert.equal(
      info[field].sha256,
      baselineManifest.scopes[originalScope][field].sha256,
    );
  }
  for (const input of [info.corpus, info.queries, info.labels]) {
    assert.equal(digest(await fs.readFile(input.path)), input.sha256);
  }
  const sources = await rows(info.corpus.path);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const sourceByPath = new Map(
    sources.map((source) => [
      sourceKey(source.collection_id, source.relative_path),
      source,
    ]),
  );
  const labels = JSON.parse(await fs.readFile(info.labels.path, 'utf8'));
  const gold = new Map(labels.questions.map((item) => [item.id, item]));
  const facts = new Map(labels.facts.map((item) => [item.id, item]));
  const questions = await rows(info.queries.path);
  const runFile = path.join(pilotRoot, 'runs/dify', `${scope}.jsonl`);
  const runReceipt = JSON.parse(
    await fs.readFile(
      path.join(pilotRoot, 'runs/dify', `${scope}.receipt.json`),
      'utf8',
    ),
  );
  assert.equal(runReceipt.status, 'completed');
  assert.equal(runReceipt.scope, scope);
  assert.equal(runReceipt.parent_questions, info.questions);
  assert.equal(runReceipt.output_sha256, digest(await fs.readFile(runFile)));
  assert.equal(
    runReceipt.freeze_sha256,
    digest(await fs.readFile(path.join(pilotRoot, 'freeze.json'))),
  );
  assert.equal(
    runReceipt.native_files.length,
    questions.reduce((sum, question) => sum + question.queries.length, 0),
  );
  for (const entry of [
    ...runReceipt.native_files,
    ...runReceipt.runtime_snapshots,
    ...runReceipt.scope_execution_files,
  ]) {
    assert.equal(
      digest(await fs.readFile(path.resolve(pilotRoot, entry.path))),
      entry.sha256,
    );
  }
  const runs = await rows(runFile);
  const oldScores = await rows(
    path.join(baselineRoot, 'scores/dify', `${originalScope}.jsonl`),
  );
  assert.deepEqual(
    runs.map((item) => item.id),
    questions.map((item) => item.id),
  );
  assert.deepEqual(
    oldScores.map((item) => item.id),
    questions.map((item) => item.id),
  );
  const receipt = JSON.parse(
    await fs.readFile(
      path.join(pilotRoot, 'indexes/dify', scope, 'query-index-receipt.json'),
      'utf8',
    ),
  );
  assert.equal(
    runReceipt.query_index_receipt_sha256,
    digest(
      await fs.readFile(
        path.join(pilotRoot, 'indexes/dify', scope, 'query-index-receipt.json'),
      ),
    ),
  );
  assert.equal(receipt.status, 'frozen');
  assert.equal(receipt.corpus_sha256, info.corpus.sha256);
  const pins = new Map(
    receipt.execution_files.map((item) => [
      path.resolve(item.path),
      item.sha256,
    ]),
  );
  const mappings = new Map();
  let parentSegments = 0;
  const lengths = [];
  for (const source of sources) {
    const file = path.join(
      pilotRoot,
      'indexes/dify',
      scope,
      `${source.id}.segments.json`,
    );
    const bytes = await fs.readFile(file);
    assert.equal(digest(bytes), pins.get(path.resolve(file)));
    const native = JSON.parse(bytes);
    assert.equal(native.source_id, source.id);
    assert.equal(native.source_text_sha256, source.text_sha256);
    const mapped = mapDifyPartition(native.segments, source);
    assert.equal(mapped.partition_verified, true);
    for (const item of mapped.mappings) {
      assert.equal(item.mapping.status, 'mapped');
      mappings.set(item.id, {
        source_id: source.id,
        text: native.segments.find((segment) => segment.id === item.id).content,
        spans: item.mapping.spans,
      });
    }
    parentSegments += native.segments.length;
    lengths.push(...native.segments.map((segment) => segment.content.length));
  }
  const scored = [];
  for (let index = 0; index < runs.length; index++) {
    const result = runs[index];
    const question = questions[index];
    const expected = packProductEvidence(
      question,
      result.ranked_queries,
      freeze.packing,
    );
    assert.deepEqual(result.response, expected.response);
    assert.deepEqual(result.selection_trace, expected.selection_trace);
    assert.equal(result.request_chars, expected.request_chars);
    assert.equal(result.response_chars, expected.response_chars);
    const selected = result.response.results.map((piece) => {
      const source = sourceById.get(piece.source_id);
      assert.ok(source);
      assert.equal(piece.path, source.relative_path);
      const trace = expected.selection_trace.find(
        (item) => item.id === piece.id,
      );
      assert.ok(trace);
      const candidate = result.ranked_queries.find(
        (item) => item.query_id === trace.query_id,
      ).results[trace.rank - 1];
      assert.equal(candidate.native_id, trace.native_id);
      const native = mappings.get(candidate.native_id);
      assert.ok(native);
      assert.equal(native.source_id, source.id);
      assert.equal(native.text, piece.text);
      return { ...piece, spans: native.spans };
    });
    const target = gold.get(question.id);
    assert.ok(target);
    const supported = (factId, pieces) =>
      facts
        .get(factId)
        .evidence.some((anchor) => covers(anchor, pieces, sourceByPath));
    const covered = target.required_facts.filter((factId) =>
      supported(factId, selected),
    );
    const rank =
      selected.findIndex((piece) =>
        target.required_facts.some((factId) => supported(factId, [piece])),
      ) + 1;
    scored.push({
      id: result.id,
      no_answer: target.no_answer,
      complete: covered.length === target.required_facts.length,
      covered: covered.length,
      expected: target.required_facts.length,
      hit: rank > 0,
      rr: rank > 0 ? 1 / rank : 0,
      returned: selected.length,
      request_response_chars: result.request_chars + result.response_chars,
    });
  }
  const answerable = scored.filter((item) => !item.no_answer);
  const oldAnswerable = oldScores.filter((item) => !item.no_answer);
  const aggregate = (items, old) => ({
    questions: items.length,
    answerable: items.filter((item) => !item.no_answer).length,
    complete_at_10: items.filter(
      (item) =>
        !item.no_answer && (old ? item.by_k[10].complete : item.complete),
    ).length,
    hit_at_10: items.filter(
      (item) => !item.no_answer && (old ? item.by_k[10].hit : item.hit),
    ).length,
    fact_coverage: items.reduce(
      (sum, item) => sum + (old ? item.by_k[10].covered : item.covered),
      0,
    ),
    fact_total: items.reduce(
      (sum, item) => sum + (old ? item.by_k[10].expected : item.expected),
      0,
    ),
    mrr_at_10: mean(
      items
        .filter((item) => !item.no_answer)
        .map((item) => (old ? item.by_k[10].rr : item.rr)),
    ),
    context_chars_mean: mean(items.map((item) => item.request_response_chars)),
    returned_mean: mean(items.map((item) => item.returned)),
  });
  assert.equal(answerable.length, oldAnswerable.length);
  lengths.sort((left, right) => left - right);
  summary.scopes[originalScope] = {
    questions: info.questions,
    corpus_documents: info.documents,
    parent_segments: parentSegments,
    parent_chars_median: lengths[Math.floor(lengths.length / 2)],
    candidate: aggregate(scored, false),
    original_dify: aggregate(oldScores, true),
  };
}
const output = path.join(pilotRoot, 'scores/dify-sep3-pilot-summary-v2.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(summary, null, 2) + '\n', {
  flag: 'wx',
});
console.log(JSON.stringify({ output, scopes: summary.scopes }));
