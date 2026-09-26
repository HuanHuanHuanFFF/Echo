import assert from 'node:assert/strict';

export function mapQmdSnippet(numberedSnippet, source) {
  const plain = numberedSnippet
    .split('\n')
    .map((line) => line.replace(/^\d+: /, ''))
    .join('\n');
  const newline = plain.indexOf('\n');
  assert.ok(newline >= 0, 'QMD snippet has no location header');
  const startLine = Number(
    plain.slice(0, newline).match(/^@@ -(\d+),\d+ @@/)?.[1],
  );
  assert.ok(Number.isInteger(startLine) && startLine >= 1);
  const displayed = plain.slice(newline + 1);
  const content =
    displayed.endsWith('...') && !source.text.includes(displayed)
      ? displayed.slice(0, -3)
      : displayed;
  const positions = [];
  let next = 0;
  while (content && (next = source.text.indexOf(content, next)) >= 0) {
    positions.push(next);
    next++;
  }
  const lineMatches = positions.filter(
    (position) =>
      source.text.slice(0, position).split('\n').length === startLine,
  );
  const position =
    lineMatches.length === 1
      ? lineMatches[0]
      : positions.length === 1
        ? positions[0]
        : null;
  return position === null
    ? { status: positions.length ? 'ambiguous' : 'unmapped', spans: [] }
    : { status: 'mapped', spans: [[position, position + content.length]] };
}

export function packQmdParentEvidence(question, candidates, limits) {
  const { topk, source_cap: sourceCap, max_context_chars: budget } = limits;
  const request = {
    queries: question.queries,
    ...(question.source_id ? { source_id: question.source_id } : {}),
  };
  const response = { results: [] };
  const selected = new Set();
  const perSource = new Map();
  const excluded = { duplicate: 0, topk: 0, source_cap: 0, budget: 0 };
  const selectionTrace = [];
  const requestChars = JSON.stringify(request).length;
  assert.ok(requestChars + JSON.stringify(response).length <= budget);
  for (let rank = 0; rank < candidates.length; rank++) {
    const item = candidates[rank];
    if (selected.has(item.id)) {
      excluded.duplicate++;
      continue;
    }
    if (response.results.length >= topk) {
      excluded.topk++;
      continue;
    }
    if ((perSource.get(item.source_id) ?? 0) >= sourceCap) {
      excluded.source_cap++;
      continue;
    }
    response.results.push({
      id: item.id,
      source_id: item.source_id,
      path: item.path,
      text: item.text,
    });
    if (requestChars + JSON.stringify(response).length > budget) {
      response.results.pop();
      excluded.budget++;
      continue;
    }
    selected.add(item.id);
    perSource.set(item.source_id, (perSource.get(item.source_id) ?? 0) + 1);
    selectionTrace.push({
      id: item.id,
      rank: rank + 1,
      native_id: item.native_id,
    });
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
