/** Lines retain their positions in the complete file after UUID write-back. */
export interface SourceLine {
  number: number;
  text: string;
}
export interface ChunkerInput {
  sourceId: string;
  path: string;
  lines: readonly SourceLine[];
  options: Readonly<Record<string, unknown>>;
}
export interface ChunkRange {
  startLine: number;
  endLine: number;
  headingPath: string[];
  sectionStartLine?: number;
  sectionEndLine?: number;
}
export interface Chunker {
  id: string;
  version: string;
  chunk(input: ChunkerInput): ChunkRange[] | Promise<ChunkRange[]>;
}
export interface EmbeddingProvider {
  readonly fingerprint: string;
  readonly dimensions: number;
  embed(
    texts: string[],
    purpose: 'query' | 'document',
    signal?: AbortSignal,
  ): Promise<number[][]>;
  usage?(): Readonly<{
    requests: number;
    texts: number;
    input_chars: number;
    reported_tokens: number | null;
  }>;
  dispose?(): Promise<void>;
}
