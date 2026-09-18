import { score, summarize, selfTest } from './lib/evidence-metrics.mjs';
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
const equalSet = (a, b) => assert.deepEqual([...a].sort(), [...b].sort());
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, 'Metric mismatch');

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
      metricsSha256: hash(
        await readFile(new URL('./lib/evidence-metrics.mjs', import.meta.url)),
      ),
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
