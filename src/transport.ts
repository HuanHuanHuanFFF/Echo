import { failureInfo } from './errors.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export function boundedErrorText(value: unknown, limit = 256): string {
  const message = value instanceof Error ? value.message : String(value);
  const info = failureInfo(value);
  const metadata = { code: info.code, next: info.next.slice(0, 90) };
  const chars = Array.from(message).slice(0, 4096);
  let low = 0,
    high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const text = JSON.stringify({
      status: 'error',
      ...metadata,
      error: chars.slice(0, middle).join(''),
    });
    if (text.length <= limit) low = middle;
    else high = middle - 1;
  }
  return JSON.stringify({
    status: 'error',
    ...metadata,
    error: chars.slice(0, low).join(''),
  });
}
/** Bounds SDK-generated tool validation errors as well as errors from tool callbacks. */
export class EchoStdioTransport extends StdioServerTransport {
  override send(message: JSONRPCMessage): Promise<void> {
    if (
      'result' in message &&
      message.result.isError === true &&
      Array.isArray(message.result.content)
    ) {
      const content = message.result.content as {
        type?: string;
        text?: string;
      }[];
      const text = content
        .filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* SDK validation messages are plain text. */
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        'results' in parsed &&
        Array.isArray(parsed.results) &&
        'queries' in parsed &&
        Array.isArray(parsed.queries)
      ) {
        // A complete failed search already obeys its requested budget; preserve per-query failures.
        return super.send(message);
      }
      const reason =
        parsed &&
        typeof parsed === 'object' &&
        'error' in parsed &&
        typeof parsed.error === 'string'
          ? parsed.error
          : text;
      const { structuredContent: _structuredContent, ...result } =
        message.result;
      return super.send({
        ...message,
        result: {
          ...result,
          content: [
            {
              type: 'text',
              text: boundedErrorText(
                parsed &&
                  typeof parsed === 'object' &&
                  'code' in parsed &&
                  'next' in parsed
                  ? Object.assign(new Error(reason), {
                      code: parsed.code,
                      next: parsed.next,
                    })
                  : reason,
              ),
            },
          ],
        },
      });
    }
    return super.send(message);
  }
}
