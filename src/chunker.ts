import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  Chunker,
  ChunkerInput,
  ChunkRange,
  SourceLine,
} from './contracts.js';
import type { EchoConfig } from './config.js';
import { hash } from './identity.js';

const optionsSchema = z
  .object({ max_chars: z.number().int().min(64).max(100000).default(1000) })
  .strict();
export const defaultChunker: Chunker = {
  id: 'echo-heading-lines',
  version: '1',
  chunk(input) {
    const { max_chars: maxChars } = optionsSchema.parse(input.options);
    const sections: { lines: SourceLine[]; headings: string[] }[] = [];
    const stack: string[] = [];
    let current: SourceLine[] = [];
    let fence: string | undefined;
    const flush = () => {
      if (current.length)
        sections.push({ lines: current, headings: [...stack].filter(Boolean) });
      current = [];
    };
    for (const line of input.lines) {
      const heading =
        !fence && /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line.text);
      if (heading) {
        flush();
        stack.length = heading[1]!.length;
        stack[heading[1]!.length - 1] = heading[2]!
          .replace(/[ \t]+#+\s*$/, '')
          .trim();
      }
      current.push(line);
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
      if (marker) {
        if (!fence) fence = marker[1]!;
        else if (
          marker[1]![0] === fence[0] &&
          marker[1]!.length >= fence.length &&
          !marker[2]!.trim()
        )
          fence = undefined;
      }
    }
    flush();
    const ranges: ChunkRange[] = [];
    for (const section of sections) {
      let start = 0,
        count = 0;
      const emit = (end: number) => {
        while (start <= end && !section.lines[start]!.text.trim()) start++;
        while (end >= start && !section.lines[end]!.text.trim()) end--;
        if (start <= end)
          ranges.push({
            startLine: section.lines[start]!.number,
            endLine: section.lines[end]!.number,
            headingPath: section.headings,
            sectionStartLine: section.lines[0]!.number,
            sectionEndLine: section.lines.at(-1)!.number,
          });
      };
      for (let i = 0; i < section.lines.length; i++) {
        const line = section.lines[i]!;
        if (i > start && count + line.text.length + 1 > maxChars) {
          emit(i - 1);
          start = i;
          count = 0;
        }
        count += line.text.length + 1;
      }
      emit(section.lines.length - 1);
    }
    return ranges;
  },
};
export async function loadChunker(
  config: EchoConfig['chunker'],
): Promise<{ chunker: Chunker; fingerprint: string }> {
  let chunker = defaultChunker;
  let moduleHash = 'builtin';
  if (config.module) {
    moduleHash = hash(await readFile(config.module, 'utf8'));
    const mod: unknown = (
      await import(pathToFileURL(config.module).href + '?v=' + moduleHash)
    ).default;
    if (
      !mod ||
      typeof mod !== 'object' ||
      !('chunk' in mod) ||
      typeof mod.chunk !== 'function' ||
      !('id' in mod) ||
      typeof mod.id !== 'string' ||
      !mod.id ||
      !('version' in mod) ||
      typeof mod.version !== 'string' ||
      !mod.version
    )
      throw new Error('Invalid chunker export');
    chunker = mod as Chunker;
  } else {
    optionsSchema.parse(config.options);
  }
  return {
    chunker,
    fingerprint: hash(
      JSON.stringify({
        id: chunker.id,
        version: chunker.version,
        moduleHash,
        config,
      }),
    ),
  };
}
const rangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    headingPath: z.array(z.string().max(2000)).max(20),
    sectionStartLine: z.number().int().positive().optional(),
    sectionEndLine: z.number().int().positive().optional(),
  })
  .strict();
export async function runChunker(chunker: Chunker, input: ChunkerInput) {
  const available = new Map(
    input.lines.map((line) => [line.number, line.text]),
  );
  const ranges = z
    .array(rangeSchema)
    .max(100000)
    .parse(await chunker.chunk(input));
  return ranges.map((range) => {
    if (
      range.endLine < range.startLine ||
      range.endLine - range.startLine > input.lines.length
    )
      throw new Error('Invalid chunk range');
    const text: string[] = [];
    for (let n = range.startLine; n <= range.endLine; n++) {
      const line = available.get(n);
      if (line === undefined)
        throw new Error('Chunk crosses unavailable or frontmatter lines');
      text.push(line);
    }
    if (!text.join('\n').trim()) throw new Error('Empty chunk');
    if (
      (range.sectionStartLine === undefined) !==
      (range.sectionEndLine === undefined)
    )
      throw new Error('Both section bounds are required');
    if (
      range.sectionStartLine !== undefined &&
      (range.sectionStartLine > range.startLine ||
        range.sectionEndLine! < range.endLine ||
        !available.has(range.sectionStartLine) ||
        !available.has(range.sectionEndLine!))
    )
      throw new Error('Invalid section bounds');
    // A plugin receives sourceId as metadata but cannot inject it into retrieval headings.
    if (
      range.headingPath.some((h) =>
        h.toLowerCase().includes(input.sourceId.toLowerCase()),
      )
    )
      throw new Error('Identity in chunk headings');
    return { ...range, text: text.join('\n') };
  });
}
