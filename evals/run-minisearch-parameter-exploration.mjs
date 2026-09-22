import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';

import { embeddingFingerprint, validateVectors } from '../dist/embedding.js';
import { parseConfig } from '../dist/config.js';
import { openDatabase } from '../dist/database.js';
import { tokenize } from '../dist/lexical.js';
import { prepareMiniIndex } from '../dist/minisearch.js';
import { packResults, retrieveQuery } from '../dist/retrieval.js';
import { qasperScore } from './lib/public-runtime.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const compact = (value) => JSON.stringify(value);
const shaText = (value) => createHash('sha256').update(value).digest('hex');

function makeOtherParamArm(id, retrieval, reason, tuning = {}) {
  return Object.freeze({
    id,
    minisearch_k: tuning.minisearch_k ?? 1.2,
    minisearch_b: tuning.minisearch_b ?? 0.7,
    minisearch_d: tuning.minisearch_d ?? 0.5,
    bm25_weight: tuning.bm25_weight ?? 0.31,
    dense_weight: tuning.dense_weight ?? 1,
    rrf_k: tuning.rrf_k ?? 10,
    retrieval: Object.freeze(retrieval),
    reason,
  });
}

async function shaFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function* jsonLines(file) {
  let pending = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (pending.trim()) yield JSON.parse(pending);
}

async function readJsonLines(file) {
  const rows = [];
  for await (const row of jsonLines(file)) rows.push(row);
  return rows;
}

async function writeJson(file, value, flag = 'wx') {
  await fs.writeFile(file, json(value), { flag });
}

async function writeJsonLines(file, rows) {
  const handle = await fs.open(file, 'wx');
  try {
    for (const row of rows) await handle.write(JSON.stringify(row) + '\n');
  } finally {
    await handle.close();
  }
}

const arms = Object.freeze({
  'default20-cap5': makeOtherParamArm(
    'default20-cap5',
    { max_chunks_per_source: 5, max_context_chars: 20000 },
    '固定当前默认BM25=0.5、dense=1、RRF10、预算20000，补测cap5。',
    { bm25_weight: 0.5 },
  ),
  'recall20-cap6': makeOtherParamArm(
    'recall20-cap6',
    { max_chunks_per_source: 6, max_context_chars: 20000 },
    '复测此前BM25=0.31、dense=0.8、RRF5、cap6高召回组合，仅提高累计预算至20000。',
    { bm25_weight: 0.31, dense_weight: 0.8, rrf_k: 5 },
  ),
  'public-A': makeOtherParamArm(
    'public-A',
    { max_chunks_per_source: 6, max_context_chars: 20000 },
    '公开全量主臂A：新综合1.0.1、MiniSearch无匹配词乘数、BM25=0.5、dense=1、RRF10、cap6、预算20000。',
    { bm25_weight: 0.5, dense_weight: 1, rrf_k: 10 },
  ),
  'public-B': makeOtherParamArm(
    'public-B',
    { max_chunks_per_source: 6, max_context_chars: 20000 },
    '公开全量主臂B：除BM25=0.31、dense=0.8、RRF5外与公开全量主臂A相同。',
    { bm25_weight: 0.31, dense_weight: 0.8, rrf_k: 5 },
  ),
  'default20-cap3': makeOtherParamArm(
    'default20-cap3',
    { max_chunks_per_source: 3, max_context_chars: 20000 },
    '当前产品默认：BM25=0.5、dense=1、RRF10、预算20000、cap3。',
    { bm25_weight: 0.5 },
  ),
  'default20-cap6': makeOtherParamArm(
    'default20-cap6',
    { max_chunks_per_source: 6, max_context_chars: 20000 },
    '固定当前产品其他默认，只将cap3提高到cap6。',
    { bm25_weight: 0.5 },
  ),
  default: Object.freeze({
    id: 'default',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    bm25_weight: 0.5,
    dense_weight: 1,
    rrf_k: 10,
    reason: '当前产品默认；本轮完整对照。',
  }),
  rrf30: Object.freeze({
    id: 'rrf30',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    bm25_weight: 0.5,
    dense_weight: 1,
    rrf_k: 30,
    reason: '只改变 RRF k，检验更平缓的名次衰减；与当前 RRF10 可归因。',
  }),
  bm25w04: Object.freeze({
    id: 'bm25w04',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    bm25_weight: 0.4,
    dense_weight: 1,
    rrf_k: 10,
    reason:
      '只降低 BM25 融合权重到 0.4，作为此前 0.5 与更偏 dense 条件之间的折中。',
  }),
  bm25w025: Object.freeze({
    id: 'bm25w025',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    bm25_weight: 0.25,
    dense_weight: 1,
    rrf_k: 10,
    reason: '只降低 BM25 融合权重到 0.25，观察更强 dense 主导下的取舍。',
  }),
  k084: Object.freeze({
    id: 'k084',
    minisearch_k: 0.84,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    bm25_weight: 0.5,
    dense_weight: 1,
    rrf_k: 10,
    reason:
      '只把 MiniSearch k 降低 30%，复用此前单变量条件并扩展到 200＋331 主集。',
  }),
  d10: Object.freeze({
    id: 'd10',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 1,
    bm25_weight: 0.5,
    dense_weight: 1,
    rrf_k: 10,
    reason:
      '只把 MiniSearch d 从 0.5 提到 1.0；该评分轴尚未在上一批公开样本中测量。',
  }),
  bm25w023: Object.freeze({
    id: 'bm25w023',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    bm25_weight: 0.23,
    dense_weight: 1,
    rrf_k: 10,
    reason: '只降低 BM25 融合权重到 0.23，细化 0.25 附近的候选。',
  }),
  bm25w017: Object.freeze({
    id: 'bm25w017',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    bm25_weight: 0.17,
    dense_weight: 1,
    rrf_k: 10,
    reason: '只降低 BM25 融合权重到 0.17，测试更强 dense 主导是否继续改善。',
  }),
  bm25w029: Object.freeze({
    id: 'bm25w029',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    bm25_weight: 0.29,
    dense_weight: 1,
    rrf_k: 10,
    reason: '只降低 BM25 融合权重到 0.29，连接 0.25 与 0.4 两侧的候选。',
  }),
  bm25w031: Object.freeze({
    id: 'bm25w031',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    bm25_weight: 0.31,
    dense_weight: 1,
    rrf_k: 10,
    reason: '只提高 BM25 融合权重到 0.31，细化 0.29 与 0.4 之间的区间。',
  }),
  bm25w037: Object.freeze({
    id: 'bm25w037',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    bm25_weight: 0.37,
    dense_weight: 1,
    rrf_k: 10,
    reason: '只提高 BM25 融合权重到 0.37，靠近 0.4 折中候选。',
  }),
  bm25w043: Object.freeze({
    id: 'bm25w043',
    minisearch_k: 1.2,
    minisearch_b: 0.7,
    minisearch_d: 0.5,
    bm25_weight: 0.43,
    dense_weight: 1,
    rrf_k: 10,
    reason: '只提高 BM25 融合权重到 0.43，观察接近当前0.5时的回升曲线。',
  }),
  'bm25w031-cap4': makeOtherParamArm(
    'bm25w031-cap4',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31、RRF=10，只把每篇上限从3调到4。',
  ),
  'bm25w031-cap5': makeOtherParamArm(
    'bm25w031-cap5',
    { max_chunks_per_source: 5 },
    '固定 BM25=0.31、RRF=10，只把每篇上限从3调到5。',
  ),
  'bm25w031-sim02': makeOtherParamArm(
    'bm25w031-sim02',
    { min_dense_similarity: 0.2 },
    '固定 BM25=0.31、RRF=10，只把最低余弦相似度降到0.2。',
  ),
  'bm25w031-sim04': makeOtherParamArm(
    'bm25w031-sim04',
    { min_dense_similarity: 0.4 },
    '固定 BM25=0.31、RRF=10，只把最低余弦相似度升到0.4。',
  ),
  'bm25w031-title1': makeOtherParamArm(
    'bm25w031-title1',
    { title_weight: 1 },
    '固定 BM25=0.31、RRF=10，只把标题权重降到1。',
  ),
  'bm25w031-title3': makeOtherParamArm(
    'bm25w031-title3',
    { title_weight: 3 },
    '固定 BM25=0.31、RRF=10，只把标题权重升到3。',
  ),
  'bm25w031-budget20': makeOtherParamArm(
    'bm25w031-budget20',
    { max_context_chars: 20000 },
    '固定 BM25=0.31、RRF=10，只把检索结果预算升到20000字符。',
  ),
  'bm25w031-budget24': makeOtherParamArm(
    'bm25w031-budget24',
    { max_context_chars: 24000 },
    '固定 BM25=0.31、RRF=10，只把检索结果预算升到24000字符。',
  ),
  'bm25w031-topk12': makeOtherParamArm(
    'bm25w031-topk12',
    { topk: 12 },
    '固定 BM25=0.31、RRF=10，只把最终 topk 升到12。',
  ),
  'bm25w031-topk15': makeOtherParamArm(
    'bm25w031-topk15',
    { topk: 15 },
    '固定 BM25=0.31、RRF=10，只把最终 topk 升到15。',
  ),
  'bm25w031-cap4-budget20': makeOtherParamArm(
    'bm25w031-cap4-budget20',
    { max_chunks_per_source: 4, max_context_chars: 20000 },
    '固定 BM25=0.31、RRF=10，把每篇上限调到4、预算调到20000。',
  ),
  'bm25w031-cap4-budget24': makeOtherParamArm(
    'bm25w031-cap4-budget24',
    { max_chunks_per_source: 4, max_context_chars: 24000 },
    '固定 BM25=0.31、RRF=10，把每篇上限调到4、预算调到24000。',
  ),
  'bm25w031-cap5-budget20': makeOtherParamArm(
    'bm25w031-cap5-budget20',
    { max_chunks_per_source: 5, max_context_chars: 20000 },
    '固定 BM25=0.31、RRF=10，把每篇上限调到5、预算调到20000。',
  ),
  'bm25w031-cap5-budget24': makeOtherParamArm(
    'bm25w031-cap5-budget24',
    { max_chunks_per_source: 5, max_context_chars: 24000 },
    '固定 BM25=0.31、RRF=10，把每篇上限调到5、预算调到24000。',
  ),
  'bm25w031-cap4-topk12': makeOtherParamArm(
    'bm25w031-cap4-topk12',
    { max_chunks_per_source: 4, topk: 12 },
    '固定 BM25=0.31、RRF=10，把每篇上限调到4、topk调到12。',
  ),
  'bm25w031-cap4-topk15': makeOtherParamArm(
    'bm25w031-cap4-topk15',
    { max_chunks_per_source: 4, topk: 15 },
    '固定 BM25=0.31、RRF=10，把每篇上限调到4、topk调到15。',
  ),
  'bm25w031-cap5-topk12': makeOtherParamArm(
    'bm25w031-cap5-topk12',
    { max_chunks_per_source: 5, topk: 12 },
    '固定 BM25=0.31、RRF=10，把每篇上限调到5、topk调到12。',
  ),
  'bm25w031-cap5-topk15': makeOtherParamArm(
    'bm25w031-cap5-topk15',
    { max_chunks_per_source: 5, topk: 15 },
    '固定 BM25=0.31、RRF=10，把每篇上限调到5、topk调到15。',
  ),
  'bm25w031-cap4-bm100': makeOtherParamArm(
    'bm25w031-cap4-bm100',
    { max_chunks_per_source: 4, bm25_candidates: 100 },
    '固定 BM25=0.31、RRF=10，把 cap 调到4、BM25候选调到100。',
  ),
  'bm25w031-cap4-dense100': makeOtherParamArm(
    'bm25w031-cap4-dense100',
    { max_chunks_per_source: 4, dense_candidates: 100 },
    '固定 BM25=0.31、RRF=10，把 cap 调到4、dense候选调到100。',
  ),
  'bm25w031-cap4-both100': makeOtherParamArm(
    'bm25w031-cap4-both100',
    { max_chunks_per_source: 4, bm25_candidates: 100, dense_candidates: 100 },
    '固定 BM25=0.31、RRF=10，把 cap 调到4、两路候选都调到100。',
  ),
  'bm25w031-cap5-both100': makeOtherParamArm(
    'bm25w031-cap5-both100',
    { max_chunks_per_source: 5, bm25_candidates: 100, dense_candidates: 100 },
    '固定 BM25=0.31、RRF=10，把 cap 调到5、两路候选都调到100。',
  ),
  'bm25w031-cap4-k084': makeOtherParamArm(
    'bm25w031-cap4-k084',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31、RRF=10，把 cap 调到4、MiniSearch k 调到0.84。',
    { minisearch_k: 0.84 },
  ),
  'bm25w031-cap4-k16': makeOtherParamArm(
    'bm25w031-cap4-k16',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31、RRF=10，把 cap 调到4、MiniSearch k 调到1.6。',
    { minisearch_k: 1.6 },
  ),
  'bm25w031-cap4-b04': makeOtherParamArm(
    'bm25w031-cap4-b04',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31、RRF=10，把 cap 调到4、MiniSearch b 调到0.4。',
    { minisearch_b: 0.4 },
  ),
  'bm25w031-cap4-b10': makeOtherParamArm(
    'bm25w031-cap4-b10',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31、RRF=10，把 cap 调到4、MiniSearch b 调到1.0。',
    { minisearch_b: 1 },
  ),
  'bm25w031-cap4-d025': makeOtherParamArm(
    'bm25w031-cap4-d025',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31、RRF=10，把 cap 调到4、MiniSearch d 调到0.25。',
    { minisearch_d: 0.25 },
  ),
  'bm25w031-cap4-d10': makeOtherParamArm(
    'bm25w031-cap4-d10',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31、RRF=10，把 cap 调到4、MiniSearch d 调到1.0。',
    { minisearch_d: 1 },
  ),
  'bm25w031-cap4-dw08': makeOtherParamArm(
    'bm25w031-cap4-dw08',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31、RRF=10，把 cap 调到4、dense权重调到0.8。',
    { dense_weight: 0.8 },
  ),
  'bm25w031-cap4-dw12': makeOtherParamArm(
    'bm25w031-cap4-dw12',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31、RRF=10，把 cap 调到4、dense权重调到1.2。',
    { dense_weight: 1.2 },
  ),
  'bm25w031-cap4-rrf05': makeOtherParamArm(
    'bm25w031-cap4-rrf05',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31，把 cap 调到4、RRF k 调到5。',
    { rrf_k: 5 },
  ),
  'bm25w031-cap4-rrf15': makeOtherParamArm(
    'bm25w031-cap4-rrf15',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31，把 cap 调到4、RRF k 调到15。',
    { rrf_k: 15 },
  ),
  'bm25w031-cap5-rrf05': makeOtherParamArm(
    'bm25w031-cap5-rrf05',
    { max_chunks_per_source: 5 },
    '固定 BM25=0.31，把 cap 调到5、RRF k 调到5。',
    { rrf_k: 5 },
  ),
  'bm25w031-cap5-rrf15': makeOtherParamArm(
    'bm25w031-cap5-rrf15',
    { max_chunks_per_source: 5 },
    '固定 BM25=0.31，把 cap 调到5、RRF k 调到15。',
    { rrf_k: 15 },
  ),
  'bm25w031-cap4-rrf05-dw08': makeOtherParamArm(
    'bm25w031-cap4-rrf05-dw08',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31，把 cap 调到4、RRF k 调到5、dense权重调到0.8。',
    { rrf_k: 5, dense_weight: 0.8 },
  ),
  'bm25w031-cap4-rrf15-dw08': makeOtherParamArm(
    'bm25w031-cap4-rrf15-dw08',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31，把 cap 调到4、RRF k 调到15、dense权重调到0.8。',
    { rrf_k: 15, dense_weight: 0.8 },
  ),
  'bm25w031-cap4-rrf05-dw12': makeOtherParamArm(
    'bm25w031-cap4-rrf05-dw12',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31，把 cap 调到4、RRF k 调到5、dense权重调到1.2。',
    { rrf_k: 5, dense_weight: 1.2 },
  ),
  'bm25w031-cap4-rrf15-dw12': makeOtherParamArm(
    'bm25w031-cap4-rrf15-dw12',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31，把 cap 调到4、RRF k 调到15、dense权重调到1.2。',
    { rrf_k: 15, dense_weight: 1.2 },
  ),
  'bm25w031-cap6-rrf05': makeOtherParamArm(
    'bm25w031-cap6-rrf05',
    { max_chunks_per_source: 6 },
    '固定 BM25=0.31，把 cap 调到6、RRF k 调到5。',
    { rrf_k: 5 },
  ),
  'bm25w031-cap6-rrf10': makeOtherParamArm(
    'bm25w031-cap6-rrf10',
    { max_chunks_per_source: 6 },
    '固定 BM25=0.31，把 cap 调到6、RRF k 保持10。',
  ),
  'bm25w031-cap6-rrf15': makeOtherParamArm(
    'bm25w031-cap6-rrf15',
    { max_chunks_per_source: 6 },
    '固定 BM25=0.31，把 cap 调到6、RRF k 调到15。',
    { rrf_k: 15 },
  ),
  'bm25w031-cap6-rrf05-dw08': makeOtherParamArm(
    'bm25w031-cap6-rrf05-dw08',
    { max_chunks_per_source: 6 },
    '固定 BM25=0.31，把 cap 调到6、RRF k 调到5、dense权重调到0.8。',
    { rrf_k: 5, dense_weight: 0.8 },
  ),
  'bm25w031-cap6-rrf15-dw08': makeOtherParamArm(
    'bm25w031-cap6-rrf15-dw08',
    { max_chunks_per_source: 6 },
    '固定 BM25=0.31，把 cap 调到6、RRF k 调到15、dense权重调到0.8。',
    { rrf_k: 15, dense_weight: 0.8 },
  ),
  'bm25w031-cap6-rrf15-dw12': makeOtherParamArm(
    'bm25w031-cap6-rrf15-dw12',
    { max_chunks_per_source: 6 },
    '固定 BM25=0.31，把 cap 调到6、RRF k 调到15、dense权重调到1.2。',
    { rrf_k: 15, dense_weight: 1.2 },
  ),
  'bm25w031-cap6-budget20': makeOtherParamArm(
    'bm25w031-cap6-budget20',
    { max_chunks_per_source: 6, max_context_chars: 20000 },
    '固定 BM25=0.31，把 cap 调到6、预算调到20000。',
  ),
  'bm25w031-cap6-budget24': makeOtherParamArm(
    'bm25w031-cap6-budget24',
    { max_chunks_per_source: 6, max_context_chars: 24000 },
    '固定 BM25=0.31，把 cap 调到6、预算调到24000。',
  ),
  'bm25w031-cap6-topk12': makeOtherParamArm(
    'bm25w031-cap6-topk12',
    { max_chunks_per_source: 6, topk: 12 },
    '固定 BM25=0.31，把 cap 调到6、topk调到12。',
  ),
  'bm25w031-cap6-topk15': makeOtherParamArm(
    'bm25w031-cap6-topk15',
    { max_chunks_per_source: 6, topk: 15 },
    '固定 BM25=0.31，把 cap 调到6、topk调到15。',
  ),
  'bm25w031-cap3-rrf15-dw08': makeOtherParamArm(
    'bm25w031-cap3-rrf15-dw08',
    { max_chunks_per_source: 3 },
    '固定 BM25=0.31，组合 cap3、RRF k=15、dense权重0.8。',
    { rrf_k: 15, dense_weight: 0.8 },
  ),
  'bm25w031-cap3-rrf05-dw12': makeOtherParamArm(
    'bm25w031-cap3-rrf05-dw12',
    { max_chunks_per_source: 3 },
    '固定 BM25=0.31，组合 cap3、RRF k=5、dense权重1.2。',
    { rrf_k: 5, dense_weight: 1.2 },
  ),
  'bm25w031-cap5-rrf05-dw08': makeOtherParamArm(
    'bm25w031-cap5-rrf05-dw08',
    { max_chunks_per_source: 5 },
    '固定 BM25=0.31，组合 cap5、RRF k=5、dense权重0.8。',
    { rrf_k: 5, dense_weight: 0.8 },
  ),
  'bm25w031-cap5-rrf15-dw08': makeOtherParamArm(
    'bm25w031-cap5-rrf15-dw08',
    { max_chunks_per_source: 5 },
    '固定 BM25=0.31，组合 cap5、RRF k=15、dense权重0.8。',
    { rrf_k: 15, dense_weight: 0.8 },
  ),
  'bm25w031-cap5-rrf15-dw12': makeOtherParamArm(
    'bm25w031-cap5-rrf15-dw12',
    { max_chunks_per_source: 5 },
    '固定 BM25=0.31，组合 cap5、RRF k=15、dense权重1.2。',
    { rrf_k: 15, dense_weight: 1.2 },
  ),
  'bm25w031-cap4-k16-rrf05-dw08': makeOtherParamArm(
    'bm25w031-cap4-k16-rrf05-dw08',
    { max_chunks_per_source: 4 },
    '固定 BM25=0.31，组合 cap4、k=1.6、RRF k=5、dense权重0.8。',
    { minisearch_k: 1.6, rrf_k: 5, dense_weight: 0.8 },
  ),
});
const extensionArmIds = ['bm25w023', 'bm25w017', 'bm25w029'];
const extension2ArmIds = ['bm25w031', 'bm25w037', 'bm25w043'];
const otherParamsArmIds = [
  'bm25w031',
  'bm25w031-cap4',
  'bm25w031-cap5',
  'bm25w031-sim02',
  'bm25w031-sim04',
  'bm25w031-title1',
  'bm25w031-title3',
  'bm25w031-budget20',
  'bm25w031-budget24',
  'bm25w031-topk12',
  'bm25w031-topk15',
];
const combinationArmIds = [
  'bm25w031-cap4-budget20',
  'bm25w031-cap4-budget24',
  'bm25w031-cap5-budget20',
  'bm25w031-cap5-budget24',
  'bm25w031-cap4-topk12',
  'bm25w031-cap4-topk15',
  'bm25w031-cap5-topk12',
  'bm25w031-cap5-topk15',
];
const deepArmIds = [
  'bm25w031-cap4-bm100',
  'bm25w031-cap4-dense100',
  'bm25w031-cap4-both100',
  'bm25w031-cap5-both100',
  'bm25w031-cap4-k084',
  'bm25w031-cap4-k16',
  'bm25w031-cap4-b04',
  'bm25w031-cap4-b10',
  'bm25w031-cap4-d025',
  'bm25w031-cap4-d10',
  'bm25w031-cap4-dw08',
  'bm25w031-cap4-dw12',
];
const rrfArmIds = [
  'bm25w031-cap4-rrf05',
  'bm25w031-cap4-rrf15',
  'bm25w031-cap5-rrf05',
  'bm25w031-cap5-rrf15',
  'bm25w031-cap4-rrf05-dw08',
  'bm25w031-cap4-rrf15-dw08',
  'bm25w031-cap4-rrf05-dw12',
  'bm25w031-cap4-rrf15-dw12',
];
const cap6ArmIds = [
  'bm25w031-cap6-rrf05',
  'bm25w031-cap6-rrf10',
  'bm25w031-cap6-rrf15',
  'bm25w031-cap6-rrf05-dw08',
  'bm25w031-cap6-rrf15-dw08',
  'bm25w031-cap6-rrf15-dw12',
];
const cap6PlusArmIds = [
  'bm25w031-cap6-budget20',
  'bm25w031-cap6-budget24',
  'bm25w031-cap6-topk12',
  'bm25w031-cap6-topk15',
];
const finalCombinationArmIds = [
  'bm25w031',
  'bm25w031-cap3-rrf15-dw08',
  'bm25w031-cap3-rrf05-dw12',
  'bm25w031-cap4-rrf05',
  'bm25w031-cap4-rrf15-dw08',
  'bm25w031-cap4-rrf05-dw12',
  'bm25w031-cap5-rrf05',
  'bm25w031-cap5-rrf05-dw08',
  'bm25w031-cap5-rrf15-dw08',
  'bm25w031-cap5-rrf15-dw12',
  'bm25w031-cap6-rrf05',
  'bm25w031-cap6-rrf05-dw08',
  'bm25w031-cap6-rrf10',
  'bm25w031-cap4-k16-rrf05-dw08',
];
const budget20CapArmIds = ['default20-cap3', 'default20-cap6'];
const budget20FollowupArmIds = ['default20-cap5', 'recall20-cap6'];
const publicFullArmIds = ['public-A', 'public-B'];
const historicalArmIds = Object.keys(arms).filter(
  (id) =>
    ![
      ...budget20CapArmIds,
      ...budget20FollowupArmIds,
      ...publicFullArmIds,
    ].includes(id),
);
let armIds = historicalArmIds;
const defaultArm = arms.default;
const fixedRetrieval = Object.freeze({
  lexical_engine: 'minisearch',
  topk: 10,
  max_chunks_per_source: 3,
  bm25_candidates: 60,
  dense_candidates: 60,
  title_weight: 2,
  dense_weight: 1,
  min_dense_similarity: 0.3,
  max_context_chars: 16000,
});
const PRIVATE_SCOPE_ORDER = [
  'A-test',
  'B-test',
  'C-test',
  'D-test',
  'mixed-test',
];
const PRIVATE_SCOPE_INFO = {
  'A-test': { db: 'A-development.sqlite', dataset: 'A-test.dataset.json' },
  'B-test': { db: 'B-development.sqlite', dataset: 'B-test.dataset.json' },
  'C-test': { db: 'C-development.sqlite', dataset: 'C-test.dataset.json' },
  'D-test': { db: 'D-test.sqlite', dataset: 'D-test.dataset.json' },
  'mixed-test': { db: 'mixed-test.sqlite', dataset: 'mixed-test.dataset.json' },
  'paired-test': {
    db: 'mixed-test.sqlite',
    dataset: 'paired-test.dataset.json',
  },
};
const PUBLIC_SCOPES = ['langchain', 'godot', 'du', 'qasper'];

function privatePaths(root, scope) {
  const finalRoot = path.join(
    root,
    'evidence',
    'final-four-arms-2026-09-18-v3',
  );
  const dbRoot = path.join(root, '.echo');
  const db = ['A-test', 'B-test', 'C-test'].includes(scope)
    ? path.join(
        dbRoot,
        'structure-ab-2026-09-17-v3',
        PRIVATE_SCOPE_INFO[scope].db.replace('-test', '-development'),
      )
    : path.join(
        dbRoot,
        'final-four-arms-2026-09-18-v3',
        PRIVATE_SCOPE_INFO[scope].db,
      );
  return {
    db,
    dataset: path.join(
      root,
      'evidence',
      'frozen-evaluation-2026-09-16-v1',
      PRIVATE_SCOPE_INFO[scope].dataset,
    ),
    config: path.join(finalRoot, 'configs', `${scope}-structure-hybrid.json`),
    finalRoot,
  };
}

function publicPaths(root, scope) {
  if (scope === 'qasper') {
    return {
      db: path.join(root, 'qasper', 'structure.sqlite'),
      queries: path.join(root, 'prepared', 'qasper-queries.jsonl'),
      docs: path.join(root, 'prepared', 'qasper-docs.jsonl'),
    };
  }
  const stem = scope === 'du' ? 'du' : `freshstack-${scope}`;
  return {
    db: path.join(root, 'fixed', `${scope}.sqlite`),
    queries: path.join(root, 'data', `${stem}-queries.jsonl`),
    corpus: path.join(root, 'data', `${stem}-corpus.jsonl`),
  };
}

function quoteName(name) {
  assert.match(name, /^[a-z][a-z0-9_]*$/);
  return `"${name}"`;
}

function tableCount(db, table) {
  return db.prepare(`SELECT count(*) AS n FROM ${quoteName(table)}`).get().n;
}

function discoverTables(db) {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .pluck()
    .all();
  const candidates = (prefix, internal = false) =>
    names.filter((name) => {
      if (name !== prefix && !name.startsWith(prefix + '_')) return false;
      if (!internal && /_(config|content|data|docsize|idx)$/.test(name))
        return false;
      return true;
    });
  const choose = (prefix) => {
    const list = candidates(prefix);
    assert.ok(list.length, `Missing ${prefix} table`);
    const scored = list
      .map((name) => ({ name, count: tableCount(db, name) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return scored[0].name;
  };
  const sources = choose('sources');
  const chunks = choose('chunks');
  const ftsCandidates = names.includes('chunk_fts')
    ? ['chunk_fts', ...candidates('fts')]
    : candidates('fts');
  const fts = ftsCandidates
    .map((name) => ({ name, count: tableCount(db, name) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0].name;
  const vectorCandidates = candidates('embeddings').concat(candidates('vec'));
  const vectors = vectorCandidates.length
    ? vectorCandidates
        .map((name) => ({ name, count: tableCount(db, name) }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0]
        .name
    : undefined;
  return {
    sources,
    chunks,
    fts,
    ...(vectors ? { vectors } : {}),
    counts: {
      sources: tableCount(db, sources),
      chunks: tableCount(db, chunks),
      fts: tableCount(db, fts),
      vectors: vectors ? tableCount(db, vectors) : 0,
    },
  };
}

function loadSourceRows(db, tables) {
  return db
    .prepare(
      `SELECT source_id,collection_id,path,relative_path,source_version FROM ${quoteName(tables.sources)}`,
    )
    .all();
}

function sourceKey(collection, relative) {
  return JSON.stringify([collection, relative]);
}

async function loadSourceContents(db, tables) {
  const rows = loadSourceRows(db, tables);
  const sources = new Map();
  for (const row of rows) {
    const raw = await fs.readFile(row.path, 'utf8');
    const lines = raw.split('\n');
    sources.set(sourceKey(row.collection_id, row.relative_path), {
      ...row,
      lines,
    });
  }
  return { rows, sources };
}

function makeEmbeddingConfig(raw) {
  const { id: _id, ...settings } = raw;
  return parseConfig({ embedding: settings }).embedding;
}

function createPrivateProvider(cache, fingerprint) {
  return {
    fingerprint,
    dimensions: 1024,
    async embed(texts) {
      return texts.map((text) => {
        const raw = cache.get(text) ?? cache.get(text.trim());
        assert.ok(raw, `Missing frozen private query vector: ${shaText(text)}`);
        return validateVectors([raw], 1, 1024)[0];
      });
    },
  };
}

function createPublicProvider(db, fingerprint) {
  const find = db.prepare(
    'SELECT input,vector,vector_sha FROM entries WHERE key=?',
  );
  const cache = new Map();
  return {
    fingerprint,
    dimensions: 1024,
    async embed(texts, purpose) {
      return texts.map((text) => {
        const cacheKey = `${purpose}\n${text}`;
        if (cache.has(cacheKey)) return cache.get(cacheKey);
        const key = shaText(JSON.stringify([fingerprint, purpose, text]));
        const row = find.get(key);
        assert.ok(
          row?.vector,
          `Missing frozen public vector: ${purpose}:${shaText(text)}`,
        );
        assert.equal(row.input, text);
        assert.equal(shaFileBuffer(row.vector), row.vector_sha);
        const buffer = row.vector;
        const vector = Array.from(
          new Float32Array(
            buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength,
            ),
          ),
        );
        assert.equal(vector.length, 1024);
        cache.set(cacheKey, vector);
        return vector;
      });
    },
  };
}

function shaFileBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function loadPrivateVectorCache(root) {
  const dir = path.join(
    root,
    'evidence',
    'final-four-arms-2026-09-18-v3',
    'capture',
    'responses',
  );
  const cache = new Map();
  for (const file of await fs.readdir(dir)) {
    if (!file.endsWith('.json')) continue;
    const row = await readJson(path.join(dir, file));
    const input = row.request.input[0];
    const vector = row.response.data[0].embedding;
    assert.equal(vector.length, 1024);
    assert.ok(
      !cache.has(input) ||
        JSON.stringify(cache.get(input)) === JSON.stringify(vector),
    );
    cache.set(input, vector);
  }
  return cache;
}

async function makeContext({
  dbPath,
  provider,
  embedding,
  selection,
  loadSources = false,
}) {
  const db = openDatabase(dbPath, { readOnly: true });
  const tables = discoverTables(db);
  assert.ok(tables.vectors, `Missing vector table in ${dbPath}`);
  const index = {
    sources: tables.sources,
    chunks: tables.chunks,
    fts: tables.fts,
    vectors: tables.vectors,
    embeddingFingerprint: provider.fingerprint,
    tokenize: async (text) =>
      tokenize(text, { locale: 'zh-CN', dictionary: [] }),
  };
  const started = performance.now();
  index.mini = await prepareMiniIndex(db, index);
  const buildMs = performance.now() - started;
  db.exec('BEGIN');
  const sourceInfo = loadSources ? await loadSourceContents(db, tables) : null;
  const config = parseConfig({
    database: dbPath,
    collections: [],
    embedding,
    retrieval: armOptions(defaultArm, 'hybrid'),
  });
  return {
    db,
    dbPath,
    tables,
    index,
    config,
    provider,
    selection,
    sourceInfo,
    buildMs,
    laneCache: new Map(),
  };
}

function closeContext(context) {
  if (context.db.inTransaction) context.db.exec('ROLLBACK');
  context.db.close();
}

function armOptions(arm, mode, responseLimit = 16000) {
  return {
    ...fixedRetrieval,
    ...(arm.retrieval ?? {}),
    mode,
    minisearch_k: arm.minisearch_k,
    minisearch_b: arm.minisearch_b,
    minisearch_d: arm.minisearch_d,
    bm25_weight: arm.bm25_weight,
    dense_weight: arm.dense_weight,
    rrf_k: arm.rrf_k,
    max_context_chars: responseLimit,
  };
}

function filterKey(filters) {
  return compact(filters ?? {});
}

async function lane(context, queryId, text, filters, arm, mode) {
  text = text.trim();
  const options = armOptions(arm, mode);
  // Only final packing limits are irrelevant to candidate generation/scoring.
  // Keep every other effective option in the key, including RRF metadata.
  const {
    topk: _topk,
    max_chunks_per_source: _sourceCap,
    max_context_chars: _budget,
    ...candidateOptions
  } = options;
  const key = compact([queryId, text, filterKey(filters), candidateOptions]);
  if (context.laneCache.has(key)) return context.laneCache.get(key);
  const result = await retrieveQuery(
    context.db,
    context.config,
    queryId,
    text,
    filters ?? {},
    options,
    mode === 'dense' ? context.provider : null,
    undefined,
    undefined,
    context.index,
  );
  assert.ok(
    ['ok', 'empty'].includes(result.status),
    `${mode} retrieval failed: ${result.error ?? result.status}`,
  );
  context.laneCache.set(key, result);
  return result;
}

function fuse(queryId, bm25, dense, arm) {
  const merged = new Map();
  const add = (result, laneName, weight) => {
    result.candidates.forEach((candidate, index) => {
      const rank = index + 1;
      let current = merged.get(candidate.evidence.chunk_id);
      if (!current) {
        current = { ...candidate, score: 0 };
        merged.set(candidate.evidence.chunk_id, current);
      }
      current.score += weight / (arm.rrf_k + rank);
      if (laneName === 'bm25') current.bm25_rank = rank;
      else {
        current.dense_rank = rank;
        current.similarity = candidate.similarity;
      }
    });
  };
  add(bm25, 'bm25', arm.bm25_weight);
  add(dense, 'dense', arm.dense_weight);
  const candidates = [...merged.values()].sort(
    (a, b) =>
      b.score - a.score ||
      a.evidence.chunk_id.localeCompare(b.evidence.chunk_id),
  );
  return {
    query_id: queryId,
    status:
      bm25.status === 'empty' && dense.status === 'empty' ? 'empty' : 'ok',
    candidates,
    counts: {
      bm25: bm25.counts.bm25,
      dense: dense.counts.dense,
      fused: candidates.length,
    },
  };
}

async function queryCandidates(context, queryId, text, filters, arm, mode) {
  if (mode === 'bm25')
    return lane(context, queryId, text, filters, arm, 'bm25');
  if (mode === 'dense')
    return lane(context, queryId, text, filters, arm, 'dense');
  const [bm25, dense] = await Promise.all([
    lane(context, queryId, text, filters, arm, 'bm25'),
    lane(context, queryId, text, filters, arm, 'dense'),
  ]);
  return fuse(queryId, bm25, dense, arm);
}

function requestFor(question, budget, responseLimit, filters) {
  const body = question.subquestions
    ? {
        queries: question.subquestions.map(({ id, text }) => ({
          query_id: id,
          text: text.trim(),
        })),
      }
    : { query: question.query.trim() };
  let allowance = Math.min(budget, responseLimit);
  for (let i = 0; i < 5; i++) {
    const request = {
      ...body,
      ...(filters ? { filters } : {}),
      overrides: { max_context_chars: allowance },
    };
    const next = budget - JSON.stringify(request).length;
    if (next >= allowance) return request;
    allowance = next;
  }
  throw new Error('Cannot fit request within budget');
}

async function packed(context, question, arm, mode, filters = {}) {
  const responseBudget = arm.retrieval?.max_context_chars ?? 16000;
  const request = requestFor(
    question,
    responseBudget,
    responseBudget,
    Object.keys(filters).length ? filters : undefined,
  );
  const responseLimit = request.overrides.max_context_chars;
  const options = armOptions(arm, mode, responseLimit);
  const specs = question.subquestions
    ? question.subquestions.map(({ id, text }) => ({ query_id: id, text }))
    : [{ query_id: 'q0', text: question.query }];
  const queries = [];
  for (const spec of specs)
    queries.push(
      await queryCandidates(
        context,
        spec.query_id,
        spec.text,
        filters,
        arm,
        mode,
      ),
    );
  const result = packResults(queries, options, context.selection);
  return {
    request,
    result,
    request_chars: JSON.stringify(request).length,
    response_chars: JSON.stringify(result).length,
  };
}

function evidenceValid(evidence, sourceInfo) {
  const source = sourceInfo.sources.get(
    sourceKey(evidence.collection_id, evidence.relative_path),
  );
  assert.ok(
    source,
    `Missing source ${evidence.collection_id}/${evidence.relative_path}`,
  );
  assert.equal(evidence.source_id, source.source_id);
  assert.equal(evidence.source_version, source.source_version);
  assert.ok(evidence.start_line <= evidence.end_line);
  assert.ok(
    evidence.start_line > 0 && evidence.end_line <= source.lines.length,
  );
  assert.equal(
    source.lines.slice(evidence.start_line - 1, evidence.end_line).join('\n'),
    evidence.text,
  );
}

function factCovered(fact, resultPieces, sourceInfo) {
  return fact.evidence.some((anchor) => {
    const source = sourceInfo.sources.get(
      sourceKey(anchor.collection_id, anchor.path),
    );
    if (!source) return false;
    const matching = resultPieces.filter(
      (piece) =>
        piece.collection_id === anchor.collection_id &&
        piece.relative_path === anchor.path,
    );
    for (let line = anchor.start_line; line <= anchor.end_line; line++)
      if (
        source.lines[line - 1]?.trim() &&
        !matching.some(
          (piece) => piece.start_line <= line && piece.end_line >= line,
        )
      )
        return false;
    return true;
  });
}

function coveredFacts(dataset, question, pieces, sourceInfo) {
  for (const piece of pieces) evidenceValid(piece, sourceInfo);
  return question.required_facts.filter((id) =>
    factCovered(
      dataset.facts.find((fact) => fact.id === id),
      pieces,
      sourceInfo,
    ),
  );
}

function privateRow(dataset, question, packedResult, mode) {
  const covered = packedResult.covered_facts;
  const result = packedResult.result;
  const first = question.no_answer
    ? 0
    : result.results.findIndex(
        (_, index) => packedResult.covered_prefixes[index] > 0,
      ) + 1;
  const counts = new Map();
  for (const piece of result.results)
    counts.set(piece.source_id, (counts.get(piece.source_id) ?? 0) + 1);
  return {
    query_id: question.id,
    intent_group: question.intent_group,
    type: question.type,
    mode,
    status: result.status,
    expected_facts: question.required_facts,
    covered_facts: covered,
    subquery_coverage: (question.subquestions ?? []).map((sub) => ({
      query_id: sub.id,
      expected_facts: sub.required_facts,
      covered_facts: result.results
        .filter((piece) => piece.matched_query_ids.includes(sub.id))
        .flatMap((piece) => []),
    })),
    no_answer: question.no_answer,
    request: packedResult.request,
    request_chars: packedResult.request_chars,
    response_chars: packedResult.response_chars,
    context_chars: packedResult.request_chars + packedResult.response_chars,
    first_fact_reciprocal_rank: first ? 1 / first : 0,
    returned_chunks: result.results.length,
    distinct_sources: counts.size,
    max_source_occupancy: counts.size ? Math.max(...counts.values()) : 0,
    excluded: result.excluded,
    result,
  };
}

function summarizePrivateRows(rows) {
  const answerable = rows.filter((row) => !row.no_answer);
  const covered = answerable.reduce(
    (n, row) => n + row.covered_facts.length,
    0,
  );
  const expected = answerable.reduce(
    (n, row) => n + row.expected_facts.length,
    0,
  );
  return {
    questions: rows.length,
    answerable: answerable.length,
    no_answer: rows.length - answerable.length,
    failures: rows.filter(
      (row) => row.status === 'error' || row.status === 'partial_failure',
    ).length,
    complete: `${answerable.filter((row) => row.covered_facts.length === row.expected_facts.length).length}/${answerable.length}`,
    fact_coverage: `${covered}/${expected}`,
    any_fact_hit: `${answerable.filter((row) => row.covered_facts.length > 0).length}/${answerable.length}`,
    no_answer_nonempty: rows.filter(
      (row) => row.no_answer && row.returned_chunks > 0,
    ).length,
    mean_first_fact_reciprocal_rank: answerable.length
      ? answerable.reduce((n, row) => n + row.first_fact_reciprocal_rank, 0) /
        answerable.length
      : 0,
    cumulative_context_chars: rows.reduce((n, row) => n + row.context_chars, 0),
    excluded: rows.reduce(
      (out, row) => {
        for (const key of Object.keys(out)) out[key] += row.excluded[key] ?? 0;
        return out;
      },
      { source_limit: 0, duplicate: 0, budget: 0, topk: 0 },
    ),
  };
}

function addCoveredPrefixes(rows, dataset, sourceInfo) {
  for (const row of rows) {
    const question = dataset.questions.find((q) => q.id === row.query_id);
    row.covered_facts = coveredFacts(
      dataset,
      question,
      row.result.results,
      sourceInfo,
    );
    row.covered_prefixes = row.result.results.map(
      (_, index) =>
        coveredFacts(
          dataset,
          question,
          row.result.results.slice(0, index + 1),
          sourceInfo,
        ).length,
    );
    row.subquery_coverage = (question.subquestions ?? []).map((sub) => ({
      query_id: sub.id,
      expected_facts: sub.required_facts,
      covered_facts: sub.required_facts.filter((factId) => {
        const fact = dataset.facts.find((item) => item.id === factId);
        return factCovered(
          fact,
          row.result.results.filter((piece) =>
            piece.matched_query_ids.includes(sub.id),
          ),
          sourceInfo,
        );
      }),
    }));
    const first = question.no_answer
      ? 0
      : row.result.results.findIndex(
          (_, index) =>
            row.covered_facts.length &&
            coveredFacts(
              dataset,
              question,
              row.result.results.slice(0, index + 1),
              sourceInfo,
            ).length > 0,
        ) + 1;
    row.first_fact_reciprocal_rank = first ? 1 / first : 0;
    delete row.covered_prefixes;
  }
}

async function readPrivateVectorAndSelection(root, scope) {
  const finalRoot = path.join(
    root,
    'evidence',
    'final-four-arms-2026-09-18-v3',
  );
  const plan = await readJson(path.join(finalRoot, 'plan.json'));
  const run = plan.runs.find(
    (item) => item.scope === scope && item.id === 'structure-hybrid',
  );
  assert.ok(run, `Missing final plan run ${scope}`);
  const sourceDb = privatePaths(root, scope).db;
  const db = openDatabase(sourceDb, { readOnly: true });
  const sourceSnapshot = db
    .prepare("SELECT value FROM echo_state WHERE key='corpus'")
    .get()?.value;
  db.close();
  return {
    selection: {
      chunker: 'markdown-structure-v1',
      tokenizer: 'icu-zh',
      embedding: 'qwen3-7-embedding-1024',
      retrieval: 'final-fixed',
      revision: run.config_revision,
      source_snapshot: sourceSnapshot,
    },
  };
}

async function runPrivateScope({
  root,
  out,
  scope,
  provider,
  embedding,
  selection,
  mode,
}) {
  const paths = privatePaths(root, scope);
  const dataset = await readJson(paths.dataset);
  const context = await makeContext({
    dbPath: paths.db,
    provider,
    embedding,
    selection,
    loadSources: true,
  });
  const scopeOut = path.join(out, 'private', scope);
  await fs.mkdir(scopeOut, { recursive: true });
  const labels = {};
  const questionRows = new Map(dataset.questions.map((q) => [q.id, q]));
  const runLabel = async (label, arm, retrievalMode) => {
    const rows = [];
    const started = performance.now();
    for (const question of dataset.questions) {
      const packedResult = await packed(context, question, arm, retrievalMode);
      const row = {
        ...privateRow(
          dataset,
          question,
          { ...packedResult, covered_facts: [], covered_prefixes: [] },
          retrievalMode,
        ),
      };
      rows.push(row);
    }
    addCoveredPrefixes(rows, dataset, context.sourceInfo);
    await writeJsonLines(path.join(scopeOut, `${label}.jsonl`), rows);
    labels[label] = {
      ...summarizePrivateRows(rows),
      elapsed_ms: performance.now() - started,
    };
  };
  if (mode === 'smoke') {
    const question = dataset.questions[0];
    const packedResult = await packed(context, question, defaultArm, 'hybrid');
    evidenceValid(packedResult.result.results[0], context.sourceInfo);
    labels.smoke = {
      query_id: question.id,
      response_chars: packedResult.response_chars,
      returned: packedResult.result.results.length,
      build_ms: context.buildMs,
    };
  } else {
    for (const armId of armIds) {
      const arm = arms[armId];
      await runLabel(`${armId}-hybrid`, arm, 'hybrid');
      await runLabel(`${armId}-bm25`, arm, 'bm25');
    }
    await runLabel('dense-reference', defaultArm, 'dense');
  }
  closeContext(context);
  if (globalThis.gc) globalThis.gc();
  return {
    scope,
    questions: dataset.questions.length,
    labels,
    chunks: context.tables.counts.chunks,
    build_ms: context.buildMs,
  };
}

async function loadPublicQueries(root, scope, freeze) {
  const paths = publicPaths(root, scope);
  const rows = await readJsonLines(paths.queries);
  const ids = freeze.cohorts[scope].ids;
  const byId = new Map(rows.map((row) => [row.query_id ?? row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    assert.ok(row, `Missing public query ${scope}/${id}`);
    return row;
  });
}

function publicQueryText(scope, row) {
  if (scope === 'qasper') return row.text.trim();
  return scope === 'du'
    ? row.text.trim()
    : `${row.query_title} ${row.query_text}`.trim();
}

function publicQueryId(scope, row) {
  return scope === 'qasper' ? row.id : (row.query_id ?? row.id);
}

function publicCorpusId(scope, row) {
  return row._id ?? row.id;
}

function laneExport(result, arm) {
  return result.candidates.map((row, index) => ({
    id: row.evidence.chunk_id,
    rank: index + 1,
    rank_score: result.candidates.length - index,
    rrf_score: row.score,
    bm25_rank: row.bm25_rank ?? null,
    dense_rank: row.dense_rank ?? null,
    similarity: row.similarity ?? null,
    ...(arm ? { arm: arm.id } : {}),
  }));
}

function publicRanking(result, condition, rrfK) {
  return {
    condition,
    rrf_k: rrfK,
    rankings: laneExport(result).map((row) => ({ ...row })),
  };
}

async function runPublicRankingScope({
  root,
  out,
  scope,
  queries,
  provider,
  embedding,
  selection,
  mode,
}) {
  const paths = publicPaths(root, scope);
  const context = await makeContext({
    dbPath: paths.db,
    provider,
    embedding,
    selection,
  });
  const scopeOut = path.join(out, 'public');
  await fs.mkdir(scopeOut, { recursive: true });
  const pools = [];
  const outputs = new Map();
  const writeCondition = async (label, rows) => {
    await writeJsonLines(path.join(scopeOut, `${scope}-${label}.jsonl`), rows);
  };
  const processArm = async (armId) => {
    const arm = arms[armId];
    const bm25Rows = [];
    const hybridRows = [];
    for (const q of queries) {
      const id = publicQueryId(scope, q);
      const text = publicQueryText(scope, q);
      const filters = {};
      const bm = await queryCandidates(context, id, text, filters, arm, 'bm25');
      const den = await queryCandidates(
        context,
        id,
        text,
        filters,
        arm,
        'dense',
      );
      const hy = fuse(id, bm, den, arm);
      bm25Rows.push({ id, ...publicRanking(bm, `${armId}-bm25`, arm.rrf_k) });
      hybridRows.push({
        id,
        ...publicRanking(hy, `${armId}-hybrid`, arm.rrf_k),
      });
      if (!pools.some((item) => item.id === id))
        pools.push({
          id,
          query_terms: await context.index.tokenize(text),
          dense: laneExport(den),
          [armId]: {
            bm25: laneExport(bm),
            dense: laneExport(den),
            hybrid: laneExport(hy),
          },
        });
      else {
        const pool = pools.find((item) => item.id === id);
        pool[armId] = {
          bm25: laneExport(bm),
          dense: laneExport(den),
          hybrid: laneExport(hy),
        };
      }
    }
    await writeCondition(`${armId}-bm25`, bm25Rows);
    await writeCondition(`${armId}-hybrid`, hybridRows);
  };
  if (mode === 'smoke') {
    const q = queries[0];
    const bm = await queryCandidates(
      context,
      publicQueryId(scope, q),
      publicQueryText(scope, q),
      {},
      defaultArm,
      'bm25',
    );
    const den = await queryCandidates(
      context,
      publicQueryId(scope, q),
      publicQueryText(scope, q),
      {},
      defaultArm,
      'dense',
    );
    outputs.set('smoke', {
      id: publicQueryId(scope, q),
      bm25: bm.candidates.length,
      dense: den.candidates.length,
      build_ms: context.buildMs,
    });
  } else {
    for (const armId of armIds) await processArm(armId);
    const denseRows = [];
    for (const q of queries) {
      const id = publicQueryId(scope, q);
      const den = await queryCandidates(
        context,
        id,
        publicQueryText(scope, q),
        {},
        defaultArm,
        'dense',
      );
      denseRows.push({ id, ...publicRanking(den, 'dense', defaultArm.rrf_k) });
    }
    await writeCondition('dense', denseRows);
    await writeJsonLines(
      path.join(scopeOut, `${scope}-candidates.jsonl`),
      pools,
    );
  }
  closeContext(context);
  if (globalThis.gc) globalThis.gc();
  return {
    scope,
    questions: queries.length,
    chunks: context.tables.counts.chunks,
    build_ms: context.buildMs,
    outputs: Object.fromEntries(outputs),
  };
}

async function runQasper({
  root,
  out,
  queries,
  provider,
  embedding,
  selection,
  mode,
}) {
  const paths = publicPaths(root, 'qasper');
  const docs = new Map(
    (await readJsonLines(paths.docs)).map((row) => [row.id, row]),
  );
  const markdownCache = new Map();
  const context = await makeContext({
    dbPath: paths.db,
    provider,
    embedding,
    selection,
  });
  const scopeOut = path.join(out, 'public');
  await fs.mkdir(scopeOut, { recursive: true });
  const labels = {};
  const runLabel = async (label, arm, retrievalMode) => {
    const rows = [];
    for (const q of queries) {
      const id = publicQueryId('qasper', q);
      const doc = docs.get(q.paper_id);
      assert.ok(doc);
      const filters = { source_ids: [q.source_id] };
      const packedResult = await packed(
        context,
        { query: q.text },
        arm,
        retrievalMode,
        filters,
      );
      const markdown = markdownCache.has(q.paper_id)
        ? markdownCache.get(q.paper_id)
        : await fs.readFile(doc.file, 'utf8');
      markdownCache.set(q.paper_id, markdown);
      const score = qasperScore(q, doc, packedResult.result, markdown);
      rows.push({
        id,
        paper_id: q.paper_id,
        condition: label,
        request: packedResult.request,
        result: packedResult.result,
        request_chars: packedResult.request_chars,
        response_chars: packedResult.response_chars,
        score,
      });
    }
    await writeJsonLines(path.join(scopeOut, `qasper-${label}.jsonl`), rows);
    const eligible = rows.filter((row) => row.score.eligible);
    labels[label] = {
      questions: rows.length,
      eligible: eligible.length,
      complete: eligible.filter((row) => row.score.strict_complete).length,
      complete_rate: eligible.length
        ? eligible.filter((row) => row.score.strict_complete).length /
          eligible.length
        : 0,
      strict_coverage: eligible.length
        ? eligible.reduce((n, row) => n + row.score.strict_coverage, 0) /
          eligible.length
        : null,
      official_evidence_f1_all:
        rows.reduce((n, row) => n + row.score.official_formula_evidence_f1, 0) /
        rows.length,
      mean_context_chars:
        rows.reduce((n, row) => n + row.request_chars + row.response_chars, 0) /
        rows.length,
      budget_exclusion_questions: rows.filter(
        (row) => row.result.excluded.budget > 0,
      ).length,
    };
  };
  if (mode === 'smoke') {
    const q = queries[0];
    const packedResult = await packed(
      context,
      { query: q.text },
      defaultArm,
      'hybrid',
      { source_ids: [q.source_id] },
    );
    labels.smoke = {
      id: q.id,
      returned: packedResult.result.results.length,
      context_chars: packedResult.request_chars + packedResult.response_chars,
    };
  } else {
    for (const armId of armIds) {
      await runLabel(`${armId}-hybrid`, arms[armId], 'hybrid');
      await runLabel(`${armId}-bm25`, arms[armId], 'bm25');
    }
    await runLabel('dense-reference', defaultArm, 'dense');
  }
  closeContext(context);
  if (globalThis.gc) globalThis.gc();
  return {
    scope: 'qasper',
    questions: queries.length,
    labels,
    chunks: context.tables.counts.chunks,
    build_ms: context.buildMs,
  };
}

async function loadPrivateFreeze(root) {
  const scopes = {};
  const allInputs = [];
  for (const scope of [...PRIVATE_SCOPE_ORDER, 'paired-test']) {
    const paths = privatePaths(root, scope);
    const dataset = await readJson(paths.dataset);
    const inputs = dataset.questions.flatMap((q) => [
      { id: q.id, text: q.query, subquestion_id: null },
      ...(q.subquestions ?? []).map((sub) => ({
        id: q.id,
        text: sub.text,
        subquestion_id: sub.id,
      })),
    ]);
    allInputs.push(...inputs.map((item) => ({ scope, ...item })));
    const db = openDatabase(paths.db, { readOnly: true });
    const tables = discoverTables(db);
    const counts = tables.counts;
    db.close();
    scopes[scope] = {
      dataset: paths.dataset,
      dataset_sha256: await shaFile(paths.dataset),
      database: paths.db,
      database_sha256: await shaFile(paths.db),
      tables,
      question_ids: dataset.questions.map((q) => q.id),
      input_sha256: shaText(compact(inputs)),
      questions: dataset.questions.length,
      answerable: dataset.questions.filter((q) => !q.no_answer).length,
      no_answer: dataset.questions.filter((q) => q.no_answer).length,
      facts: dataset.questions.reduce((n, q) => n + q.required_facts.length, 0),
      table_counts: counts,
    };
  }
  return { scopes, all_inputs_sha256: shaText(compact(allInputs)) };
}

async function loadPublicFreeze(root) {
  const prior = await readJson(
    path.join(
      root,
      'analysis',
      'minisearch-without-coverage-2026-09-21-v1',
      'freeze.json',
    ),
  );
  const scopes = {};
  for (const scope of PUBLIC_SCOPES) {
    const paths = publicPaths(root, scope);
    const queries = await readJsonLines(paths.queries);
    const ids = prior.cohorts[scope].ids;
    const byId = new Map(queries.map((q) => [q.query_id ?? q.id, q]));
    const inputs = ids.map((id) => {
      const q = byId.get(id);
      assert.ok(q);
      return { id, text: publicQueryText(scope, q) };
    });
    const db = openDatabase(paths.db, { readOnly: true });
    const tables = discoverTables(db);
    db.close();
    scopes[scope] = {
      population: prior.cohorts[scope].population,
      sample: ids.length,
      question_ids: ids,
      input_sha256: shaText(compact(inputs)),
      database: paths.db,
      database_sha256: await shaFile(paths.db),
      tables,
      table_counts: tables.counts,
      query_file: paths.queries,
      query_file_sha256: await shaFile(paths.queries),
    };
    if (scope !== 'qasper') {
      scopes[scope].corpus_file = paths.corpus;
      scopes[scope].corpus_file_sha256 = await shaFile(paths.corpus);
    } else {
      scopes[scope].docs_file = paths.docs;
      scopes[scope].docs_file_sha256 = await shaFile(paths.docs);
    }
  }
  const planFile = path.join(root, 'embedding-plan.json');
  const vectorFile = path.join(root, 'vectors.sqlite');
  const vectorStat = await fs.stat(vectorFile);
  const vectorDb = openDatabase(vectorFile, { readOnly: true });
  const vectorEntries = vectorDb
    .prepare('SELECT count(*) AS n FROM entries')
    .get().n;
  vectorDb.close();
  return {
    source_freeze: prior,
    scopes,
    embedding_plan_sha256: await shaFile(planFile),
    vector_cache_sha256: null,
    vector_cache_stat: {
      size: vectorStat.size,
      mtime_ms: vectorStat.mtimeMs,
      entries: vectorEntries,
      binding_sha256: shaText(
        compact({
          size: vectorStat.size,
          mtime_ms: vectorStat.mtimeMs,
          entries: vectorEntries,
        }),
      ),
    },
    vector_cache: vectorFile,
    all_inputs_sha256: shaText(
      compact(
        Object.fromEntries(
          Object.entries(scopes).map(([scope, value]) => [
            scope,
            value.question_ids,
          ]),
        ),
      ),
    ),
  };
}

async function buildFreeze(privateRoot, publicRoot, out, variant = 'v1') {
  const privateFreeze = await loadPrivateFreeze(privateRoot);
  const publicFreeze = await loadPublicFreeze(publicRoot);
  const embeddingRaw = await readJson(
    path.join(
      privateRoot,
      'config',
      'embedding',
      'qwen3-7-embedding-1024.json',
    ),
  );
  const embedding = makeEmbeddingConfig(embeddingRaw);
  const freeze = {
    status: 'frozen',
    created_at: new Date().toISOString(),
    experiment: `2026-09-21-minisearch-parameter-exploration-${variant}`,
    arms: Object.fromEntries(armIds.map((id) => [id, arms[id]])),
    fixed: {
      chunker: 'markdown-structure-v1@1.0.1',
      tokenizer: 'icu-zh@1 / zh-CN with existing expansions',
      model: embedding.model,
      dimensions: embedding.dimensions,
      topk: 10,
      max_chunks_per_source: 3,
      bm25_candidates: 60,
      dense_candidates: 60,
      title_weight: 2,
      min_dense_similarity: 0.3,
      max_context_chars_utf16: 16000,
      rerank: false,
      mmr: false,
      decomposition: 'frozen subquestions only; no Agent generation',
    },
    denominators: {
      private_primary: {
        questions: 200,
        answerable: 196,
        no_answer: 4,
        facts: 403,
      },
      private_paired_separate: {
        questions: 40,
        note: 'same questions, not added to primary denominator',
      },
      public: {
        questions: 331,
        scopes: { langchain: 20, godot: 10, du: 200, qasper: 101 },
        qasper_strict_text: 78,
      },
    },
    private: privateFreeze,
    public: publicFreeze,
    code: {
      script: await shaFile(
        path.join(
          repoRoot,
          'evals',
          'run-minisearch-parameter-exploration.mjs',
        ),
      ),
      dist: Object.fromEntries(
        [
          'config.js',
          'database.js',
          'embedding.js',
          'lexical.js',
          'minisearch.js',
          'retrieval.js',
        ].map(async () => []),
      ),
    },
    environment: {
      node: process.version,
      icu: process.versions.icu,
      platform: process.platform,
    },
    constraints: [
      'Opened public/private samples; exploratory, not blind or held-out.',
      'No new embedding/API calls; private capture and public vectors.sqlite are offline-only.',
      'Old E drive indexes are read-only legacy snapshots; current repository dist implements MiniSearch, RRF and packResults.',
      'Pure BM25 and dense are diagnostics; hybrid is the primary parameter table.',
      'Do not change product defaults from this experiment.',
    ],
  };
  if (variant === 'budget20-cap-v1' || variant === 'budget20-followup-v1') {
    freeze.fixed.max_context_chars_utf16 = 20000;
    delete freeze.fixed.max_chunks_per_source;
    freeze.varied =
      variant === 'budget20-cap-v1'
        ? { max_chunks_per_source: [3, 6] }
        : {
            max_chunks_per_source: [5, 6],
            bm25_weight: [0.5, 0.31],
            dense_weight: [1, 0.8],
            rrf_k: [10, 5],
          };
    if (variant === 'budget20-followup-v1') delete freeze.fixed.dense_weight;
    freeze.reference = {
      label: 'dense-reference',
      max_chunks_per_source: 3,
      max_context_chars_utf16: 16000,
      role: 'Historical diagnostic only; not a same-budget comparison',
    };
  }
  const distHashes = {};
  for (const name of [
    'config.js',
    'database.js',
    'embedding.js',
    'lexical.js',
    'minisearch.js',
    'retrieval.js',
  ])
    distHashes[name] = await shaFile(path.join(repoRoot, 'dist', name));
  freeze.code.dist = distHashes;
  await fs.mkdir(out, { recursive: true });
  await writeJson(path.join(out, 'freeze.json'), freeze);
  return freeze;
}

async function verifyFreezeInputs(
  freeze,
  privateRoot,
  publicRoot,
  verifyFiles = false,
) {
  for (const value of Object.values(freeze.private.scopes)) {
    assert.ok((await fs.stat(value.dataset)).size > 0);
    assert.ok((await fs.stat(value.database)).size > 0);
    if (verifyFiles) {
      assert.equal(await shaFile(value.dataset), value.dataset_sha256);
      assert.equal(await shaFile(value.database), value.database_sha256);
    }
  }
  for (const value of Object.values(freeze.public.scopes)) {
    assert.ok((await fs.stat(value.database)).size > 0);
    assert.ok((await fs.stat(value.query_file)).size > 0);
    if (value.corpus_file)
      assert.ok((await fs.stat(value.corpus_file)).size > 0);
    if (value.docs_file) assert.ok((await fs.stat(value.docs_file)).size > 0);
    if (verifyFiles) {
      assert.equal(await shaFile(value.database), value.database_sha256);
      assert.equal(await shaFile(value.query_file), value.query_file_sha256);
      if (value.corpus_file)
        assert.equal(
          await shaFile(value.corpus_file),
          value.corpus_file_sha256,
        );
      if (value.docs_file)
        assert.equal(await shaFile(value.docs_file), value.docs_file_sha256);
    }
  }
  assert.equal(
    await shaFile(path.join(publicRoot, 'embedding-plan.json')),
    freeze.public.embedding_plan_sha256,
  );
  const vectorStat = await fs.stat(freeze.public.vector_cache);
  assert.ok(vectorStat.size > 0);
  if (verifyFiles && freeze.public.vector_cache_sha256)
    assert.equal(
      await shaFile(freeze.public.vector_cache),
      freeze.public.vector_cache_sha256,
    );
  assert.equal(
    await shaFile(path.join(repoRoot, 'dist', 'retrieval.js')),
    freeze.code.dist['retrieval.js'],
  );
  assert.equal(
    await shaFile(path.join(repoRoot, 'dist', 'minisearch.js')),
    freeze.code.dist['minisearch.js'],
  );
}

async function loadPrivateSelection(root, scope) {
  return (await readPrivateVectorAndSelection(root, scope)).selection;
}

async function runScopeChild(privateRoot, publicRoot, out, mode, scope) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--expose-gc',
        '--max-old-space-size=6144',
        fileURLToPath(import.meta.url),
        privateRoot,
        publicRoot,
        out,
        mode,
        scope,
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`scope child ${scope} exited ${code}`)),
    );
  });
}

async function executeScope(privateRoot, publicRoot, out, mode, scopeArg) {
  const freeze = await readJson(path.join(out, 'freeze.json'));
  if (scopeArg.startsWith('private:')) {
    const scope = scopeArg.slice('private:'.length);
    const vectorCache = await loadPrivateVectorCache(privateRoot);
    const embeddingRaw = await readJson(
      path.join(
        privateRoot,
        'config',
        'embedding',
        'qwen3-7-embedding-1024.json',
      ),
    );
    const embedding = makeEmbeddingConfig(embeddingRaw);
    const result = await runPrivateScope({
      root: privateRoot,
      out,
      scope,
      provider: createPrivateProvider(
        vectorCache,
        embeddingFingerprint(embedding),
      ),
      embedding,
      selection: await loadPrivateSelection(privateRoot, scope),
      mode,
    });
    await writeJson(
      path.join(out, `${mode}-scope-${scopeArg.replace(':', '-')}.json`),
      result,
    );
    return result;
  }
  const scope = scopeArg.slice('public:'.length);
  const publicPlan = await readJson(
    path.join(publicRoot, 'embedding-plan.json'),
  );
  const embedding = makeEmbeddingConfig(publicPlan.config);
  assert.equal(embeddingFingerprint(embedding), publicPlan.fingerprint);
  const vectorDb = openDatabase(path.join(publicRoot, 'vectors.sqlite'), {
    readOnly: true,
  });
  const provider = createPublicProvider(vectorDb, publicPlan.fingerprint);
  let result;
  if (scope === 'qasper') {
    result = await runQasper({
      root: publicRoot,
      out,
      queries: await loadPublicQueries(
        publicRoot,
        scope,
        freeze.public.source_freeze,
      ),
      provider,
      embedding,
      selection: {
        chunker: 'markdown-structure-v1',
        tokenizer: 'icu-zh',
        embedding: 'qwen',
        retrieval: 'rrf10',
      },
      mode,
    });
  } else {
    result = await runPublicRankingScope({
      root: publicRoot,
      out,
      scope,
      queries: await loadPublicQueries(
        publicRoot,
        scope,
        freeze.public.source_freeze,
      ),
      provider,
      embedding,
      selection: {
        chunker: 'public-fixed',
        tokenizer: 'icu-zh',
        embedding: 'qwen',
        retrieval: 'rrf10',
      },
      mode,
    });
  }
  vectorDb.close();
  await writeJson(
    path.join(out, `${mode}-scope-${scopeArg.replace(':', '-')}.json`),
    result,
  );
  return result;
}

async function execute(privateRoot, publicRoot, out, mode) {
  const freeze = await readJson(path.join(out, 'freeze.json'));
  await verifyFreezeInputs(freeze, privateRoot, publicRoot, false);
  const vectorBeforeSha =
    mode === 'budget20-cap' ||
    mode === 'budget20-followup' ||
    mode === 'full' ||
    mode === 'extension' ||
    mode === 'extension2' ||
    mode === 'other-params' ||
    mode === 'combinations' ||
    mode === 'deep' ||
    mode === 'rrf' ||
    mode === 'cap6' ||
    mode === 'cap6plus' ||
    mode === 'final-combos'
      ? await shaFile(freeze.public.vector_cache)
      : null;
  const scopes =
    mode === 'smoke'
      ? ['private:A-test', 'public:langchain', 'public:qasper']
      : [
          ...[...PRIVATE_SCOPE_ORDER, 'paired-test'].map(
            (scope) => `private:${scope}`,
          ),
          ...['langchain', 'godot', 'du', 'qasper'].map(
            (scope) => `public:${scope}`,
          ),
        ];
  for (const scope of scopes)
    await runScopeChild(privateRoot, publicRoot, out, mode, scope);
  const childResults = {};
  for (const scope of scopes) {
    const file = path.join(
      out,
      `${mode}-scope-${scope.replace(':', '-')}.json`,
    );
    childResults[scope] = await readJson(file);
  }
  if (mode === 'smoke') {
    const receipt = {
      status: 'complete',
      created_at: new Date().toISOString(),
      mode,
      scopes,
      results: childResults,
      new_embedding_calls: 0,
      network: 'not configured; provider is frozen-cache-only',
    };
    await writeJson(path.join(out, 'smoke-receipt.json'), receipt);
    return receipt;
  }
  const after = {};
  for (const [scope, value] of Object.entries(freeze.private.scopes))
    after[`private:${scope}`] = await shaFile(value.database);
  for (const [scope, value] of Object.entries(freeze.public.scopes))
    after[`public:${scope}`] = await shaFile(value.database);
  after['public:vectors.sqlite'] = await shaFile(freeze.public.vector_cache);
  const before = {};
  for (const [scope, value] of Object.entries(freeze.private.scopes))
    before[`private:${scope}`] = value.database_sha256;
  for (const [scope, value] of Object.entries(freeze.public.scopes))
    before[`public:${scope}`] = value.database_sha256;
  before['public:vectors.sqlite'] = vectorBeforeSha;
  const receipt = {
    status: 'complete',
    created_at: new Date().toISOString(),
    mode,
    scopes,
    results: childResults,
    before_database_sha256: before,
    after_database_sha256: after,
    unchanged_inputs: JSON.stringify(before) === JSON.stringify(after),
    new_embedding_calls: 0,
    network: 'not configured; provider is frozen-cache-only',
  };
  assert.equal(receipt.unchanged_inputs, true);
  await writeJson(path.join(out, 'run-receipt.json'), receipt);
  return receipt;
}

async function finalizeFull(
  privateRoot,
  publicRoot,
  out,
  scopePrefix = 'full',
) {
  const freeze = await readJson(path.join(out, 'freeze.json'));
  const scopes = [
    ...[...PRIVATE_SCOPE_ORDER, 'paired-test'].map(
      (scope) => `private:${scope}`,
    ),
    ...['langchain', 'godot', 'du', 'qasper'].map((scope) => `public:${scope}`),
  ];
  const results = {};
  for (const scope of scopes) {
    const file = path.join(
      out,
      `${scopePrefix}-scope-${scope.replace(':', '-')}.json`,
    );
    assert.ok(
      await fs.stat(file).catch(() => null),
      `Missing scope receipt ${scope}`,
    );
    results[scope] = await readJson(file);
  }
  const after = {};
  for (const [scope, value] of Object.entries(freeze.private.scopes))
    after[`private:${scope}`] = await shaFile(value.database);
  for (const [scope, value] of Object.entries(freeze.public.scopes))
    after[`public:${scope}`] = await shaFile(value.database);
  const vectorStat = await fs.stat(freeze.public.vector_cache);
  const vectorShaAfter = await shaFile(freeze.public.vector_cache);
  const before = {};
  for (const [scope, value] of Object.entries(freeze.private.scopes))
    before[`private:${scope}`] = value.database_sha256;
  for (const [scope, value] of Object.entries(freeze.public.scopes))
    before[`public:${scope}`] = value.database_sha256;
  const unchangedDatabases = Object.entries(before).every(
    ([key, value]) => after[key] === value,
  );
  const receipt = {
    status: 'complete',
    created_at: new Date().toISOString(),
    mode: scopePrefix,
    scopes,
    results,
    before_database_sha256: before,
    after_database_sha256: after,
    unchanged_databases: unchangedDatabases,
    vector_cache: {
      frozen_stat_binding: freeze.public.vector_cache_stat,
      after_stat: { size: vectorStat.size, mtime_ms: vectorStat.mtimeMs },
      after_sha256: vectorShaAfter,
    },
    new_embedding_calls: 0,
    network: 'not configured; provider is frozen-cache-only',
    execution_correction:
      scopePrefix === 'extension2'
        ? {
            initial_frozen_script_sha256: freeze.code.script,
            final_script_sha256: await shaFile(
              path.join(
                repoRoot,
                'evals',
                'run-minisearch-parameter-exploration.mjs',
              ),
            ),
            scope: 'extension2 receipt finalized after vector hash binding fix',
            reason:
              'All extension2 scope receipts were written, but the parent run initially omitted extension2 from the vector-cache before-hash binding and failed only at final receipt assertion. The retrieval outputs, frozen inputs and vector cache were unchanged.',
          }
        : scopePrefix === 'extension'
          ? {
              initial_frozen_script_sha256: freeze.code.script,
              final_script_sha256: await shaFile(
                path.join(
                  repoRoot,
                  'evals',
                  'run-minisearch-parameter-exploration.mjs',
                ),
              ),
              scope:
                'public scopes rerun after receipt-pool initialization fix',
              reason:
                'The first extension attempt completed private scopes, then failed before writing public rows because the candidate receipt pool was initialized only for a default arm. Public scopes were rerun with the same weights, inputs, vectors and retrieval logic.',
            }
          : scopePrefix === 'full'
            ? {
                initial_frozen_script_sha256: freeze.code.script,
                final_script_sha256: await shaFile(
                  path.join(
                    repoRoot,
                    'evals',
                    'run-minisearch-parameter-exploration.mjs',
                  ),
                ),
                scope: 'QASPER rerun only',
                reason:
                  'The adapter was corrected to apply the production searchSchema trim boundary before frozen-vector lookup, then formatted without semantic changes; no arm, question ID, corpus, vector, or scoring parameter changed.',
              }
            : null,
  };
  assert.equal(unchangedDatabases, true);
  assert.equal(vectorStat.size, freeze.public.vector_cache_stat.size);
  assert.equal(vectorStat.mtimeMs, freeze.public.vector_cache_stat.mtime_ms);
  await writeJson(path.join(out, 'run-receipt.json'), receipt);
  return receipt;
}

async function main() {
  const [privateRoot, publicRoot, outArg, mode = 'full', scopeArg] =
    process.argv.slice(2);
  assert.ok(
    privateRoot && publicRoot && outArg,
    'Usage: node evals/run-minisearch-parameter-exploration.mjs PRIVATE_ROOT PUBLIC_ROOT OUT [freeze|smoke|full]',
  );
  const out = path.resolve(outArg);
  const followupBatch =
    mode === 'freeze-budget20-followup' || mode === 'budget20-followup';
  if (
    mode === 'freeze-budget20-cap' ||
    mode === 'budget20-cap' ||
    followupBatch
  ) {
    armIds = followupBatch ? budget20FollowupArmIds : budget20CapArmIds;
    globalThis.fetch = async () => {
      throw new Error('Network forbidden in budget20-cap replay');
    };
    if (mode === 'freeze-budget20-cap' || mode === 'freeze-budget20-followup') {
      assert.ok(
        !(await fs.stat(out).catch(() => null)),
        'Output directory already exists',
      );
      await buildFreeze(
        path.resolve(privateRoot),
        path.resolve(publicRoot),
        out,
        followupBatch ? 'budget20-followup-v1' : 'budget20-cap-v1',
      );
      console.log(
        JSON.stringify({ status: 'frozen', output: out, arms: armIds }),
      );
      return;
    }
    const frozen = await readJson(path.join(out, 'freeze.json'));
    assert.deepEqual(
      frozen.arms,
      Object.fromEntries(armIds.map((id) => [id, arms[id]])),
    );
  }
  if (
    mode === 'freeze' ||
    mode === 'freeze-extension' ||
    mode === 'freeze-extension2' ||
    mode === 'freeze-other-params' ||
    mode === 'freeze-combinations' ||
    mode === 'freeze-deep' ||
    mode === 'freeze-rrf' ||
    mode === 'freeze-cap6' ||
    mode === 'freeze-cap6plus' ||
    mode === 'freeze-final-combos'
  ) {
    armIds =
      mode === 'freeze-extension'
        ? extensionArmIds
        : mode === 'freeze-extension2'
          ? extension2ArmIds
          : mode === 'freeze-other-params'
            ? otherParamsArmIds
            : mode === 'freeze-combinations'
              ? combinationArmIds
              : mode === 'freeze-deep'
                ? deepArmIds
                : mode === 'freeze-rrf'
                  ? rrfArmIds
                  : mode === 'freeze-cap6'
                    ? cap6ArmIds
                    : mode === 'freeze-cap6plus'
                      ? cap6PlusArmIds
                      : mode === 'freeze-final-combos'
                        ? finalCombinationArmIds
                        : historicalArmIds;
    assert.ok(
      !(await fs.stat(out).catch(() => null)),
      'Output directory already exists',
    );
    await buildFreeze(
      path.resolve(privateRoot),
      path.resolve(publicRoot),
      out,
      mode === 'freeze-extension'
        ? 'weight-extension-v1'
        : mode === 'freeze-extension2'
          ? 'weight-extension2-v1'
          : mode === 'freeze-other-params'
            ? 'other-params-v1'
            : mode === 'freeze-combinations'
              ? 'combinations-v1'
              : mode === 'freeze-deep'
                ? 'deep-v1'
                : mode === 'freeze-rrf'
                  ? 'rrf-v1'
                  : mode === 'freeze-cap6'
                    ? 'cap6-v1'
                    : mode === 'freeze-cap6plus'
                      ? 'cap6plus-v1'
                      : mode === 'freeze-final-combos'
                        ? 'final-combinations-v1'
                        : 'v1',
    );
    console.log(
      JSON.stringify({ status: 'frozen', output: out, arms: armIds }),
    );
    return;
  }
  assert.ok(
    await fs.stat(path.join(out, 'freeze.json')).catch(() => null),
    'Run freeze phase first',
  );
  if (mode === 'extension' || mode === 'finalize-extension')
    armIds = extensionArmIds;
  if (mode === 'extension2' || mode === 'finalize-extension2')
    armIds = extension2ArmIds;
  if (mode === 'other-params' || mode === 'finalize-other-params')
    armIds = otherParamsArmIds;
  if (mode === 'combinations' || mode === 'finalize-combinations')
    armIds = combinationArmIds;
  if (mode === 'deep' || mode === 'finalize-deep') armIds = deepArmIds;
  if (mode === 'rrf' || mode === 'finalize-rrf') armIds = rrfArmIds;
  if (mode === 'cap6' || mode === 'finalize-cap6') armIds = cap6ArmIds;
  if (mode === 'cap6plus' || mode === 'finalize-cap6plus')
    armIds = cap6PlusArmIds;
  if (mode === 'final-combos' || mode === 'finalize-final-combos')
    armIds = finalCombinationArmIds;
  if (scopeArg) {
    const result = await executeScope(
      path.resolve(privateRoot),
      path.resolve(publicRoot),
      out,
      mode,
      scopeArg,
    );
    console.log(
      JSON.stringify({ status: 'complete', mode, scope: scopeArg, result }),
    );
    return;
  }
  if (
    mode === 'finalize' ||
    mode === 'finalize-extension' ||
    mode === 'finalize-extension2' ||
    mode === 'finalize-other-params' ||
    mode === 'finalize-combinations' ||
    mode === 'finalize-deep' ||
    mode === 'finalize-rrf' ||
    mode === 'finalize-cap6' ||
    mode === 'finalize-cap6plus' ||
    mode === 'finalize-final-combos'
  ) {
    const receipt = await finalizeFull(
      path.resolve(privateRoot),
      path.resolve(publicRoot),
      out,
      mode === 'finalize-extension'
        ? 'extension'
        : mode === 'finalize-extension2'
          ? 'extension2'
          : mode === 'finalize-other-params'
            ? 'other-params'
            : mode === 'finalize-combinations'
              ? 'combinations'
              : mode === 'finalize-deep'
                ? 'deep'
                : mode === 'finalize-rrf'
                  ? 'rrf'
                  : mode === 'finalize-cap6'
                    ? 'cap6'
                    : mode === 'finalize-cap6plus'
                      ? 'cap6plus'
                      : mode === 'finalize-final-combos'
                        ? 'final-combos'
                        : 'full',
    );
    console.log(
      JSON.stringify({
        status: receipt.status,
        unchanged_databases: receipt.unchanged_databases,
      }),
    );
    return;
  }
  if (mode === 'full')
    assert.ok(
      !(await fs.stat(path.join(out, 'run-receipt.json')).catch(() => null)),
      'Full output already has a run receipt',
    );
  const receipt = await execute(
    path.resolve(privateRoot),
    path.resolve(publicRoot),
    out,
    mode,
  );
  console.log(
    JSON.stringify({
      status: receipt.status,
      mode,
      unchanged_inputs: receipt.unchanged_inputs,
    }),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();

function setArmIdsForExternal(ids) {
  armIds = [...ids];
}

export {
  arms,
  discoverTables,
  fuse,
  requestFor,
  lane,
  publicPaths,
  publicQueryText,
  publicQueryId,
  loadPublicQueries,
  runPublicRankingScope,
  runQasper,
  makeEmbeddingConfig,
  createPublicProvider,
  setArmIdsForExternal,
};
