import assert from 'node:assert/strict';

export const supplementPolicy = Object.freeze({
  maxFiles: 3,
  backtrackLines: 5,
  maxLines: 80,
  budgetChars: 20000,
  qmdSafetyChars: 1024,
});

export function readStart(hitLine) {
  assert.ok(Number.isInteger(hitLine) && hitLine >= 1);
  return Math.max(1, hitLine - supplementPolicy.backtrackLines);
}

export function selectFirstFiles(results) {
  const seen = new Set();
  return results
    .filter((item) => {
      if (seen.has(item.source_id)) return false;
      seen.add(item.source_id);
      return true;
    })
    .slice(0, supplementPolicy.maxFiles);
}

export function fittedLineCount({
  lines,
  start,
  maxLines,
  used,
  requestFor,
  responseFor,
  safety = 0,
}) {
  for (
    let count = Math.min(maxLines, lines.length - start + 1);
    count > 0;
    count--
  ) {
    const text = lines.slice(start - 1, start - 1 + count).join('\n');
    const cost =
      JSON.stringify(requestFor(count)).length +
      JSON.stringify(responseFor(text)).length;
    if (used + cost + safety <= supplementPolicy.budgetChars) return count;
  }
  return 0;
}
