# 当前默认20000预算：cap3与cap6同题对照

日期：2026-09-21。状态：检索、官方核分和完整性审计完成，独立复核进行中。用户要求按当前参数重跑同样题数；本批测试cap6候选，以同预算cap3作单变量对照，不自动修改产品cap默认。

## 结论

在当前BM25=0.5、dense=1、RRF10与20000累计预算下，cap3→cap6让自建主集完整证据176/196→190/196、事实378/403→393/403；14题改善、0题退化，新增15个事实命中、没有丢失原已命中事实。平均累计上下文14381→14409字符，仅增加约0.19%。这些是已开卷固定样本的实际返回证据结果，不是答案正确率或新盲测。

QASPER完整文本证据48/78→60/78，但官方Evidence F1从22.21%降至15.81%，平均上下文5889→10946字符。cap6在单论文检索中会多返回非标注段落，覆盖和精度存在取舍。公开固定片段三库的两臂排名与旧default逐题相同，因为官方排名口径不应用cap与正文预算，不能以其相同分数证明cap没有代价。

## 条件与口径

两组均使用MiniSearch 7.2.0取消匹配词乘数、新综合1.0.1、原ICU分词、qwen3.7-text-embedding/1024真实缓存；k/b/d=1.2/0.7/0.5、BM25/dense=0.5/1、RRF10、候选60/60、topk10、标题2、最低余弦0.3。唯一变化为max_chunks_per_source=3或6；不引入0.31、RRF5或dense0.8。

累计请求与业务JSON预算20000，先扣除实际请求长度，再传入响应预算；产品max_context_chars本身约束完整响应JSON。这里是UTF-16字符，不是模型token。新综合只用于自建库与QASPER，另外三库保留官方固定检索单元。

自建主集200题（196可答、4无答案、403事实），原固定子问题不变；paired40同题干扰另列。公开样本保持LangChain20、Godot10、Du200、QASPER101，共331题，不重新抽样，完整语料不缩减。每臂主hybrid共531道父题，两臂1062次主条件执行；诊断模式和paired40不增加独立题数。

每组另有同预算纯BM25诊断；旧dense-reference继续使用cap3/16000，明确不作为20000同预算或同cap对照。固定片段公开排名另有不受正文预算影响的纯dense参考。

## 自建200题

所有主指标用同一K=10；完整证据和事实分母分别196/403，成本与无答案统计包括全部200题。

| 指标                |              cap3 |              cap6 |
| ------------------- | ----------------: | ----------------: |
| 完整证据            | 176/196（89.80%） | 190/196（96.94%） |
| 事实Recall微平均    | 378/403（93.80%） | 393/403（97.52%） |
| 严格单块Hit@10      |           190/196 |           193/196 |
| 严格单块MRR@10      |            85.24% |            85.57% |
| 平均累计上下文字符  |             14381 |             14409 |
| 平均返回块数        |             9.995 |             9.995 |
| 平均不同来源数      |             5.555 |             4.635 |
| 预算排除题数        |             2/200 |             2/200 |
| 4道无答案题返回非空 |               4/4 |               4/4 |

预算排除是跳过放不下的完整片段，不是剪短正文，不等于该题漏掉必需证据。cap3/20000与旧default/cap3/16000的完整题、事实覆盖与Hit/MRR相同，本轮改善来自cap变化。

### 分库完整题与事实

| 范围                 | cap3完整／事实 | cap6完整／事实 |
| -------------------- | -------------: | -------------: |
| A 八股               | 47/48；124/125 | 48/48；125/125 |
| B 课程               |   33/35；63/65 |   34/35；64/65 |
| C 学习记录           |   25/25；46/46 |   25/25；46/46 |
| D 留出库（现已开卷） |   22/30；49/58 |   30/30；58/58 |
| 混合库               |  49/58；96/109 | 53/58；100/109 |
| paired40（单列）     |   36/40；81/85 |   40/40；85/85 |

单块Hit/MRR只把一个块完整支持至少一项事实视为相关；多块联合覆盖另看完整率和事实Recall。来源数量下降本身不代表效果下降；本批没有观察到已覆盖事实丢失，不保证新查询没有跨来源竞争。

同预算纯BM25完整139/196→146/196、事实307/403→318/403、MRR63.49%→63.56%。旧dense/cap3/16000参考为178/196、378/403、MRR86.17%，不能把它与cap6/20000之差全部归因于hybrid。

## 公开331题

### 固定片段排名：两臂完全相同

| 数据集      | 题数 |           主指标 | Recall@10 | Recall@50 | MRR@10 |  Hit@10 |
| ----------- | ---: | ---------------: | --------: | --------: | -----: | ------: |
| LangChain   |   20 | α-nDCG@10 42.62% |    35.25% |    53.73% | 51.35% |   17/20 |
| Godot       |   10 | α-nDCG@10 16.27% |    15.56% |    31.50% | 20.00% |    3/10 |
| DuRetrieval |  200 |   nDCG@10 84.25% |    88.59% |    97.23% | 91.28% | 197/200 |

保留49505/25477/100001个原始检索单元。两臂hybrid/BM25排名的每个ID、顺序和分数均与旧default一致。这里不应用来源上限或最终JSON打包，不是cap6端到端公开产品验证；Godot只有10题，不能据此作广泛质量保证。

### QASPER：已知目标论文，实际打包

| 指标                     |            cap3 |            cap6 |
| ------------------------ | --------------: | --------------: |
| 严格完整文本证据         | 48/78（61.54%） | 60/78（76.92%） |
| 严格文本覆盖宏平均       |          65.81% |          79.06% |
| 官方Evidence F1（101题） |          22.21% |          15.81% |
| 平均累计上下文字符       |            5889 |           10946 |
| 预算排除题数             |           0/101 |           0/101 |

完整覆盖与段落F1不可互换。段落F1仍受额外非标注段落影响，结果没有测Agent最终回答是否因此改善。纯BM25严格完整28/78→46/78，F1 14.29%→12.99%；全部模式机器可读值见收据。

## 验证、复跑与边界

- [运行器](../../evals/run-minisearch-parameter-exploration.mjs)新增freeze-budget20-cap/budget20-cap，旧模式条件保持；使用当前dist的MiniSearch和packResults。网络明确禁用，冻结真实向量缺失即报错。
- [私有评分器](../../evals/summarize-minisearch-parameter-metrics.mjs)按已返回原文范围重算K前缀；[公开评分器](../../evals/score-minisearch-parameter-exploration.py)使用pytrec、pyndeval和官方QASPER evaluator逐题核分。
- [本轮审计器](../../evals/audit-default-budget20-cap.mjs)检查有效参数、同题ID、返回数/来源上限、请求和响应实际长度、200/196分母、同K10完整率、配对得失，以及固定片段两臂与旧default全排名相等。[汇总及哈希收据](2026-09-21-default-budget20-cap-comparison.manifest.json)不含私有题干或正文。
- 本地npm run check：188项通过、1项既有跳过；格式、类型、构建、默认CLI/MCP烟测通过。Python评分验证6/6通过。
- 旧9份唯一SQLite索引和公共真实向量缓存运行前后SHA相同，新增embedding/API调用0。所有历史输入与结果只读，新产物拒绝覆盖。
- 输入预检与原批次ID/文件/数据库相同；QASPER最初freeze曾保存1题未trim文本哈希，其实际重跑已记录trim修正。本轮同时重算raw和trim哈希，匹配旧freeze和最新cap6freeze；不是换题，详情在E盘input-identity-check.json。
- 仍为已开卷探索，不声明新的盲测、通用最优或Agent答案准确率。4道无答案题不足以评价稳健的证据不足处理。cap产品默认本轮未改。

原始目录：E:/幻/Documents/八股-Echo测试/2026-09-21-default-budget20-cap-v1；包括freeze、run-receipt、private/public-score、comparison-final及全部逐题JSONL（初次comparison另行保留）。复跑必须使用新OUT：

```text
node evals/run-minisearch-parameter-exploration.mjs PRIVATE_ROOT PUBLIC_ROOT NEW_OUT freeze-budget20-cap
node --expose-gc --max-old-space-size=6144 evals/run-minisearch-parameter-exploration.mjs PRIVATE_ROOT PUBLIC_ROOT NEW_OUT budget20-cap
node evals/summarize-minisearch-parameter-metrics.mjs PRIVATE_ROOT NEW_OUT
python evals/score-minisearch-parameter-exploration.py PUBLIC_ROOT NEW_OUT
node evals/audit-default-budget20-cap.mjs NEW_OUT OLD_DEFAULT_OUT
```
