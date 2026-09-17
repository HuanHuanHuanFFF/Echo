// Offline postprocessor for the frozen three-strategy development comparison.
// Reads recorded results and frozen quote anchors; never calls retrieval or APIs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ks = [1, 3, 5, 10];
const strategies = [
  'heading-1000',
  'bagu-paragraph-800-lines',
  'markdown-structure-v1',
];
const scopes = [
  'A-development',
  'B-development',
  'C-development',
  'mixed-development',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceKey = (c, p) => JSON.stringify([c, p]);
const ratio = (n, d) => (d ? n / d : null);
const equalSet = (a, b) => assert.deepEqual([...a].sort(), [...b].sort());
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, 'Metric mismatch');

function score(question, facts, pieces) {
  for (const p of pieces) {
    assert.ok(Number.isInteger(p.start_line) && p.start_line >= 1);
    assert.ok(Number.isInteger(p.end_line) && p.end_line >= p.start_line);
    assert.equal(p.text.split('\n').length, p.end_line - p.start_line + 1);
  }
  if (question.no_answer) {
    assert.equal(question.required_facts.length, 0);
    return { noAnswer: true, nonempty: pieces.length > 0 };
  }
  assert.ok(question.required_facts.length > 0);
  assert.equal(
    new Set(question.required_facts).size,
    question.required_facts.length,
  );
  const labels = question.required_facts.map((id) => {
    const fact = facts.find((f) => f.id === id);
    assert.ok(fact && fact.evidence.length > 0, 'Missing fact label');
    for (const a of fact.evidence) {
      assert.ok(Number.isInteger(a.start_line) && a.start_line >= 1);
      assert.ok(Number.isInteger(a.end_line) && a.end_line >= a.start_line);
      assert.ok(a.quote.trim(), 'Empty anchor');
      assert.equal(a.quote.split('\n').length, a.end_line - a.start_line + 1);
    }
    return fact;
  });
  const relevantSources = new Set(
    labels.flatMap((f) =>
      f.evidence.map((a) => sourceKey(a.collection_id, a.path)),
    ),
  );
  // Require actual returned text, not merely the right file or claimed line range.
  const covered = (prefix) =>
    labels
      .filter((f) =>
        f.evidence.some((a) =>
          a.quote.split('\n').every(
            (line, offset) =>
              !line.trim() ||
              prefix.some((p) => {
                const sourceLine = a.start_line + offset;
                return (
                  p.collection_id === a.collection_id &&
                  p.relative_path === a.path &&
                  p.start_line <= sourceLine &&
                  p.end_line >= sourceLine &&
                  p.text.split('\n')[sourceLine - p.start_line] === line
                );
              }),
          ),
        ),
      )
      .map((f) => f.id);
  const prefixes = pieces.map((_, i) => covered(pieces.slice(0, i + 1)));
  const first = (predicate) => {
    const index = pieces.findIndex(predicate);
    return index < 0 ? null : index + 1;
  };
  const singleRank = first((p) => covered([p]).length > 0);
  const prefixRank = first((_, i) => prefixes[i].length > 0);
  const sourceRank = first((p) =>
    relevantSources.has(sourceKey(p.collection_id, p.relative_path)),
  );
  const reciprocal = (rank, k) => (rank !== null && rank <= k ? 1 / rank : 0);
  return {
    noAnswer: false,
    expectedFacts: labels.length,
    sourceQrels: relevantSources.size,
    resultCount: pieces.length,
    fullCovered: covered(pieces),
    fullPrefixRR: reciprocal(prefixRank, pieces.length),
    k: Object.fromEntries(
      ks.map((k) => {
        const found = prefixes[Math.min(k, pieces.length) - 1] ?? [];
        const foundSources = new Set(
          pieces
            .slice(0, k)
            .map((p) => sourceKey(p.collection_id, p.relative_path))
            .filter((s) => relevantSources.has(s)),
        );
        return [
          k,
          {
            singleChunkHit: singleRank !== null && singleRank <= k,
            singleChunkRR: reciprocal(singleRank, k),
            anyFactHit: found.length > 0,
            factCovered: found.length,
            factRecall: found.length / labels.length,
            complete: found.length === labels.length,
            prefixFirstFactRR: reciprocal(prefixRank, k),
            sourceHit: foundSources.size > 0,
            sourcesCovered: foundSources.size,
            sourceRecall: foundSources.size / relevantSources.size,
            sourceRR: reciprocal(sourceRank, k),
          },
        ];
      }),
    ),
  };
}
function summarize(rows) {
  const answerable = rows.filter((r) => !r.noAnswer);
  const noAnswer = rows.filter((r) => r.noAnswer);
  const sum = (fn) => answerable.reduce((n, r) => n + Number(fn(r)), 0);
  const n = answerable.length;
  const expectedFacts = sum((r) => r.expectedFacts);
  const sourceQrels = sum((r) => r.sourceQrels);
  const hit = (k, field) => {
    const count = sum((r) => r.k[k][field]);
    return { count, total: n, rate: ratio(count, n) };
  };
  return {
    questions: rows.length,
    answerable: n,
    noAnswer: {
      total: noAnswer.length,
      nonempty: noAnswer.filter((r) => r.nonempty).length,
    },
    expectedFacts,
    sourceQrels,
    answerableResultCounts: Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [
        i,
        answerable.filter((r) => r.resultCount === i).length,
      ]),
    ),
    k: Object.fromEntries(
      ks.map((k) => [
        k,
        {
          singleChunkHit: hit(k, 'singleChunkHit'),
          singleChunkMRR: ratio(
            sum((r) => r.k[k].singleChunkRR),
            n,
          ),
          anyFactHit: hit(k, 'anyFactHit'),
          factCovered: sum((r) => r.k[k].factCovered),
          factRecallMicro: ratio(
            sum((r) => r.k[k].factCovered),
            expectedFacts,
          ),
          factRecallMacro: ratio(
            sum((r) => r.k[k].factRecall),
            n,
          ),
          completeEvidence: hit(k, 'complete'),
          prefixFirstFactMRR: ratio(
            sum((r) => r.k[k].prefixFirstFactRR),
            n,
          ),
          sourceHit: hit(k, 'sourceHit'),
          sourceRecallMicro: ratio(
            sum((r) => r.k[k].sourcesCovered),
            sourceQrels,
          ),
          sourceRecallMacro: ratio(
            sum((r) => r.k[k].sourceRecall),
            n,
          ),
          sourceMRR: ratio(
            sum((r) => r.k[k].sourceRR),
            n,
          ),
        },
      ]),
    ),
  };
}
function selfTest() {
  const anchor = (file, start, quote) => ({
    collection_id: 'c',
    path: file,
    start_line: start,
    end_line: start + quote.split('\n').length - 1,
    quote,
  });
  const piece = (file, start, text) => ({
    collection_id: 'c',
    relative_path: file,
    start_line: start,
    end_line: start + text.split('\n').length - 1,
    text,
  });
  const q = { no_answer: false, required_facts: ['f'] };
  const facts = [
    {
      id: 'f',
      evidence: [anchor('a', 1, 'one\n\ntwo'), anchor('b', 1, 'alternate')],
    },
  ];
  const split = score(q, facts, [piece('a', 1, 'one'), piece('a', 3, 'two')]);
  assert.equal(split.k[1].factCovered, 0);
  assert.equal(split.k[3].factCovered, 1);
  assert.equal(split.k[3].singleChunkRR, 0);
  assert.equal(split.k[3].prefixFirstFactRR, 0.5);
  const alternate = score(q, facts, [piece('b', 1, 'alternate')]);
  assert.equal(alternate.k[10].factRecall, 1);
  assert.equal(alternate.k[10].sourceRecall, 0.5);
  const third = score(q, facts, [
    piece('z', 1, '?'),
    piece('z', 2, '?'),
    piece('b', 1, 'alternate'),
  ]);
  assert.equal(third.k[1].singleChunkHit, false);
  assert.equal(third.k[3].singleChunkRR, 1 / 3);
  const wrong = score(q, facts, [piece('b', 1, 'incorrect')]);
  assert.equal(wrong.k[10].singleChunkHit, false);
  assert.equal(wrong.k[10].sourceHit, true);
  const empty = score(q, facts, []);
  const no = score({ no_answer: true, required_facts: [] }, facts, [
    piece('b', 1, 'alternate'),
  ]);
  const aggregate = summarize([alternate, empty, no]);
  assert.equal(aggregate.answerable, 2);
  assert.equal(aggregate.noAnswer.nonempty, 1);
  assert.equal(aggregate.k[10].singleChunkMRR, 0.5);
  assert.equal(aggregate.k[10].factRecallMacro, 0.5);
  assert.throws(() =>
    score(q, [{ id: 'f', evidence: [anchor('a', 1, '  ')] }], []),
  );
  return [
    'multi-chunk-union-and-blank-lines',
    'or-alternatives-and-source-denominator',
    'rank-three-and-cutoff',
    'text-must-match',
    'short-and-empty-results',
    'no-answer-excluded',
    'invalid-empty-anchor',
  ];
}
async function main() {
  const syntheticChecks = selfTest();
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') {
    console.log(JSON.stringify({ passed: syntheticChecks }));
    return;
  }
  assert.equal(
    args.length,
    2,
    'Usage: node evals/summarize-chunk-comparison.mjs <run-root> <new-output.json>',
  );
  const [root, output] = args;
  const read = (file) => readFile(path.join(root, file));
  const json = async (file) => JSON.parse(await read(file));
  const deliveryFile = 'comparisons/delivery-manifest-r2.public.json';
  const delivery = await json(deliveryFile);
  const safeRead = async (file) => {
    const relative = path.relative(
      path.resolve(root),
      path.resolve(root, file),
    );
    assert.ok(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    );
    return read(file);
  };
  for (const item of delivery.artifact_hashes)
    assert.equal(
      hash(await safeRead(item.file)),
      item.sha256,
      'Frozen artifact changed: ' + item.file,
    );
  assert.equal(hash(await read('plan.json')), delivery.plan_sha256);
  const runs = [];
  const dataHashes = new Map();
  for (const scope of scopes)
    for (const [index, strategy] of strategies.entries()) {
      const run = scope + '-' + index;
      const base = 'queries/' + run + '/';
      const datasetBytes = await read(base + 'dataset.json');
      const dataset = JSON.parse(datasetBytes);
      const manifest = await json(base + 'manifest.json');
      const report = await json(base + 'report.json');
      assert.equal(hash(datasetBytes), manifest.dataset.sha256);
      if (dataHashes.has(scope))
        assert.equal(dataHashes.get(scope), hash(datasetBytes));
      else dataHashes.set(scope, hash(datasetBytes));
      const rows = (await read(base + 'rows.jsonl'))
        .toString('utf8')
        .trim()
        .split(/\r?\n/)
        .map(JSON.parse);
      assert.deepEqual(
        rows.map((r) => r.query_id),
        dataset.questions.map((q) => q.id),
      );
      const metrics = rows.map((r, i) => {
        assert.equal(
          r.status,
          'ok',
          'This postprocessor requires complete successful runs',
        );
        assert.ok(r.result.results.length <= 10);
        equalSet(r.expected_facts, dataset.questions[i].required_facts);
        const result = score(
          dataset.questions[i],
          dataset.facts,
          r.result.results,
        );
        if (!result.noAnswer) {
          equalSet(result.fullCovered, r.covered_facts);
          near(result.fullPrefixRR, r.first_fact_reciprocal_rank);
        }
        return result;
      });
      const summary = summarize(metrics);
      assert.equal(summary.questions, report.summary.queries);
      assert.equal(
        summary.k[10].factCovered,
        report.summary.fact_coverage.covered,
      );
      assert.equal(
        summary.expectedFacts,
        report.summary.fact_coverage.expected,
      );
      assert.equal(
        summary.k[10].completeEvidence.count,
        report.summary.complete_evidence.covered,
      );
      assert.equal(
        summary.answerable,
        report.summary.complete_evidence.expected,
      );
      assert.deepEqual(summary.noAnswer, {
        total: report.summary.no_answer.queries,
        nonempty: report.summary.no_answer.nonempty,
      });
      near(
        summary.k[10].prefixFirstFactMRR,
        report.summary.mean_first_fact_reciprocal_rank,
      );
      runs.push({ scope, strategy, metrics, summary });
    }
  const result = {
    version: 1,
    run: path.basename(root),
    kValues: ks,
    definitions: {
      order:
        'First K chunks of the actual delivered list; no reranking or new retrieval. Fixed subquestions share this final order and one parent denominator.',
      singleChunk:
        'Relevant iff one returned chunk alone fully supports at least one required fact via a frozen OR anchor. Hit and MRR use this derived strict binary label, not exhaustive human chunk qrels.',
      factRecall:
        'Nonblank anchor lines must match returned text; chunks may jointly cover an anchor. Micro = all covered fact demands / all required fact demands; macro = mean per-question ratio.',
      prefixFirstFactMRR:
        'Reciprocal rank of first prefix completing any fact; custom metric, may differ from single-chunk MRR.',
      source:
        'Known-source proxy: union of all annotated alternative sources. Deduplicate sources only within first K chunks. Not exhaustive document relevance or proof of evidence coverage.',
      noAnswer:
        'Excluded from answerable metric denominators; counted separately.',
    },
    provenance: {
      deliveryManifestSha256: hash(await read(deliveryFile)),
      scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
      planSha256: delivery.plan_sha256,
      verifiedArtifacts: delivery.artifact_hashes.length,
      verifiedDatasetCopies: runs.length,
      verifiedReferenceReports: runs.length,
      verifiedRows: runs.reduce((n, r) => n + r.metrics.length, 0),
      datasetHashes: Object.fromEntries(dataHashes),
      syntheticChecks,
      networkCalls: 0,
    },
    byStrategy: Object.fromEntries(
      strategies.map((strategy) => [
        strategy,
        summarize(
          runs.filter((r) => r.strategy === strategy).flatMap((r) => r.metrics),
        ),
      ]),
    ),
    byScope: Object.fromEntries(
      scopes.map((scope) => [
        scope,
        Object.fromEntries(
          runs
            .filter((r) => r.scope === scope)
            .map((r) => [r.strategy, r.summary]),
        ),
      ]),
    ),
  };
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(JSON.stringify({ output, provenance: result.provenance }));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
