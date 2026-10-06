// Positions are 1-based UTF-16 columns; the end position is exclusive.
export interface PreviewRange {
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

export function previewRange(startLine: number, text: string): PreviewRange {
  let line = startLine;
  let offset = 0;
  let next = text.indexOf('\n');
  while (next !== -1) {
    line++;
    offset = next + 1;
    next = text.indexOf('\n', offset);
  }
  return {
    start_line: startLine,
    start_column: 1,
    end_line: line,
    end_column: text.length - offset + 1,
  };
}

function jsonCharCost(char: string): number {
  if (char.length === 2) return 2;
  const code = char.charCodeAt(0);
  if (code === 34 || code === 92) return 2;
  if (code < 32) return [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
  if (code >= 0xd800 && code <= 0xdfff) return 6;
  return 1;
}

// Count escaped JSON string contents without building a potentially huge string.
// A value greater than limit means it cannot fit; exact over-limit cost is unnecessary.
export function escapedTextCost(text: string, limit: number): number {
  let cost = 0;
  for (const char of text) {
    cost += jsonCharCost(char);
    if (cost > limit) return limit + 1;
  }
  return cost;
}

// Divide escaped JSON text space equally, reclaiming unused short-text shares.
export function textBudgets(costs: number[], budget: number): number[] {
  const allocations = costs.map(() => 0);
  let active = costs.map((_, i) => i);
  let remaining = budget;
  while (active.length) {
    const share = Math.floor(remaining / active.length);
    const short = active.filter((i) => costs[i]! <= share);
    if (short.length) {
      for (const i of short) {
        allocations[i] = costs[i]!;
        remaining -= costs[i]!;
      }
      const finished = new Set(short);
      active = active.filter((i) => !finished.has(i));
    } else {
      for (const i of active) {
        allocations[i] =
          share + (remaining % active.length > active.indexOf(i) ? 1 : 0);
      }
      break;
    }
  }
  return allocations;
}

// Iterate whole Unicode code points so a UTF-16 budget cannot split a surrogate pair.
export function textPrefix(text: string, budget: number): string {
  let length = 0;
  for (const char of text) {
    const cost = jsonCharCost(char);
    if (cost > budget) break;
    budget -= cost;
    length += char.length;
  }
  return text.slice(0, length);
}
