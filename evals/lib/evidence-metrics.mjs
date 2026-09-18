import assert from 'node:assert/strict';
const ks = [1, 3, 5, 10];
const sourceKey = (c, p) => JSON.stringify([c, p]);
const ratio = (n, d) => (d ? n / d : null);

export function score(question, facts, pieces) {
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
export function summarize(rows) {
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
export function selfTest() {
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
