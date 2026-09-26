import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export function supplementUsage(entry) {
  const action =
    entry === 'run' ? ' <verify|run echo|run rrf|run rerank|summarize>' : '';
  const publication =
    entry === 'seal' ? ' --published-summary FILE --published-report FILE' : '';
  return `Usage: node evals/${entry}-supplement-private.mjs${action} --comparison-root DIR --qmd-root DIR --experiment-root DIR${publication}`;
}

export function parseSupplementArgs(argv, entry, cwd = process.cwd()) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'comparison-root': { type: 'string' },
      'qmd-root': { type: 'string' },
      'experiment-root': { type: 'string' },
      ...(entry === 'seal'
        ? {
            'published-summary': { type: 'string' },
            'published-report': { type: 'string' },
          }
        : {}),
      help: { type: 'boolean', short: 'h' },
    },
  });
  const usage = supplementUsage(entry);
  if (values.help) return { help: true, usage };
  const [action, condition] = positionals;
  if (entry === 'run') {
    if (
      !['verify', 'run', 'summarize'].includes(action) ||
      (action === 'run'
        ? positionals.length !== 2 ||
          !['echo', 'rrf', 'rerank'].includes(condition)
        : positionals.length !== 1)
    )
      throw new Error('Invalid supplement action or condition');
  } else if (positionals.length)
    throw new Error('Unexpected positional arguments');
  for (const name of [
    'comparison-root',
    'qmd-root',
    'experiment-root',
    ...(entry === 'seal' ? ['published-summary', 'published-report'] : []),
  ])
    if (typeof values[name] !== 'string' || !values[name].trim())
      throw new Error('Missing required --' + name);
  return {
    help: false,
    usage,
    action,
    condition,
    comparisonRoot: resolve(cwd, values['comparison-root']),
    qmdRoot: resolve(cwd, values['qmd-root']),
    experimentRoot: resolve(cwd, values['experiment-root']),
    ...(entry === 'seal'
      ? {
          publishedSummary: resolve(cwd, values['published-summary']),
          publishedReport: resolve(cwd, values['published-report']),
        }
      : {}),
  };
}

/** Parse before corpus reads or output creation; diagnostics never echo supplied paths. */
export function supplementCli(entry) {
  let options;
  try {
    options = parseSupplementArgs(process.argv.slice(2), entry);
  } catch {
    console.error(supplementUsage(entry));
    process.exit(2);
  }
  if (options.help) {
    console.log(options.usage);
    process.exit(0);
  }
  return options;
}
