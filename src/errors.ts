import { EchoError } from './profile-store.js';
export function failureInfo(error: unknown): { code: string; next: string } {
  if (error instanceof EchoError) return { code: error.code, next: error.next };
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    'next' in error &&
    typeof error.code === 'string' &&
    /^[A-Z_]{1,40}$/.test(error.code) &&
    typeof error.next === 'string'
  )
    return { code: error.code, next: error.next.slice(0, 100) };
  const message = error instanceof Error ? error.message : String(error);
  if (/max_context_chars/i.test(message))
    return {
      code: 'CONTEXT_BUDGET',
      next: 'Increase max_context_chars or submit fewer subquestions',
    };
  if (/not configured|Embedding not configured/i.test(message))
    return {
      code: 'CONFIG_REQUIRED',
      next: 'Configure Echo and the selected embedding profile',
    };
  if (/key missing/i.test(message))
    return {
      code: 'MODEL_KEY_MISSING',
      next: 'Set the API key environment variable for the MCP process',
    };
  if (/busy|locked/i.test(message))
    return { code: 'BUSY', next: 'Retry after the current operation finishes' };
  if (/cancel/i.test(message))
    return {
      code: 'CANCELLED',
      next: 'Retry only if the result is still needed',
    };
  if (/timed? ?out|timeout/i.test(message))
    return { code: 'TIMEOUT', next: 'Retry or adjust the configured timeout' };
  if (/Embedding|fetch|HTTP|model/i.test(message))
    return {
      code: 'MODEL_UNAVAILABLE',
      next: 'Check model configuration and API availability',
    };
  if (
    /run sync|not synchronized|no such table|unable to open database/i.test(
      message,
    )
  )
    return { code: 'INDEX_REQUIRED', next: 'Run echo-mcp sync' };
  return {
    code: 'INVALID_REQUEST',
    next: 'Check input and configuration; use echo-mcp config show',
  };
}
