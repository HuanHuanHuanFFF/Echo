import assert from 'node:assert/strict';

export function mapReturnedText(text, source) {
  assert.equal(typeof text, 'string');
  const trimmed = text.trim();
  if (!trimmed) return { status: 'empty', spans: [] };
  // Native parsers can repeat heading ancestry before a section. Only omit
  // such a prefix from location matching; never discard arbitrary sentences.
  const cuts = [0];
  let consumed = 0;
  for (const line of trimmed.split('\n')) {
    if (!/^\s*#{1,6}\s/.test(line)) break;
    consumed += line.length + 1;
    if (consumed < trimmed.length) cuts.push(consumed);
  }
  for (const cut of cuts) {
    const suffix = trimmed.slice(cut).trim();
    if (!suffix) continue;
    const start = source.text.indexOf(suffix);
    if (start < 0) continue;
    const next = source.text.indexOf(suffix, start + 1);
    if (next >= 0) return { status: 'ambiguous', spans: [] };
    const spans = [[start, start + suffix.length]];
    if (cut) {
      const ancestry = new Map();
      let offset = 0;
      let fence;
      for (const line of source.text.slice(0, start).split('\n')) {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (marker) {
          if (!fence) fence = marker[1];
          else if (
            marker[1][0] === fence[0] &&
            marker[1].length >= fence.length
          )
            fence = undefined;
        } else if (!fence) {
          const heading = line.match(/^ {0,3}(#{1,6})\s/);
          if (heading) {
            const level = heading[1].length;
            for (const existing of ancestry.keys())
              if (existing >= level) ancestry.delete(existing);
            ancestry.set(level, {
              text: line.trim(),
              span: [offset, offset + line.length],
            });
          }
        }
        offset += line.length + 1;
      }
      for (const prefix of trimmed.slice(0, cut).trim().split('\n')) {
        const item = [...ancestry.values()].find(
          (heading) => heading.text === prefix.trim(),
        );
        if (!item) return { status: 'unmapped-heading', spans: [] };
        spans.push(item.span);
      }
    }
    return { status: 'mapped', spans: spans.sort((a, b) => a[0] - b[0]) };
  }
  return { status: 'unmapped', spans: [] };
}

export function spansCover(spans, start, end) {
  let cursor = start;
  for (const [left, right] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (right <= cursor) continue;
    if (left > cursor) return false;
    cursor = Math.max(cursor, right);
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

export function sourceLineSpans(source, firstLine, lastLine) {
  assert.ok(firstLine >= source.original_first_line && lastLine >= firstLine);
  const lines = source.text.split('\n');
  assert.ok(lastLine - source.original_first_line < lines.length);
  const spans = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const number = source.original_first_line + index;
    if (number >= firstLine && number <= lastLine && line.trim()) {
      const left = line.length - line.trimStart().length;
      const right = line.trimEnd().length;
      spans.push([offset + left, offset + right]);
    }
    offset += line.length + 1;
  }
  return spans;
}

export function packProductEvidence(question, rankedQueries, limits = {}) {
  assert.deepEqual(
    rankedQueries.map((row) => row.query_id),
    question.queries.map((row) => row.id),
    'Subquery rankings must match frozen query order',
  );
  const topk = limits.topk ?? 10;
  const sourceCap = limits.source_cap ?? 6;
  const budget = limits.max_context_chars ?? 20000;
  const request = {
    queries: question.queries,
    ...(question.source_id ? { source_id: question.source_id } : {}),
  };
  const response = { results: [] };
  const selectionTrace = [];
  const selected = new Set();
  const sourceCounts = new Map();
  const excluded = { duplicate: 0, topk: 0, source_cap: 0, budget: 0 };
  const requestChars = JSON.stringify(request).length;
  assert.ok(requestChars + JSON.stringify(response).length <= budget);
  const matches = new Map();
  for (const row of rankedQueries)
    for (const candidate of row.results) {
      const ids = matches.get(candidate.id) ?? new Set();
      ids.add(row.query_id);
      matches.set(candidate.id, ids);
    }
  for (
    let rank = 0;
    rank < Math.max(0, ...rankedQueries.map((row) => row.results.length));
    rank++
  ) {
    for (const row of rankedQueries) {
      const item = row.results[rank];
      if (!item) continue;
      if (selected.has(item.id)) {
        excluded.duplicate++;
        continue;
      }
      if (response.results.length >= topk) {
        excluded.topk++;
        continue;
      }
      if ((sourceCounts.get(item.source_id) ?? 0) >= sourceCap) {
        excluded.source_cap++;
        continue;
      }
      const result = {
        id: item.id,
        source_id: item.source_id,
        path: item.path,
        text: item.text,
        matched_query_ids: [...matches.get(item.id)],
      };
      response.results.push(result);
      if (requestChars + JSON.stringify(response).length > budget) {
        response.results.pop();
        excluded.budget++;
        continue;
      }
      selectionTrace.push({
        id: item.id,
        query_id: row.query_id,
        rank: rank + 1,
        native_id: item.native_id,
      });
      selected.add(item.id);
      sourceCounts.set(
        item.source_id,
        (sourceCounts.get(item.source_id) ?? 0) + 1,
      );
    }
  }
  return {
    request,
    response,
    selection_trace: selectionTrace,
    request_chars: requestChars,
    response_chars: JSON.stringify(response).length,
    excluded,
  };
}
