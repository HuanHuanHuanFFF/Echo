import assert from 'node:assert/strict';
import { verifyFinalModelProvenance } from './lib/product-model-provenance.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mapDifyPartition } from './lib/dify-evidence.mjs';
import { mapKhojCompiled } from './lib/khoj-evidence.mjs';
import { jsonLines } from './prepare-product-comparison.mjs';
import {
  mapReturnedText,
  sourceLineSpans,
  spansCover,
  packProductEvidence,
} from './lib/product-evidence.mjs';
import { verifyProductRuns } from './lib/product-run-integrity.mjs';

const [root, condition, publicRoot] = process.argv.slice(2);
assert.ok(
  root && condition && publicRoot,
  'Expected BATCH CONDITION PUBLIC_ROOT',
);
await verifyFinalModelProvenance(root);
const manifest = JSON.parse(
  await fs.readFile(path.join(root, 'corpus-v1/manifest.json'), 'utf8'),
);
const freeze = JSON.parse(
  await fs.readFile(path.join(root, 'freeze.json'), 'utf8'),
);
assert.equal(freeze.status, 'frozen');
const digest = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(
  digest(await fs.readFile(path.join(root, 'corpus-v1/manifest.json'))),
  freeze.corpus_manifest_sha256,
);
const sourceKey = (collection, relative) =>
  JSON.stringify([collection, relative]);
const rows = async (file) => {
  const result = [];
  for await (const row of jsonLines(file)) result.push(row);
  return result;
};
const checks = {
  questions: 0,
  selected_chunks: 0,
  mapped_chunks: 0,
  unmapped_chunks: 0,
  budget_recomputed: 0,
};
const allPrivate = [];
const allQasper = [];
const pendingOutputs = [];
const outputDir = path.join(root, 'scores', condition);
const runScopes = Object.entries(manifest.scopes)
  .filter(([, info]) => info.kind !== 'official-fixed-unit')
  .map(([scope]) => scope);
await verifyProductRuns({ root, condition, scopes: runScopes });
await fs.mkdir(outputDir, { recursive: true });

function covers(anchor, selected, sourceByPath) {
  const source = sourceByPath.get(sourceKey(anchor.collection_id, anchor.path));
  assert.ok(source, 'Gold anchor source missing from complete corpus');
  const available = selected
    .filter((piece) => piece.source_id === source.id)
    .flatMap((piece) => piece.spans);
  return sourceLineSpans(source, anchor.start_line, anchor.end_line).every(
    ([a, b]) => spansCover(available, a, b),
  );
}

function privateScores(question, labels, selected, sourceByPath) {
  const facts = new Map(labels.facts.map((fact) => [fact.id, fact]));
  const supported = (factId, pieces) =>
    facts
      .get(factId)
      .evidence.some((anchor) => covers(anchor, pieces, sourceByPath));
  const byK = {};
  for (const k of [1, 3, 5, 10]) {
    const pieces = selected.slice(0, k);
    const covered = question.required_facts.filter((id) =>
      supported(id, pieces),
    );
    const rank =
      pieces.findIndex((piece) =>
        question.required_facts.some((id) => supported(id, [piece])),
      ) + 1;
    byK[k] = {
      covered: covered.length,
      expected: question.required_facts.length,
      complete: covered.length === question.required_facts.length,
      hit: rank > 0,
      rr: rank > 0 ? 1 / rank : 0,
      facts: covered,
    };
  }
  return { no_answer: question.no_answer, by_k: byK };
}

function qasperScores(question, document, source, selected) {
  assert.ok(
    selected.every((piece) => piece.source_id === source.id),
    'Known-paper filter violated',
  );
  const spans = selected.flatMap((piece) => piece.spans);
  const paragraphs = document.paragraphs.filter((paragraph) =>
    sourceLineSpans(source, paragraph.start_line, paragraph.end_line).every(
      ([a, b]) => spansCover(spans, a, b),
    ),
  );
  const ids = new Set(paragraphs.map((paragraph) => paragraph.id));
  const valid = question.annotations
    .filter((annotation) => annotation.valid)
    .map((annotation) => {
      const covered = annotation.evidence.filter((item) =>
        item.paragraph_ids.some((id) => ids.has(id)),
      ).length;
      return {
        id: annotation.id,
        complete: covered === annotation.evidence.length,
        coverage: annotation.evidence.length
          ? covered / annotation.evidence.length
          : 0,
      };
    });
  return {
    paper_id: question.paper_id,
    eligible: question.eligible,
    category: question.category,
    strict_complete: valid.some((item) => item.complete),
    strict_coverage: valid.length
      ? Math.max(...valid.map((item) => item.coverage))
      : null,
    selected_paragraphs: paragraphs.map((paragraph) => paragraph.id),
    predicted_evidence: paragraphs.map((paragraph) => paragraph.text),
  };
}

for (const [scope, info] of Object.entries(manifest.scopes)) {
  if (info.kind === 'official-fixed-unit') continue;
  for (const input of [
    info.corpus,
    info.queries,
    info.labels,
    ...(scope === 'qasper' ? [info.source_docs] : []),
  ])
    assert.equal(digest(await fs.readFile(input.path)), input.sha256);
  const documents = await rows(info.corpus.path);
  const sources = new Map(documents.map((row) => [row.id, row]));
  const sourceByPath = new Map(
    documents.map((row) => [
      sourceKey(row.collection_id, row.relative_path),
      row,
    ]),
  );
  const questions = await rows(info.queries.path);
  const results = await rows(
    path.join(root, 'runs', condition, `${scope}.jsonl`),
  );
  assert.deepEqual(
    results.map((row) => row.id),
    questions.map((row) => row.id),
    'Missing, reordered, or duplicate result ID',
  );
  const labels =
    scope === 'qasper'
      ? null
      : JSON.parse(await fs.readFile(info.labels.path, 'utf8'));
  const gold = new Map(
    (scope === 'qasper' ? await rows(info.labels.path) : labels.questions).map(
      (row) => [row.id, row],
    ),
  );
  const qasperDocs =
    scope === 'qasper'
      ? new Map(
          (await rows(info.source_docs.path)).map((row) => [
            row.source_id,
            row,
          ]),
        )
      : null;
  const difyMappings = new Map();
  if (condition === 'dify') {
    const indexReceipt = JSON.parse(
      await fs.readFile(
        path.join(root, 'indexes/dify', scope, 'query-index-receipt.json'),
        'utf8',
      ),
    );
    assert.equal(indexReceipt.status, 'frozen');
    assert.equal(indexReceipt.corpus_sha256, info.corpus.sha256);
    const pins = new Map(
      indexReceipt.execution_files.map((entry) => [
        path.resolve(root, entry.path),
        entry.sha256,
      ]),
    );
    for (const source of documents) {
      const file = path.join(
        root,
        'indexes/dify',
        scope,
        source.id + '.segments.json',
      );
      const bytes = await fs.readFile(file);
      assert.equal(
        digest(bytes),
        pins.get(path.resolve(file)),
        'Dify segment receipt changed or unbound',
      );
      const native = JSON.parse(bytes);
      assert.equal(native.source_id, source.id);
      assert.equal(native.source_text_sha256, source.text_sha256);
      const mapping = mapDifyPartition(native.segments, source);
      const byId = new Map(
        mapping.mappings.map((item) => [item.id, item.mapping]),
      );
      for (const segment of native.segments)
        difyMappings.set(segment.id, {
          source_id: source.id,
          text: segment.content,
          mapping: byId.get(segment.id),
        });
    }
  }
  const scored = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const question = questions[index];
    const recomputed = packProductEvidence(
      question,
      result.ranked_queries,
      freeze.packing,
    );
    assert.deepEqual(
      result.response,
      recomputed.response,
      'Returned evidence differs from frozen common packing',
    );
    assert.deepEqual(result.selection_trace, recomputed.selection_trace);
    assert.equal(result.request_chars, recomputed.request_chars);
    assert.equal(result.response_chars, recomputed.response_chars);
    assert.ok(
      result.request_chars + result.response_chars <=
        freeze.packing.max_context_chars,
    );
    checks.budget_recomputed++;
    const selected = result.response.results.map((piece) => {
      const source = sources.get(piece.source_id);
      assert.ok(source);
      assert.equal(
        piece.id,
        digest(JSON.stringify([source.id, piece.text])).slice(0, 32),
      );
      assert.equal(piece.path, source.relative_path);
      const trace = recomputed.selection_trace.find(
        (item) => item.id === piece.id,
      );
      assert.ok(trace);
      const candidate = result.ranked_queries.find(
        (row) => row.query_id === trace.query_id,
      ).results[trace.rank - 1];
      assert.equal(candidate.native_id, trace.native_id);
      let mapped;
      if (condition.startsWith('khoj-')) {
        mapped = mapKhojCompiled(piece.text, source, candidate.native_metadata);
      } else if (condition === 'dify') {
        const native = difyMappings.get(candidate.native_id);
        assert.ok(native, 'Dify returned unknown native segment');
        assert.equal(native.source_id, source.id);
        assert.equal(
          native.text,
          piece.text,
          'Dify returned text differs from frozen segment',
        );
        mapped = native.mapping;
      } else if (condition === 'echo') {
        const { start_line, end_line } = candidate.source_location;
        assert.equal(
          source.text
            .split('\n')
            .slice(
              start_line - source.original_first_line,
              end_line - source.original_first_line + 1,
            )
            .join('\n'),
          piece.text,
        );
        mapped = {
          status: 'mapped',
          spans: sourceLineSpans(source, start_line, end_line),
        };
      } else {
        mapped = mapReturnedText(piece.text, source);
      }
      checks.selected_chunks++;
      if (mapped.status === 'mapped') checks.mapped_chunks++;
      else checks.unmapped_chunks++;
      return { ...piece, mapping_status: mapped.status, spans: mapped.spans };
    });
    const mappingFailures = selected
      .filter((piece) => piece.mapping_status !== 'mapped')
      .map((piece) => ({
        id: piece.id,
        source_id: piece.source_id,
        status: piece.mapping_status,
      }));
    const common = {
      id: result.id,
      scope,
      mapping_failures: mappingFailures,
      request_response_chars: result.request_chars + result.response_chars,
      returned: selected.length,
      elapsed_ms: result.elapsed_ms,
      excluded: result.excluded,
    };
    const value =
      scope === 'qasper'
        ? {
            ...common,
            ...qasperScores(
              gold.get(result.id),
              qasperDocs.get(question.source_id),
              sources.get(question.source_id),
              selected,
            ),
          }
        : {
            ...common,
            ...privateScores(
              gold.get(result.id),
              labels,
              selected,
              sourceByPath,
            ),
          };
    scored.push(value);
    (scope === 'qasper' ? allQasper : allPrivate).push(value);
    checks.questions++;
  }
  pendingOutputs.push([
    path.join(outputDir, `${scope}.jsonl`),
    scored.map((row) => JSON.stringify(row)).join('\n') + '\n',
  ]);
}

assert.equal(allPrivate.length, 200);
assert.equal(allQasper.length, 1005);
const answerable = allPrivate.filter((row) => !row.no_answer);
assert.equal(answerable.length, 196);
const eligible = allQasper.filter((row) => row.eligible);
assert.equal(eligible.length, 800);
const mean = (list, select) =>
  list.reduce((sum, row) => sum + select(row), 0) / list.length;
const summary = {
  status: checks.unmapped_chunks
    ? 'mapping-gaps-require-review'
    : 'strict-evidence-scored-awaiting-official-public-score',
  condition,
  checks,
  private: {
    questions: 200,
    answerable: 196,
    by_k: Object.fromEntries(
      [1, 3, 5, 10].map((k) => [
        k,
        {
          complete: answerable.filter((row) => row.by_k[k].complete).length,
          facts: answerable.reduce((sum, row) => sum + row.by_k[k].covered, 0),
          expected_facts: answerable.reduce(
            (sum, row) => sum + row.by_k[k].expected,
            0,
          ),
          hit: answerable.filter((row) => row.by_k[k].hit).length,
          mrr: mean(answerable, (row) => row.by_k[k].rr),
        },
      ]),
    ),
    no_answer_nonempty: allPrivate.filter(
      (row) => row.no_answer && row.returned > 0,
    ).length,
    mean_context_chars: mean(allPrivate, (row) => row.request_response_chars),
  },
  qasper: {
    questions: 1005,
    strict_eligible: 800,
    complete: eligible.filter((row) => row.strict_complete).length,
    strict_coverage: mean(eligible, (row) => row.strict_coverage),
    mean_context_chars: mean(allQasper, (row) => row.request_response_chars),
  },
};
pendingOutputs.push([
  path.join(outputDir, 'evidence-summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
]);
// Validate every input and denominator before publishing any score output.
for (const [file] of pendingOutputs) {
  await fs.access(file).then(
    () => {
      throw new Error('Score output already exists: ' + file);
    },
    (error) => {
      if (error.code !== 'ENOENT') throw error;
    },
  );
}
for (const [file, contents] of pendingOutputs)
  await fs.writeFile(file, contents, { flag: 'wx' });
console.log(
  JSON.stringify({
    status: summary.status,
    condition,
    questions: checks.questions,
    mapping_gaps: checks.unmapped_chunks,
  }),
);
