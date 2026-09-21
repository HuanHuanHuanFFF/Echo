import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  runtimeContext,
  boundedRequest,
  qasperScore,
} from './lib/public-runtime.mjs';
import { jsonLines, digest } from './prepare-public-benchmarks.mjs';
const root = path.resolve(process.argv[2] ?? ''),
  phase = process.argv[3];
assert.ok(process.argv[2] && ['configure', 'index', 'run'].includes(phase));
const ctx = await runtimeContext(root);
try {
  const dir = path.join(root, 'qasper');
  if (phase === 'configure') {
    await fs.mkdir(dir);
    for (const p of [
      'chunkers',
      'tokenizers',
      'config/embedding',
      'config/retrieval',
    ])
      await fs.mkdir(path.join(dir, p), { recursive: true });
    const { headingStrategy, defaultTokenizer } = await ctx.load('profiles');
    await fs.writeFile(
      path.join(dir, 'chunkers/heading-1000.mjs'),
      headingStrategy(1000),
    );
    await fs.copyFile(
      new URL(
        '../examples/profiles/chunkers/markdown-structure-v1.mjs',
        import.meta.url,
      ),
      path.join(dir, 'chunkers/markdown-structure-v1.mjs'),
    );
    await fs.writeFile(
      path.join(dir, 'tokenizers/icu-zh.mjs'),
      defaultTokenizer,
    );
    const put = (name, obj) =>
      fs.writeFile(path.join(dir, name), JSON.stringify(obj, null, 2) + '\n', {
        flag: 'wx',
      });
    await put('config/embedding/qwen.json', { id: 'qwen', ...ctx.plan.config });
    await put('config/sources.json', {
      collections: [{ id: 'qasper', root: path.join(root, 'prepared/notes') }],
    });
    await put('config/runtime.json', {
      search_timeout_ms: 120000,
      max_concurrent_searches: 2,
      sqlite_busy_timeout_ms: 5000,
    });
    await put('config/logging.json', { level: 'off' });
    for (const k of [30, 10])
      await put('config/retrieval/rrf' + k + '.json', {
        id: 'rrf' + k,
        ...ctx.parseConfig({}).retrieval,
        rrf_k: k,
      });
    for (const [arm, strategy, k] of [
      ['p0', 'heading-1000', 30],
      ['p1', 'markdown-structure-v1', 30],
      ['p2', 'markdown-structure-v1', 10],
    ]) {
      await put(arm + '.json', {
        version: 2,
        database:
          strategy === 'heading-1000' ? 'heading.sqlite' : 'structure.sqlite',
        active: {
          chunker: strategy,
          tokenizer: 'icu-zh',
          embedding: 'qwen',
          retrieval: 'rrf' + k,
        },
      });
    }
    console.log('QASPER_CONFIGURED');
  } else if (phase === 'index') {
    const { syncIndex } = await ctx.load('sync');
    for (const arm of ['p0', 'p1']) {
      const config = await ctx.loadConfig(path.join(dir, arm + '.json'));
      const receipt = await syncIndex(config, undefined, ctx.provider);
      assert.equal(receipt.status, 'ok');
      assert.equal(receipt.wrote_ids, 0);
      await fs.writeFile(
        path.join(dir, arm + '-sync.json'),
        JSON.stringify(receipt, null, 2) + '\n',
      );
      console.log(JSON.stringify({ arm, ...receipt }));
    }
  } else {
    const docs = new Map();
    for await (const d of jsonLines(
      path.join(root, 'prepared/qasper-docs.jsonl'),
    ))
      docs.set(d.id, { ...d, markdown: await fs.readFile(d.file, 'utf8') });
    const queries = [];
    for await (const q of jsonLines(
      path.join(root, 'prepared/qasper-queries.jsonl'),
    ))
      queries.push(q);
    assert.equal(queries.length, 1005);
    for (const arm of ['p0', 'p1', 'p2']) {
      const config = await ctx.loadConfig(path.join(dir, arm + '.json'));
      const before = digest(await fs.readFile(config.database));
      const destination = path.join(dir, arm + '-results.jsonl');
      const file = await fs.open(destination, 'wx');
      const values = [];
      let n = 0;
      try {
        for (const q of queries) {
          const request = boundedRequest(q.text, q.source_id);
          const started = performance.now();
          const result = await ctx.searchIndex(
            config,
            request,
            undefined,
            ctx.provider,
          );
          const ms = performance.now() - started;
          assert.equal(result.status, 'ok');
          const requestChars = JSON.stringify(request).length,
            responseChars = JSON.stringify(result).length;
          assert.ok(requestChars + responseChars <= 16000);
          const doc = docs.get(q.paper_id);
          const score = qasperScore(q, doc, result, doc.markdown);
          const row = {
            id: q.id,
            paper_id: q.paper_id,
            request,
            result,
            request_chars: requestChars,
            response_chars: responseChars,
            offline_ms: ms,
            score,
          };
          await file.write(JSON.stringify(row) + '\n');
          values.push(score);
          n++;
          if (n % 100 === 0)
            console.log(
              JSON.stringify({ arm, completed: n, total: queries.length }),
            );
        }
      } finally {
        await file.close();
      }
      assert.equal(digest(await fs.readFile(config.database)), before);
      const eligible = values.filter((x) => x.eligible);
      const summary = {
        arm,
        questions: n,
        eligible: eligible.length,
        complete: eligible.filter((x) => x.strict_complete).length,
        coverage_macro:
          eligible.reduce((s, x) => s + x.strict_coverage, 0) / eligible.length,
        full1005_evidence_f1:
          values.reduce((s, x) => s + x.official_formula_evidence_f1, 0) / n,
        index_sha256: before,
        results_sha256: digest(await fs.readFile(destination)),
      };
      await fs.writeFile(
        path.join(dir, arm + '-summary.json'),
        JSON.stringify(summary, null, 2) + '\n',
      );
      console.log(JSON.stringify(summary));
    }
  }
} finally {
  ctx.cache.close();
}
