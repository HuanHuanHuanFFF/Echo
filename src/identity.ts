import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  let frontmatterEnd = -1;
  let sourceId: string | undefined;
  let flowStart: number | undefined;
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
      if (doc.contents.flow) flowStart = doc.contents.range?.[0];
    }
  }
  return { bom, text, lines, frontmatterEnd, sourceId, flowStart };
}
export async function prepareSource(path: string): Promise<PreparedSource> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Only regular Markdown files can be imported');
  if (info.size > 10 * 1024 * 1024)
    throw new Error('Markdown file exceeds 10 MiB');
  let raw = await readFile(path, 'utf8');
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
    } else if (parsed.flowStart !== undefined) {
      // Source ranges are measured in normalized YAML; preserve original bytes by locating the opening brace.
      const firstEol = parsed.text.indexOf(eol) + eol.length;
      const yamlOriginal = parsed.text.slice(firstEol);
      const prefix = parsed.lines
        .slice(1, parsed.frontmatterEnd)
        .join('\n')
        .slice(0, parsed.flowStart);
      const offset = firstEol + prefix.replaceAll('\n', eol).length + 1;
      if (parsed.text[offset - 1] !== '{' || !yamlOriginal.length)
        throw new Error('Unsupported flow frontmatter');
      const rest = parsed.text.slice(offset);
      updated =
        parsed.bom +
        parsed.text.slice(0, offset) +
        'echo_id: ' +
        id +
        (rest.trimStart().startsWith('}') ? '' : ', ') +
        rest;
    } else {
      const firstEol = parsed.text.indexOf(eol);
      if (firstEol < 0) throw new Error('Invalid frontmatter line ending');
      const insertAt = firstEol + eol.length;
      updated =
        parsed.bom +
        parsed.text.slice(0, insertAt) +
        'echo_id: ' +
        id +
        eol +
        parsed.text.slice(insertAt);
    }
    if (parseSource(updated).sourceId !== id)
      throw new Error('UUID insertion validation failed');
    const temporary = path + '.echo-' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, updated, { flag: 'wx', mode: info.mode });
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
