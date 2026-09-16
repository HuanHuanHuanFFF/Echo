import { randomUUID, createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isMap, parseDocument } from 'yaml';
import type { SourceLine } from './contracts.js';

export const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const hash = (text: string) =>
  createHash('sha256').update(text).digest('hex');
export interface PreparedSource {
  sourceId: string;
  raw: string;
  sourceVersion: string;
  lines: SourceLine[];
  wroteId: boolean;
}
export function parseSource(raw: string) {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = raw.slice(bom.length);
  const lines = text.split(/\r\n|\n|\r/);
  const lineStarts = [
    0,
    ...[...text.matchAll(/\r\n|\n|\r/g)].map((m) => m.index + m[0].length),
  ];
  let frontmatterEnd = -1;
  let sourceId: string | undefined;
  let flowInsertAt: number | undefined;
  let blockIndent = '';
  if (lines[0]?.trim() === '---') {
    frontmatterEnd = lines.findIndex(
      (line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line),
    );
    if (frontmatterEnd < 0) throw new Error('Unclosed YAML frontmatter');
    const yaml = lines.slice(1, frontmatterEnd).join('\n');
    const doc = parseDocument(yaml, { uniqueKeys: true, prettyErrors: false });
    if (doc.errors.length)
      throw new Error('Invalid YAML frontmatter: ' + doc.errors[0]!.code);
    if (doc.contents !== null && !isMap(doc.contents))
      throw new Error('Frontmatter must be a mapping');
    if (isMap(doc.contents)) {
      if (doc.contents.has('echo_id')) {
        const value: unknown = doc.contents.get('echo_id');
        if (typeof value !== 'string' || !uuidV4.test(value))
          throw new Error('echo_id must be a UUID v4 string');
        sourceId = value.toLowerCase();
      }
      const prefixLines = yaml
        .slice(0, doc.contents.range?.[0] ?? 0)
        .split('\n');
      blockIndent = prefixLines.at(-1)!.match(/^[ \t]*/)?.[0] ?? '';
      if (doc.contents.flow) {
        flowInsertAt =
          lineStarts[prefixLines.length]! + prefixLines.at(-1)!.length + 1;
        if (text[flowInsertAt - 1] !== '{')
          throw new Error('Unsupported flow frontmatter');
      }
    }
  }
  return {
    bom,
    text,
    lines,
    lineStarts,
    frontmatterEnd,
    sourceId,
    flowInsertAt,
    blockIndent,
  };
}
export async function prepareSource(
  path: string,
  maxFileBytes = 10 * 1024 * 1024,
): Promise<PreparedSource> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Only regular Markdown files can be imported');
  if (info.size > maxFileBytes)
    throw new Error(
      'Markdown file exceeds configured max_file_bytes: ' + maxFileBytes,
    );
  let raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    await readFile(path),
  );
  let parsed = parseSource(raw);
  let wroteId = false;
  if (!parsed.sourceId) {
    const id = randomUUID();
    const eol = raw.match(/\r\n|\n|\r/)?.[0] ?? '\n';
    let updated: string;
    if (parsed.frontmatterEnd < 0) {
      updated =
        parsed.bom +
        '---' +
        eol +
        'echo_id: ' +
        id +
        eol +
        '---' +
        eol +
        parsed.text;
    } else if (parsed.flowInsertAt !== undefined) {
      const rest = parsed.text.slice(parsed.flowInsertAt);
      updated =
        parsed.bom +
        parsed.text.slice(0, parsed.flowInsertAt) +
        'echo_id: ' +
        id +
        (rest.trimStart().startsWith('}') ? '' : ', ') +
        rest;
    } else {
      // Append a sibling key inside the existing mapping, preserving root tags, anchors and indentation.
      const insertAt = parsed.lineStarts[parsed.frontmatterEnd]!;
      updated =
        parsed.bom +
        parsed.text.slice(0, insertAt) +
        parsed.blockIndent +
        'echo_id: ' +
        id +
        eol +
        parsed.text.slice(insertAt);
    }
    if (Buffer.byteLength(updated, 'utf8') > maxFileBytes)
      throw new Error(
        'UUID insertion would exceed configured max_file_bytes: ' +
          maxFileBytes,
      );
    if (parseSource(updated).sourceId !== id)
      throw new Error('UUID insertion validation failed');
    const temporary = path + '.echo-' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, updated, { flag: 'wx', mode: info.mode });
      // File creation applies umask even when mode is supplied. Restore POSIX bits before replacement.
      if (process.platform !== 'win32')
        await chmod(temporary, info.mode & 0o7777);
      if ((await readFile(path, 'utf8')) !== raw)
        throw new Error('Source changed during UUID insertion; retry sync');
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    raw = updated;
    parsed = parseSource(raw);
    wroteId = true;
  }
  const lines = parsed.lines
    .map((text, i) => ({ number: i + 1, text }))
    .filter((line) => line.number > parsed.frontmatterEnd + 1);
  return {
    sourceId: parsed.sourceId!,
    raw,
    sourceVersion: hash(raw),
    lines,
    wroteId,
  };
}
