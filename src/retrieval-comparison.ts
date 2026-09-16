export interface PairedFactCount {
  id: string;
  group: string;
  baseline: { covered: number; expected: number };
  candidate: { covered: number; expected: number };
}
interface Metric {
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  ci95: [number, number] | null;
  valid_resamples: number;
}
export function pairedBootstrap(
  rows: PairedFactCount[],
  options = { iterations: 10000, seed: 20260916 },
) {
  if (!rows.length) throw Error('At least one paired question is required');
  if (
    !Number.isSafeInteger(options.iterations) ||
    options.iterations < 100 ||
    options.iterations > 100000
  )
    throw Error('Iterations must be 100-100000');
  if (
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffffffff
  )
    throw Error('Seed must be uint32');
  const ids = new Set<string>(),
    groups = new Map<string, PairedFactCount[]>();
  for (const r of rows) {
    if (!r.id || ids.has(r.id) || !r.group)
      throw Error('Question IDs must be unique and intent groups nonempty');
    ids.add(r.id);
    for (const c of [r.baseline, r.candidate])
      if (
        !Number.isSafeInteger(c.covered) ||
        !Number.isSafeInteger(c.expected) ||
        c.covered < 0 ||
        c.expected < c.covered
      )
        throw Error('Invalid fact counts');
    if (r.baseline.expected !== r.candidate.expected)
      throw Error('Required facts differ');
    const g = groups.get(r.group) ?? [];
    g.push(r);
    groups.set(r.group, g);
  }
  const grouped = [...groups.values()];
  const rates = (items: PairedFactCount[]) => {
    let expected = 0,
      b = 0,
      c = 0,
      answerable = 0,
      bComplete = 0,
      cComplete = 0;
    for (const r of items) {
      expected += r.baseline.expected;
      b += r.baseline.covered;
      c += r.candidate.covered;
      if (r.baseline.expected) {
        answerable++;
        bComplete += Number(r.baseline.covered === r.baseline.expected);
        cComplete += Number(r.candidate.covered === r.candidate.expected);
      }
    }
    return [
      [expected ? b / expected : null, expected ? c / expected : null],
      [
        answerable ? bComplete / answerable : null,
        answerable ? cComplete / answerable : null,
      ],
    ] as const;
  };
  const observed = rates(rows),
    samples: [number[], number[]] = [[], []];
  let state = options.seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  if (grouped.length > 1)
    for (let i = 0; i < options.iterations; i++) {
      const items: PairedFactCount[] = [];
      for (let j = 0; j < grouped.length; j++)
        items.push(...grouped[Math.floor(random() * grouped.length)]!);
      rates(items).forEach(([b, c], k) => {
        if (b !== null && c !== null) samples[k as 0 | 1].push(c - b);
      });
    }
  const quantile = (xs: number[], p: number) => {
    const at = (xs.length - 1) * p,
      lo = Math.floor(at),
      hi = Math.ceil(at);
    return xs[lo]! + (xs[hi]! - xs[lo]!) * (at - lo);
  };
  const metric = (index: 0 | 1): Metric => {
    const [b, c] = observed[index],
      xs = samples[index].sort((x, y) => x - y);
    return {
      baseline: b,
      candidate: c,
      delta: b === null || c === null ? null : c - b,
      ci95: xs.length ? [quantile(xs, 0.025), quantile(xs, 0.975)] : null,
      valid_resamples: xs.length,
    };
  };
  return {
    questions: rows.length,
    answerable: rows.filter((r) => r.baseline.expected > 0).length,
    independent_groups: groups.size,
    iterations: options.iterations,
    seed: options.seed,
    method:
      'paired percentile cluster bootstrap by intent_group; linear quantiles',
    fact_coverage: metric(0),
    complete_evidence: metric(1),
  };
}

import { readFile, writeFile, realpath } from 'node:fs/promises';
import {
  join,
  resolve,
  relative,
  isAbsolute,
  dirname,
  basename,
  sep,
} from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const decode = (b: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true }).decode(b);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const strings = z.array(z.string().min(1));
const count = z.number().int().nonnegative();
const scenario = z.object({
  id: z.string(),
  kind: z.enum(['separate', 'mixed']),
});
const sub = z.object({
  query_id: z.string(),
  expected_facts: strings,
  covered_facts: strings,
});
const rowSchema = z
  .object({
    query_id: z.string(),
    intent_group: z.string(),
    type: z.string(),
    request: z.record(z.string(), z.unknown()),
    status: z.enum(['ok', 'empty', 'error', 'partial_failure']),
    expected_facts: strings,
    covered_facts: strings,
    subquery_coverage: z.array(sub),
    no_answer: z.boolean(),
    request_chars: count,
    response_chars: count,
    context_chars: count,
    latency_ms: z.number().finite().nonnegative(),
    api_requests: count,
    first_fact_reciprocal_rank: z.number().min(0).max(1),
    result: z
      .object({ status: z.string(), results: z.array(z.unknown()) })
      .passthrough(),
  })
  .passthrough();
const reportSchema = z
  .object({
    status: z.enum(['complete', 'incomplete']),
    dataset: z.string(),
    split: z.enum(['development', 'test']),
    scenario,
    retrieval_only: z.literal(true),
    api_usage: z.unknown(),
    query_cache_hits: count,
    rows: z.array(rowSchema).min(1),
  })
  .passthrough();
const manifestSchema = z
  .object({
    dataset: z.object({
      name: z.string(),
      split: z.string(),
      scenario,
      sha256: z.string(),
    }),
    corpus: z.array(z.unknown()),
    runtime: z.object({ sha256: z.string() }).passthrough(),
    budget_chars: z.number().int().positive(),
    retrieval: z.unknown(),
    embedding: z.unknown(),
    selection: z.unknown(),
  })
  .passthrough();
const dataSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  split: z.enum(['development', 'test']),
  scenario,
  corpus: z.array(z.unknown()),
  facts: z.array(z.object({ id: z.string() })),
  questions: z
    .array(
      z.object({
        id: z.string(),
        intent_group: z.string(),
        type: z.string(),
        query: z.string(),
        required_facts: strings,
        no_answer: z.boolean().default(false),
        subquestions: z
          .array(
            z.object({
              id: z.string(),
              text: z.string(),
              required_facts: strings,
            }),
          )
          .optional(),
      }),
    )
    .min(1),
});
type Row = z.infer<typeof rowSchema>;
function assertFacts(expected: string[], found: string[]) {
  if (
    new Set(expected).size !== expected.length ||
    new Set(found).size !== found.length ||
    found.some((f) => !expected.includes(f))
  )
    throw Error('Invalid covered/required fact IDs');
}
async function loadRun(directory: string) {
  const names = ['dataset.json', 'manifest.json', 'report.json', 'rows.jsonl'];
  const bytes = await Promise.all(
    names.map((n) => readFile(join(directory, n))),
  );
  const dataset = dataSchema.parse(JSON.parse(decode(bytes[0]!)));
  const manifest = manifestSchema.parse(JSON.parse(decode(bytes[1]!)));
  const rawReport = JSON.parse(decode(bytes[2]!)),
    report = reportSchema.parse(rawReport);
  const rowLog = decode(bytes[3]!)
    .trim()
    .split(/\r?\n/)
    .map((s) => JSON.parse(s));
  if (!same(rowLog, rawReport.rows))
    throw Error('Row log differs from published report');
  if (digest(bytes[0]!) !== manifest.dataset.sha256)
    throw Error('Dataset bytes differ from manifest');
  if (
    manifest.dataset.name !== dataset.name ||
    manifest.dataset.split !== dataset.split ||
    !same(manifest.dataset.scenario, dataset.scenario) ||
    !same(manifest.corpus, dataset.corpus)
  )
    throw Error('Manifest dataset/corpus binding differs');
  if (
    report.dataset !== dataset.name ||
    report.split !== dataset.split ||
    !same(report.scenario, dataset.scenario)
  )
    throw Error('Report dataset/scenario binding differs');
  const ids = dataset.questions.map((q) => q.id),
    factIds = new Set(dataset.facts.map((f) => f.id));
  if (
    new Set(ids).size !== ids.length ||
    factIds.size !== dataset.facts.length ||
    report.rows.length !== ids.length ||
    new Set(report.rows.map((r) => r.query_id)).size !== ids.length
  )
    throw Error('Question/fact IDs or row counts differ');
  for (const r of report.rows) {
    const q = dataset.questions.find((q) => q.id === r.query_id);
    if (
      !q ||
      q.intent_group !== r.intent_group ||
      q.type !== r.type ||
      q.no_answer !== r.no_answer ||
      !same(q.required_facts, r.expected_facts) ||
      q.required_facts.some((f) => !factIds.has(f)) ||
      q.no_answer !== (q.required_facts.length === 0)
    )
      throw Error('Row labels differ from frozen dataset');
    assertFacts(r.expected_facts, r.covered_facts);
    const { overrides: _, ...payload } = r.request;
    const expectedPayload = q.subquestions
      ? {
          queries: q.subquestions.map((s) => ({
            query_id: s.id.trim(),
            text: s.text.trim(),
          })),
        }
      : { query: q.query.trim() };
    if (!same(payload, expectedPayload))
      throw Error('Request differs from frozen query');
    if (r.subquery_coverage.length !== (q.subquestions?.length ?? 0))
      throw Error('Subquery labels differ');
    for (let i = 0; i < r.subquery_coverage.length; i++) {
      const s = r.subquery_coverage[i]!,
        label = q.subquestions![i]!;
      if (
        s.query_id !== label.id.trim() ||
        !same(s.expected_facts, label.required_facts)
      )
        throw Error('Subquery labels differ');
      assertFacts(s.expected_facts, s.covered_facts);
    }
    if (
      r.status !== r.result.status ||
      r.request_chars !== JSON.stringify(r.request).length ||
      r.response_chars !== JSON.stringify(r.result).length ||
      r.context_chars !== r.request_chars + r.response_chars ||
      r.context_chars > manifest.budget_chars
    )
      throw Error('Row status or context budget differs');
  }
  const failures = report.rows.filter((r) =>
    ['error', 'partial_failure'].includes(r.status),
  ).length;
  if ((report.status === 'incomplete') !== failures > 0)
    throw Error('Run completion status differs from its rows');
  return {
    directory: resolve(directory),
    dataset,
    manifest,
    report,
    failures,
    files: Object.fromEntries(names.map((n, i) => [n, digest(bytes[i]!)])),
  };
}
function pairs(a: Row[], b: Row[]): PairedFactCount[] {
  return a.map((r) => {
    const other = b.find((o) => o.query_id === r.query_id);
    if (!other || !same(r.request, other.request))
      throw Error('Paired requests differ');
    return {
      id: r.query_id,
      group: r.intent_group,
      baseline: {
        covered: r.covered_facts.length,
        expected: r.expected_facts.length,
      },
      candidate: {
        covered: other.covered_facts.length,
        expected: other.expected_facts.length,
      },
    };
  });
}
export async function compareRetrievalRuns(
  baselineDir: string,
  candidateDir: string,
  options = { iterations: 10000, seed: 20260916 },
) {
  const [a, b] = await Promise.all([
    loadRun(baselineDir),
    loadRun(candidateDir),
  ]);
  if (
    a.manifest.dataset.sha256 !== b.manifest.dataset.sha256 ||
    !same(a.manifest.corpus, b.manifest.corpus)
  )
    throw Error('Paired dataset/corpus must be identical');
  if (a.manifest.budget_chars !== b.manifest.budget_chars)
    throw Error('Paired context budget must be identical');
  const paired = pairs(a.report.rows, b.report.rows);
  const bindings = (r: typeof a) => ({
    directory: r.directory,
    files: r.files,
    runtime: r.manifest.runtime,
    selection: r.manifest.selection,
    retrieval: r.manifest.retrieval,
    embedding: r.manifest.embedding,
    failures: r.failures,
    api_usage: r.report.api_usage,
    query_cache_hits: r.report.query_cache_hits,
  });
  const diagnostics = (rows: Row[]) => ({
    no_answer: {
      queries: rows.filter((r) => r.no_answer).length,
      nonempty: rows.filter((r) => r.no_answer && r.result.results.length > 0)
        .length,
    },
    context_chars: rows.reduce((n, r) => n + r.context_chars, 0),
    latency_ms: {
      p50: percentile(
        rows.map((r) => r.latency_ms),
        0.5,
      ),
      p95: percentile(
        rows.map((r) => r.latency_ms),
        0.95,
      ),
    },
  });
  const childPairs: PairedFactCount[] = [];
  for (const r of a.report.rows) {
    const other = b.report.rows.find((o) => o.query_id === r.query_id)!;
    for (const s of r.subquery_coverage) {
      const t = other.subquery_coverage.find(
        (s2) => s2.query_id === s.query_id,
      )!;
      childPairs.push({
        id: JSON.stringify([r.query_id, s.query_id]),
        group: r.intent_group,
        baseline: {
          covered: s.covered_facts.length,
          expected: s.expected_facts.length,
        },
        candidate: {
          covered: t.covered_facts.length,
          expected: t.expected_facts.length,
        },
      });
    }
  }
  return {
    status: a.failures || b.failures ? 'diagnostic_incomplete' : 'complete',
    dataset: a.manifest.dataset,
    budget_chars: a.manifest.budget_chars,
    baseline: bindings(a),
    candidate: bindings(b),
    paired: pairedBootstrap(paired, options),
    subquestions: childPairs.length
      ? pairedBootstrap(childPairs, options)
      : null,
    by_type: Object.fromEntries(
      [...new Set(a.report.rows.map((r) => r.type))].sort().map((type) => [
        type,
        pairedBootstrap(
          paired.filter(
            (p) =>
              a.report.rows.find((r) => r.query_id === p.id)!.type === type,
          ),
          options,
        ),
      ]),
    ),
    diagnostics: {
      baseline: diagnostics(a.report.rows),
      candidate: diagnostics(b.report.rows),
    },
    interpretation:
      'Candidate minus baseline; paired percentile intervals resample whole intent groups. Small or dependent groups limit inference. No answer rows and failures are reported separately. This is retrieval evidence coverage, not answer accuracy or a p-value.',
  };
}
function percentile(values: number[], p: number) {
  const xs = values.slice().sort((a, b) => a - b);
  return xs[Math.max(0, Math.ceil(xs.length * p) - 1)] ?? null;
}
export async function writeRetrievalComparison(
  baselineDir: string,
  candidateDir: string,
  output: string,
  options = { iterations: 10000, seed: 20260916 },
) {
  const target = join(
    await realpath(dirname(resolve(output))),
    basename(output),
  );
  for (const root of [baselineDir, candidateDir]) {
    const rel = relative(await realpath(root), target);
    if (
      !rel ||
      (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
    )
      throw Error('Output must be outside input run directories');
  }
  const result = await compareRetrievalRuns(baselineDir, candidateDir, options);
  await writeFile(target, JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx',
  });
  return result;
}
