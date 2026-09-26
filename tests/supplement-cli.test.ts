import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { parseSupplementArgs } = await import(
  new URL('../evals/lib/supplement-cli.mjs', import.meta.url).href
);

const dirs: string[] = [];
const entries = ['run', 'audit', 'seal'] as const;
const flags = [
  '--comparison-root',
  'selected comparison',
  '--qmd-root',
  'selected qmd',
  '--experiment-root',
  'selected experiment',
];
const flagsFor = (entry: string) => [
  ...flags,
  ...(entry === 'seal'
    ? [
        '--published-summary',
        'publication/summary.json',
        '--published-report',
        'publication/report.md',
      ]
    : []),
];
const script = (entry: string) =>
  resolve(`evals/${entry}-supplement-private.mjs`);
const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'echo supplement cli-'));
  dirs.push(root);
  return root;
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

it('requires all roots and resolves relative paths from the caller working directory', async () => {
  const cwd = await directory();
  expect(
    parseSupplementArgs(['run', 'echo', ...flags], 'run', cwd),
  ).toMatchObject({
    action: 'run',
    condition: 'echo',
    comparisonRoot: join(cwd, 'selected comparison'),
    qmdRoot: join(cwd, 'selected qmd'),
    experimentRoot: join(cwd, 'selected experiment'),
  });
  for (let n = 0; n < flags.length; n += 2) {
    const missing = flags.filter((_, index) => index !== n && index !== n + 1);
    expect(() =>
      parseSupplementArgs(['verify', ...missing], 'run', cwd),
    ).toThrow('Missing required');
  }
  expect(() =>
    parseSupplementArgs(['verify', ...flags, '--qmd-root', '  '], 'run', cwd),
  ).toThrow();
});

it('requires explicit publication files when sealing', () => {
  expect(() => parseSupplementArgs(flags, 'seal')).toThrow('published-summary');
  expect(() =>
    parseSupplementArgs(
      [...flags, '--published-summary', 'summary.json'],
      'seal',
    ),
  ).toThrow('published-report');
});

it('rejects unknown flags, modes and surplus arguments before loading the experiment', () => {
  for (const args of [
    ['run', 'wrong'],
    ['verify', 'echo'],
    ['summarize', 'extra'],
    ['run'],
    ['other'],
  ])
    expect(() => parseSupplementArgs([...args, ...flags], 'run')).toThrow();
  expect(() => parseSupplementArgs([...flags, '--unknown'], 'audit')).toThrow();
  expect(() => parseSupplementArgs(['extra', ...flags], 'seal')).toThrow();
});

it.each(entries)(
  '%s help and invalid invocation do not read corpus data or create output',
  async (entry) => {
    const cwd = await directory();
    const help = execFileSync(process.execPath, [script(entry), '--help'], {
      cwd,
      encoding: 'utf8',
    });
    expect(help).toContain(
      '--comparison-root DIR --qmd-root DIR --experiment-root DIR',
    );
    const missing = spawnSync(
      process.execPath,
      [script(entry), ...(entry === 'run' ? ['verify'] : [])],
      { cwd, encoding: 'utf8' },
    );
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('Usage:');
    expect(missing.stderr).not.toContain(cwd);
    expect(await readdir(cwd)).toEqual([]);
  },
);

it.each(entries)(
  '%s entry actually reads the explicitly selected directories',
  async (entry) => {
    const cwd = await directory();
    const result = spawnSync(
      process.execPath,
      [
        script(entry),
        ...(entry === 'run' ? ['verify'] : []),
        ...flagsFor(entry),
      ],
      { cwd, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).toContain(
      entry === 'run' ? 'selected qmd' : 'selected experiment',
    );
    expect(result.stderr).toContain(
      entry === 'run'
        ? 'private-preparation.json'
        : entry === 'audit'
          ? 'summary.json'
          : 'verification.json',
    );
    expect(await readdir(cwd)).toEqual([]);
  },
);

it.each(['audit', 'seal'])(
  '%s rejects changed runner/helper fingerprints without writing output',
  async (entry) => {
    const cwd = await directory();
    const experiment = join(cwd, 'selected experiment');
    await mkdir(experiment);
    const runnerHash = sha(await readFile(script('run')));
    const helperHash = sha(await readFile('evals/lib/supplement-cli.mjs'));
    const policyHash = sha(await readFile('evals/lib/supplement-budget.mjs'));
    for (const field of ['script_sha256', 'cli_sha256']) {
      const verification = JSON.stringify({
        script_sha256: runnerHash,
        cli_sha256: helperHash,
        policy_sha256: policyHash,
        input_sha256: {},
        [field]: 'changed-fingerprint',
      });
      await writeFile(join(experiment, 'verification.json'), verification);
      await writeFile(
        join(experiment, 'summary.json'),
        JSON.stringify({ verification_sha256: sha(verification) }),
      );
      await writeFile(
        join(experiment, 'audit.json'),
        JSON.stringify({ status: 'independently-rescored' }),
      );
      const result = spawnSync(
        process.execPath,
        [script(entry), ...flagsFor(entry)],
        {
          cwd,
          encoding: 'utf8',
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('changed-fingerprint');
      expect((await readdir(experiment)).sort()).toEqual([
        'audit.json',
        'summary.json',
        'verification.json',
      ]);
    }
  },
);

it('seals a self-consistent new run against its own selected publication', async () => {
  const cwd = await directory();
  const experiment = join(cwd, 'selected experiment');
  const comparison = join(cwd, 'selected comparison');
  const qmd = join(cwd, 'selected qmd');
  const publication = join(cwd, 'publication');
  await mkdir(experiment);
  await mkdir(publication);
  const save = async (file: string, text = '{}\n') => {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, text);
  };
  const verification = JSON.stringify({
    script_sha256: sha(await readFile(script('run'))),
    cli_sha256: sha(await readFile('evals/lib/supplement-cli.mjs')),
    policy_sha256: sha(await readFile('evals/lib/supplement-budget.mjs')),
    corpus_manifest_sha256: 'isolated-fixture',
    input_sha256: {},
  });
  const summary = JSON.stringify({
    verification_sha256: sha(verification),
    fixture: true,
  });
  const audit = JSON.stringify({
    status: 'independently-rescored',
    checked_questions: 600,
    checked_native_gets: 1178,
    checked_host_reads: 577,
    verification_sha256: sha(verification),
    summary_sha256: sha(summary),
  });
  await save(join(experiment, 'verification.json'), verification);
  await save(join(experiment, 'summary.json'), summary);
  await save(join(experiment, 'audit.json'), audit);
  await save(join(publication, 'summary.json'), summary);
  await save(
    join(publication, 'report.md'),
    '# Isolated publication fixture\n',
  );
  await save(join(qmd, 'private-preparation.json'));
  await save(join(qmd, 'download-manifest.json'));
  for (const scope of ['A-test', 'B-test', 'C-test', 'D-test', 'mixed-test']) {
    await save(join(comparison, 'runs/echo', scope + '-receipt.json'));
    for (const mode of ['echo', 'rrf', 'rerank']) {
      await save(join(experiment, mode + '-' + scope + '.jsonl'));
      if (mode !== 'echo')
        await save(join(qmd, 'runs-mcp', mode, scope + '.receipt.json'));
    }
  }
  await writeFile(join(publication, 'summary.json'), '{}');
  const mismatched = spawnSync(
    process.execPath,
    [script('seal'), ...flagsFor('seal')],
    { cwd, encoding: 'utf8' },
  );
  expect(mismatched.status).not.toBe(0);
  expect(mismatched.stderr).toContain('ERR_ASSERTION');
  expect(await readdir(experiment)).not.toContain('freeze.json');
  await writeFile(join(publication, 'summary.json'), summary);
  const result = spawnSync(
    process.execPath,
    [script('seal'), ...flagsFor('seal')],
    {
      cwd,
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(experiment, 'receipt.json'), 'utf8'),
  );
  expect(receipt.published_aggregate_sha256).toBe(sha(summary));
  expect(receipt.published_report_sha256).toBe(
    sha(await readFile(join(publication, 'report.md'))),
  );
});
