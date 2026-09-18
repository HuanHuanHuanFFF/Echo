import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import {
  runRetrievalEvaluation,
  snapshotRetrievalCorpus,
} from './retrieval-evaluation.js';
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      dataset: { type: 'string' },
      output: { type: 'string' },
      budget: { type: 'string' },
      'max-api-calls': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: eval:retrieval -- snapshot --config PATH --output FILE\n       eval:retrieval -- run --config PATH --dataset FILE --output NEW_DIRECTORY [--budget 16000] [--max-api-calls N]\nReads pre-synchronized indexes. It never syncs notes, runs an Agent, or supplements source text.',
    );
  } else {
    const [command, ...extra] = positionals;
    if (extra.length || !values.config || !values.output)
      throw new Error('Require one command, --config and --output; see --help');
    if (command === 'snapshot') {
      if (values.dataset || values.budget || values['max-api-calls'])
        throw new Error('snapshot accepts only --config and --output');
      const corpus = await snapshotRetrievalCorpus(
        resolve(values.config),
        resolve(values.output),
      );
      console.log(
        JSON.stringify({
          output: resolve(values.output),
          sources: corpus.length,
        }),
      );
    } else if (command === 'run') {
      if (!values.dataset) throw new Error('run requires --dataset');
      const { output, report } = await runRetrievalEvaluation({
        configPath: resolve(values.config),
        datasetPath: resolve(values.dataset),
        outputDir: resolve(values.output),
        ...(values.budget ? { budgetChars: Number(values.budget) } : {}),
        ...(values['max-api-calls']
          ? { maxApiCalls: Number(values['max-api-calls']) }
          : {}),
      });
      console.log(
        JSON.stringify(
          {
            output,
            status: report.status,
            summary: report.summary,
            api_usage: report.api_usage,
          },
          null,
          2,
        ),
      );
      if (report.status !== 'complete') process.exitCode = 2;
    } else throw new Error('Use snapshot or run; see --help');
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Retrieval evaluation failed',
  );
  process.exitCode = 1;
}
