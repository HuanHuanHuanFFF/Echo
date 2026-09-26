import { createReadStream } from 'node:fs';
// JSONL record framing is LF/CRLF only. Node 24 readline also treats U+2028
// and U+2029 inside otherwise valid JSON strings as line endings.
export async function* readJsonl(file) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  let pending = '';
  let lineNumber = 0;
  function parse(line) {
    lineNumber++;
    if (!line.trim()) return undefined;
    try {
      return JSON.parse(line);
    } catch {
      throw new Error('invalid JSONL at ' + file + ':' + lineNumber);
    }
  }
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const value = parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (value !== undefined) yield value;
      }
    }
    if (pending.length) {
      const value = parse(pending);
      if (value !== undefined) yield value;
    }
  } finally {
    stream.destroy();
  }
}
