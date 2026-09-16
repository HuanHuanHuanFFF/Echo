import { parseArgs } from 'node:util';
import { writeRetrievalComparison } from './retrieval-comparison.js';
try {
  const { values, positionals } = parseArgs({
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      output: { type: 'string' },
      iterations: { type: 'string' },
      seed: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help)
    console.log(
      'Usage: eval:compare -- --baseline RUN_DIRECTORY --candidate RUN_DIRECTORY --output NEW_FILE [--iterations 10000] [--seed 20260916]\nBoth runs must use the exact same frozen dataset, queries and context budget. No model calls.',
    );
  else {
    if (
      positionals.length ||
      !values.baseline ||
      !values.candidate ||
      !values.output
    )
      throw Error('Required: --baseline, --candidate and --output');
    const options = {
      iterations:
        values.iterations === undefined ? 10000 : Number(values.iterations),
      seed: values.seed === undefined ? 20260916 : Number(values.seed),
    };
    const result = await writeRetrievalComparison(
      values.baseline,
      values.candidate,
      values.output,
      options,
    );
    console.log(
      JSON.stringify(
        { status: result.status, paired: result.paired, output: values.output },
        null,
        2,
      ),
    );
    if (result.status !== 'complete') process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Comparison failed');
  process.exitCode = 1;
}
