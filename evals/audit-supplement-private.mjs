import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceLineSpans, spansCover } from './lib/product-evidence.mjs';
import {
  fittedLineCount,
  readStart,
  selectFirstFiles,
  supplementPolicy,
} from './lib/supplement-budget.mjs';

const comparisonRoot =
  'E:/幻/Documents/八股-Echo测试/2026-09-22-product-comparison';
const qmdRoot = 'E:/幻/Documents/八股-Echo测试/2026-09-25-qmd-comparison';
const experimentRoot = path.resolve('.echo/supplement-2026-09-26');
const scopes = ['A-test', 'B-test', 'C-test', 'D-test', 'mixed-test'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const readRows = async (file) =>
  (await fs.readFile(file, 'utf8')).trimEnd().split('\n').map(JSON.parse);
const fileHash = async (file) => sha(await fs.readFile(file));
const key = (collection, relative) => JSON.stringify([collection, relative]);
const summaryFile = path.join(experimentRoot, 'summary.json');
const summary = await readJson(summaryFile);
const verificationFile = path.join(experimentRoot, 'verification.json');
const verification = await readJson(verificationFile);
assert.equal(await fileHash(verificationFile), summary.verification_sha256);
assert.equal(
  await fileHash(new URL('./lib/supplement-budget.mjs', import.meta.url)),
  verification.policy_sha256,
);
assert.equal(
  await fileHash(new URL('./run-supplement-private.mjs', import.meta.url)),
  verification.script_sha256,
);
for (const [file, expected] of Object.entries(verification.input_sha256))
  assert.equal(await fileHash(file), expected, `Input changed: ${file}`);
const manifest = await readJson(
  path.join(comparisonRoot, 'corpus-v1/manifest.json'),
);
let checkedQuestions = 0;
let checkedReads = 0;
let checkedNativeGets = 0;
let checkedHostReads = 0;
let checkedErrors = 0;
let checkedBudgetExclusions = 0;
const rescored = {};

function score(gold, labels, pieces, byPath) {
  if (gold.no_answer)
    return {
      no_answer: true,
      complete: false,
      covered: 0,
      expected: 0,
      facts: [],
    };
  const facts = new Map(labels.facts.map((fact) => [fact.id, fact]));
  const covered = gold.required_facts.filter((id) =>
    facts.get(id).evidence.some((anchor) => {
      const source = byPath.get(key(anchor.collection_id, anchor.path));
      assert.ok(source);
      const spans = pieces
        .filter((piece) => piece.source_id === source.id)
        .flatMap((piece) => piece.spans);
      return sourceLineSpans(source, anchor.start_line, anchor.end_line).every(
        ([left, right]) => spansCover(spans, left, right),
      );
    }),
  );
  return {
    no_answer: false,
    complete: covered.length === gold.required_facts.length,
    covered: covered.length,
    expected: gold.required_facts.length,
    facts: covered,
  };
}

for (const mode of ['echo', 'rrf', 'rerank']) {
  const totals = {
    questions: 0,
    first_complete: 0,
    after_complete: 0,
    first_facts: 0,
    after_facts: 0,
  };
  for (const scope of scopes) {
    const info = manifest.scopes[scope];
    const sources = await readRows(info.corpus.path);
    const byId = new Map(sources.map((source) => [source.id, source]));
    const byPath = new Map(
      sources.map((source) => [
        key(source.collection_id, source.relative_path),
        source,
      ]),
    );
    const labels = await readJson(info.labels.path);
    const gold = new Map(
      labels.questions.map((question) => [question.id, question]),
    );
    const original = await readRows(
      path.join(
        mode === 'echo' ? comparisonRoot : qmdRoot,
        mode === 'echo' ? 'runs/echo' : `runs-mcp/${mode}`,
        `${scope}.jsonl`,
      ),
    );
    const rawFile = path.join(experimentRoot, `${mode}-${scope}.jsonl`);
    assert.equal(
      await fileHash(rawFile),
      summary.conditions[mode].raw_sha256[scope],
    );
    const rows = await readRows(rawFile);
    assert.equal(rows.length, original.length);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const first = original[index];
      assert.equal(row.id, first.id);
      assert.equal(row.mode, mode);
      assert.equal(row.scope, scope);
      const question = gold.get(row.id);
      assert.ok(question);
      assert.equal(row.no_answer, question.no_answer);
      assert.equal(row.native_error, first.native_error ?? null);
      if (row.native_error) checkedErrors++;
      const initialPieces = first.response.results.map((hit) => {
        const source = byId.get(hit.source_id);
        assert.ok(source);
        const candidate =
          mode === 'echo'
            ? first.ranked_queries
                .flatMap((ranked) => ranked.results)
                .find((piece) => piece.id === hit.id)
            : first.candidates.find((piece) => piece.id === hit.id);
        assert.ok(candidate);
        return {
          source_id: source.id,
          spans:
            mode === 'echo'
              ? sourceLineSpans(
                  source,
                  candidate.source_location.start_line,
                  candidate.source_location.end_line,
                )
              : candidate.spans,
        };
      });
      assert.deepEqual(
        row.first,
        score(question, labels, initialPieces, byPath),
      );
      let used = first.request_chars + first.response_chars;
      assert.equal(row.first_context_chars, used);
      const selected = selectFirstFiles(first.response.results);
      assert.equal(row.reads.length, selected.length);
      const afterPieces = [...initialPieces];
      for (let rank = 0; rank < selected.length; rank++) {
        const hit = selected[rank];
        const read = row.reads[rank];
        const source = byId.get(hit.source_id);
        assert.equal(read.source_id, source.id);
        assert.equal(read.path, source.relative_path);
        const candidate =
          mode === 'echo'
            ? first.ranked_queries
                .flatMap((ranked) => ranked.results)
                .find((piece) => piece.id === hit.id)
            : first.candidates.find((piece) => piece.id === hit.id);
        const native =
          mode === 'echo'
            ? null
            : first.native_results.find(
                (piece) => piece.docid === candidate.native_id,
              );
        const hitLine =
          mode === 'echo'
            ? candidate.source_location.start_line -
              source.original_first_line +
              1
            : native.line;
        const start = readStart(hitLine);
        assert.equal(read.hit_line, hitLine);
        const lines = source.text.split('\n');
        const file = mode === 'echo' ? read.request?.path : native.file;
        const requestFor = (maxLines) =>
          mode === 'echo'
            ? { path: file, fromLine: start, maxLines }
            : { file, fromLine: start, maxLines, lineNumbers: false };
        const responseFor = (text) => ({ path: source.relative_path, text });
        const count = fittedLineCount({
          lines,
          start,
          maxLines: supplementPolicy.maxLines,
          used,
          requestFor,
          responseFor,
          safety: mode === 'echo' ? 0 : supplementPolicy.qmdSafetyChars,
        });
        if (!count) {
          assert.equal(read.status, 'budget_excluded');
          assert.equal(read.used_before, used);
          checkedBudgetExclusions++;
          continue;
        }
        assert.equal(read.status, 'read');
        assert.equal(read.from_line, start);
        assert.equal(read.max_lines, count);
        assert.deepEqual(read.request, requestFor(count));
        assert.equal(read.used_before, used);
        const expected = lines.slice(start - 1, start - 1 + count).join('\n');
        if (mode === 'echo') {
          assert.equal(read.native_response.text, expected);
          assert.equal(read.native_response.host_read_path, read.request.path);
          checkedHostReads++;
        } else {
          const resource = read.native_response.content.filter(
            (part) => part.type === 'resource',
          );
          assert.equal(resource.length, 1);
          assert.equal(
            resource[0].resource.text,
            read.normalized_response.text,
          );
          assert.ok(resource[0].resource.text.endsWith(expected));
          checkedNativeGets++;
        }
        assert.deepEqual(
          read.normalized_response,
          responseFor(read.normalized_response.text),
        );
        assert.equal(read.request_chars, JSON.stringify(read.request).length);
        assert.equal(
          read.response_chars,
          JSON.stringify(read.normalized_response).length,
        );
        used += read.request_chars + read.response_chars;
        assert.equal(read.used_after, used);
        assert.ok(used <= 20000);
        const spans = sourceLineSpans(
          source,
          source.original_first_line + start - 1,
          source.original_first_line + start + count - 2,
        );
        assert.deepEqual(read.spans, spans);
        afterPieces.push({ source_id: source.id, spans });
        checkedReads++;
      }
      assert.equal(row.cumulative_context_chars, used);
      assert.equal(row.over_budget, false);
      assert.deepEqual(row.after, score(question, labels, afterPieces, byPath));
      assert.equal(row.retrieval_calls_added, 0);
      assert.equal(row.embedding_calls_added, 0);
      assert.equal(row.rerank_calls_added, 0);
      totals.questions++;
      totals.first_complete += Number(
        !question.no_answer && row.first.complete,
      );
      totals.after_complete += Number(
        !question.no_answer && row.after.complete,
      );
      totals.first_facts += row.first.covered;
      totals.after_facts += row.after.covered;
      checkedQuestions++;
    }
  }
  for (const field of Object.keys(totals))
    assert.equal(totals[field], summary.conditions[mode][field]);
  rescored[mode] = totals;
}
const audit = {
  status: 'independently-rescored',
  checked_questions: checkedQuestions,
  checked_reads: checkedReads,
  checked_native_gets: checkedNativeGets,
  checked_host_reads: checkedHostReads,
  checked_original_query_errors: checkedErrors,
  checked_budget_exclusions: checkedBudgetExclusions,
  scores: rescored,
  verification_sha256: await fileHash(verificationFile),
  summary_sha256: await fileHash(summaryFile),
  audit_script_sha256: await fileHash(fileURLToPath(import.meta.url)),
};
await fs.writeFile(
  path.join(experimentRoot, 'audit.json'),
  JSON.stringify(audit, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(JSON.stringify(audit));
