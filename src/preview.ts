// Positions are 1-based UTF-16 columns; the end position is exclusive.
export interface PreviewRange {
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

export function previewRange(startLine: number, text: string): PreviewRange {
  const lines = text.split('\n');
  return {
    start_line: startLine,
    start_column: 1,
    end_line: startLine + lines.length - 1,
    end_column: lines.at(-1)!.length + 1,
  };
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
    const cost = JSON.stringify(char).length - 2;
    if (cost > budget) break;
    budget -= cost;
    length += char.length;
  }
  return text.slice(0, length);
}
