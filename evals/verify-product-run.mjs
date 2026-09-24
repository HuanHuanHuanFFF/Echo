import { verifyFinalModelProvenance } from './lib/product-model-provenance.mjs';
import { verifyProductRuns } from './lib/product-run-integrity.mjs';

const [root, condition, scopeArgument] = process.argv.slice(2);
if (!root || !condition || !scopeArgument) {
  console.error(
    'Usage: node verify-product-run.mjs ROOT CONDITION SCOPE[,SCOPE...]',
  );
  process.exitCode = 2;
} else {
  try {
    await verifyFinalModelProvenance(root);
    const scopes = scopeArgument.split(',').filter(Boolean);
    const report = await verifyProductRuns({ root, condition, scopes });
    console.log(
      JSON.stringify({
        status: 'product-runs-verified',
        condition: report.condition,
        scopes: report.scopes,
      }),
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Product run integrity verification failed',
    );
    process.exitCode = 1;
  }
}
