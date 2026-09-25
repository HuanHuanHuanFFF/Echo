import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sourceLineSpans, spansCover } from './lib/product-evidence.mjs';
import {
  mapQmdSnippet,
  packQmdParentEvidence,
} from './lib/qmd-parent-evidence.mjs';

const [comparisonArg, qmdArg, modeArg] = process.argv.slice(2);
assert.ok(
  comparisonArg && qmdArg,
  'Usage: node evals/score-qmd-mcp-private.mjs COMPARISON_ROOT QMD_ROOT [rrf|rerank]',
);
const comparisonRoot = path.resolve(comparisonArg);
const qmdRoot = path.resolve(qmdArg);
const scopes = ['A-test', 'B-test', 'C-test', 'D-test', 'mixed-test'];
assert.ok(!modeArg || ['rrf', 'rerank'].includes(modeArg));
const modes = modeArg ? [modeArg] : ['rrf', 'rerank'];
const sha = (value) => createHash('sha256').update(value).digest('hex');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const readRows = async (file) =>
  (await fs.readFile(file, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
const preparation = await readJson(
  path.join(qmdRoot, 'private-preparation.json'),
);
const corpusManifestFile = path.join(comparisonRoot, 'corpus-v1/manifest.json');
const corpusManifestBytes = await fs.readFile(corpusManifestFile);
assert.equal(sha(corpusManifestBytes), preparation.corpus_manifest_sha256);
const manifest = JSON.parse(corpusManifestBytes.toString('utf8'));
const sourceKey = (collection, relative) =>
  JSON.stringify([collection, relative]);
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[
        Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
      ]
    : null;
};

function scoreFact(fact, selected, sourceByPath, requireText) {
  return fact.evidence.some((anchor) => {
    const source = sourceByPath.get(
      sourceKey(anchor.collection_id, anchor.path),
    );
    assert.ok(source, 'Gold anchor source absent from frozen corpus');
    const candidates = selected.filter(
      (piece) => piece.source_id === source.id,
    );
    if (!requireText) return candidates.length > 0;
    const spans = candidates.flatMap((piece) => piece.spans);
    return sourceLineSpans(source, anchor.start_line, anchor.end_line).every(
      ([start, end]) => spansCover(spans, start, end),
    );
  });
}

function scoreQuestion(question, labels, selected, sourceByPath, requireText) {
  const factById = new Map(labels.facts.map((fact) => [fact.id, fact]));
  const required = question.required_facts.map((id) => {
    const fact = factById.get(id);
    assert.ok(fact, 'Required fact absent from label set');
    return fact;
  });
  const covered = required.filter((fact) =>
    scoreFact(fact, selected, sourceByPath, requireText),
  );
  const firstRank =
    selected.findIndex((piece) =>
      required.some((fact) =>
        scoreFact(fact, [piece], sourceByPath, requireText),
      ),
    ) + 1;
  return {
    complete: covered.length === required.length,
    covered: covered.length,
    expected: required.length,
    hit: firstRank > 0,
    rr: firstRank ? 1 / firstRank : 0,
  };
}

const summary = {
  schema: 'echo-qmd-mcp-private-score-v1',
  corpus_manifest_sha256: preparation.corpus_manifest_sha256,
  context:
    'One native QMD MCP query per parent, 300-character snippets before get; same frozen private questions and 20k common packing',
  modes: {},
};
for (const mode of modes) {
  const aggregate = {
    questions: 0,
    answerable: 0,
    no_answer: 0,
    facts: 0,
    evidence_complete: 0,
    evidence_facts: 0,
    evidence_hit: 0,
    evidence_rr_sum: 0,
    file_complete: 0,
    file_facts: 0,
    file_hit: 0,
    file_rr_sum: 0,
    no_answer_nonempty: 0,
    native_calls: 0,
    native_errors: 0,
    candidate_unmapped: 0,
    selected_unmapped: 0,
    total_context_chars: 0,
    total_results: 0,
    latencies_ms: [],
    scopes: {},
  };
  for (const scope of scopes) {
    const info = manifest.scopes[scope];
    const prepared = preparation.scopes.find((row) => row.scope === scope);
    const corpusBytes = await fs.readFile(info.corpus.path);
    const queryBytes = await fs.readFile(info.queries.path);
    const labelBytes = await fs.readFile(info.labels.path);
    assert.equal(sha(corpusBytes), prepared.corpus_sha256);
    assert.equal(sha(queryBytes), prepared.queries_sha256);
    assert.equal(sha(labelBytes), prepared.labels_sha256);
    const sources = await readRows(info.corpus.path);
    const questions = await readRows(info.queries.path);
    const labels = JSON.parse(labelBytes.toString('utf8'));
    const labelById = new Map(labels.questions.map((row) => [row.id, row]));
    const sourceById = new Map(sources.map((row) => [row.id, row]));
    const sourceByPath = new Map(
      sources.map((row) => [
        sourceKey(row.collection_id, row.relative_path),
        row,
      ]),
    );
    const sourceByQmdPath = new Map(
      prepared.files.map((row) => [row.qmd_relative_path, row.source_id]),
    );
    const runDir = path.join(qmdRoot, 'runs-mcp', mode);
    const runFile = path.join(runDir, `${scope}.jsonl`);
    const receipt = await readJson(path.join(runDir, `${scope}.receipt.json`));
    const freeze = await readJson(path.join(runDir, `${scope}.freeze.json`));
    const runBytes = await fs.readFile(runFile);
    const runs = await readRows(runFile);
    assert.equal(receipt.status, 'complete');
    assert.equal(receipt.result_sha256, sha(runBytes));
    assert.equal(receipt.questions, runs.length);
    assert.equal(
      receipt.native_errors,
      runs.filter((row) => row.native_error).length,
    );
    assert.deepEqual(
      receipt.latency_ms,
      runs.map((row) => row.latency_ms),
    );
    assert.deepEqual(receipt.corpus_sha256, prepared.corpus_sha256);
    assert.deepEqual(receipt.queries_sha256, prepared.queries_sha256);
    assert.deepEqual(receipt.labels_sha256, prepared.labels_sha256);
    assert.deepEqual(
      freeze,
      Object.fromEntries(
        Object.entries(receipt).filter(
          ([key]) =>
            ![
              'status',
              'server_version',
              'questions',
              'result_sha256',
              'native_calls',
              'native_errors',
              'latency_ms',
            ].includes(key),
        ),
      ),
    );
    assert.deepEqual(
      runs.map((row) => row.id),
      questions.map((row) => row.id),
    );
    const scopeScore = {
      questions: runs.length,
      answerable: 0,
      evidence_complete: 0,
      evidence_facts: 0,
      file_complete: 0,
      file_facts: 0,
      native_errors: 0,
      candidate_unmapped: 0,
    };
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const input = questions[i];
      const label = labelById.get(input.id);
      assert.ok(label);
      const packed = packQmdParentEvidence(
        input,
        run.candidates,
        freeze.packing,
      );
      assert.deepEqual(run.response, packed.response);
      assert.deepEqual(run.selection_trace, packed.selection_trace);
      assert.equal(run.request_chars, packed.request_chars);
      assert.equal(run.response_chars, packed.response_chars);
      assert.ok(
        run.request_chars + run.response_chars <=
          freeze.packing.max_context_chars,
      );
      const candidateById = new Map();
      assert.equal(run.native_results.length, run.candidates.length);
      for (let rank = 0; rank < run.candidates.length; rank++) {
        const candidate = run.candidates[rank];
        const native = run.native_results[rank];
        assert.equal(candidate.text, native.snippet);
        assert.equal(candidate.native_id, native.docid);
        assert.equal(candidate.native_score, native.score);
        const qmdPath = String(native.file).replace(/^qmd:\/\//, '');
        const prefix =
          'qmd-' +
          (scope === 'mixed-test' ? 'mixed' : scope[0].toLowerCase()) +
          '/';
        assert.ok(qmdPath.startsWith(prefix));
        assert.equal(
          candidate.source_id,
          sourceByQmdPath.get(
            qmdPath.slice(prefix.length).replaceAll('\\', '/'),
          ),
        );
        const source = sourceById.get(candidate.source_id);
        assert.ok(source);
        assert.equal(candidate.path, source.relative_path);
        const mapped = mapQmdSnippet(candidate.text, source);
        assert.equal(candidate.map_status, mapped.status);
        assert.deepEqual(candidate.spans, mapped.spans);
        const deNumbered = candidate.text
          .split('\n')
          .map((line) => line.replace(/^\d+: /, ''))
          .join('\n');
        for (const [start, end] of candidate.spans) {
          assert.ok(start >= 0 && end <= source.text.length && end > start);
          assert.ok(deNumbered.includes(source.text.slice(start, end)));
        }
        if (candidate.map_status !== 'mapped') {
          aggregate.candidate_unmapped++;
          scopeScore.candidate_unmapped++;
        }
        const previous = candidateById.get(candidate.id);
        if (previous) assert.deepEqual(previous.spans, candidate.spans);
        candidateById.set(candidate.id, candidate);
      }
      const selected = run.response.results.map((row) => {
        const candidate = candidateById.get(row.id);
        assert.ok(candidate);
        if (candidate.map_status !== 'mapped') aggregate.selected_unmapped++;
        return candidate;
      });
      aggregate.questions++;
      aggregate.native_calls++;
      aggregate.native_errors += Number(Boolean(run.native_error));
      scopeScore.native_errors += Number(Boolean(run.native_error));
      aggregate.latencies_ms.push(run.latency_ms);
      aggregate.total_context_chars += run.request_chars + run.response_chars;
      aggregate.total_results += selected.length;
      if (label.no_answer) {
        aggregate.no_answer++;
        if (selected.length) aggregate.no_answer_nonempty++;
        continue;
      }
      aggregate.answerable++;
      scopeScore.answerable++;
      const evidence = scoreQuestion(
        label,
        labels,
        selected,
        sourceByPath,
        true,
      );
      const files = scoreQuestion(label, labels, selected, sourceByPath, false);
      assert.equal(evidence.expected, files.expected);
      aggregate.facts += evidence.expected;
      aggregate.evidence_complete += Number(evidence.complete);
      aggregate.evidence_facts += evidence.covered;
      aggregate.evidence_hit += Number(evidence.hit);
      aggregate.evidence_rr_sum += evidence.rr;
      aggregate.file_complete += Number(files.complete);
      aggregate.file_facts += files.covered;
      aggregate.file_hit += Number(files.hit);
      aggregate.file_rr_sum += files.rr;
      scopeScore.evidence_complete += Number(evidence.complete);
      scopeScore.evidence_facts += evidence.covered;
      scopeScore.file_complete += Number(files.complete);
      scopeScore.file_facts += files.covered;
    }
    aggregate.scopes[scope] = scopeScore;
  }
  assert.equal(aggregate.questions, 200);
  assert.equal(aggregate.answerable, 196);
  assert.equal(aggregate.no_answer, 4);
  assert.equal(aggregate.facts, 403);
  summary.modes[mode] = {
    ...Object.fromEntries(
      Object.entries(aggregate).filter(([key]) => key !== 'latencies_ms'),
    ),
    evidence_mrr: aggregate.evidence_rr_sum / aggregate.answerable,
    file_mrr: aggregate.file_rr_sum / aggregate.answerable,
    mean_context_chars: aggregate.total_context_chars / aggregate.questions,
    mean_results: aggregate.total_results / aggregate.questions,
    latency_ms: {
      mean:
        aggregate.latencies_ms.reduce((a, b) => a + b, 0) /
        aggregate.latencies_ms.length,
      p50: percentile(aggregate.latencies_ms, 0.5),
      p95: percentile(aggregate.latencies_ms, 0.95),
      max: Math.max(...aggregate.latencies_ms),
    },
  };
}
const output = path.join(
  qmdRoot,
  'scores',
  modeArg
    ? 'mcp-private-summary.' + modeArg + '.json'
    : 'mcp-private-summary.json',
);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(summary, null, 2) + '\n');
for (const mode of modes) {
  const row = summary.modes[mode];
  console.log(
    `${mode}: evidence ${row.evidence_complete}/196; facts ${row.evidence_facts}/403; ` +
      `files ${row.file_complete}/196; errors ${row.native_errors}; mean chars ${row.mean_context_chars.toFixed(0)}`,
  );
}
console.log(`Saved ${output}`);
