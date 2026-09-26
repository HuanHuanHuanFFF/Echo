export const supplementPolicy: Readonly<{
  maxFiles: number;
  backtrackLines: number;
  maxLines: number;
  budgetChars: number;
  qmdSafetyChars: number;
}>;

export function readStart(hitLine: number): number;
export function selectFirstFiles<T extends { source_id: string }>(
  results: T[],
): T[];
export function fittedLineCount(options: {
  lines: string[];
  start: number;
  maxLines: number;
  used: number;
  requestFor: (count: number) => unknown;
  responseFor: (text: string) => unknown;
  safety?: number;
}): number;
