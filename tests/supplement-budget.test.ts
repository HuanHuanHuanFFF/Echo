import { describe, expect, it } from 'vitest';
import {
  fittedLineCount,
  readStart,
  selectFirstFiles,
} from '../evals/lib/supplement-budget.mjs';

describe('supplement reading boundary', () => {
  it('uses first-hit order with unique files and fixed backtrack', () => {
    expect(
      selectFirstFiles([
        { source_id: 'a' },
        { source_id: 'a' },
        { source_id: 'b' },
        { source_id: 'c' },
        { source_id: 'd' },
      ]),
    ).toHaveLength(3);
    expect(readStart(3)).toBe(1);
    expect(readStart(20)).toBe(15);
  });

  it('accounts for the whole returned body before issuing a read', () => {
    const lines = ['x'.repeat(20), 'y'.repeat(20)];
    const requestFor = (maxLines: number) => ({ file: 'a', maxLines });
    const responseFor = (text: string) => ({ path: 'a', text });
    const two =
      JSON.stringify(requestFor(2)).length +
      JSON.stringify(responseFor(lines.join('\n'))).length;
    expect(
      fittedLineCount({
        lines,
        start: 1,
        maxLines: 2,
        used: 20000 - two,
        requestFor,
        responseFor,
      }),
    ).toBe(2);
    expect(
      fittedLineCount({
        lines,
        start: 1,
        maxLines: 2,
        used: 20001 - two,
        requestFor,
        responseFor,
      }),
    ).toBe(1);
  });
});
