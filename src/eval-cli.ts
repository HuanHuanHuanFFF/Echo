import { runEvaluation } from './evaluation.js';
const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
try {
  const configPath = value('--config'),
    outputDir = value('--output');
  const maximum = value('--max-api-calls'),
    budget = value('--budget');
  const { output, report } = await runEvaluation({
    lexicalOnly: args.includes('--lexical-only'),
    ...(configPath ? { configPath } : {}),
    ...(outputDir ? { outputDir } : {}),
    ...(maximum ? { maxApiCalls: Number(maximum) } : {}),
    ...(budget ? { budgetChars: Number(budget) } : {}),
  });
  console.log(
    JSON.stringify(
      {
        output,
        status: report.status,
        strategies: report.strategies,
        api_usage: report.api_usage,
      },
      null,
      2,
    ),
  );
  if (report.status === 'incomplete') process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
