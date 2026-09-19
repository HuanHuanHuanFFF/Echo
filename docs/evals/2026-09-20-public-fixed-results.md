# 公开固定片段检索：全量结果与参考比较

日期：2026-09-20。状态：LangChain 203题×2档已执行；Godot 99题、DuRetrieval 2000题仍在执行。本文随已冻结范围补齐，不调整参数、不改变产品默认。小型指纹见[公开收据](2026-09-20-public-fixed.manifest.json)。承接[执行冻结](2026-09-19-public-full-evaluation-freeze.md)；QASPER全文切块结果[另列](2026-09-19-public-qasper-results.md)。

## 条件与可比边界

模型为qwen3.7-text-embedding、1024维、空查询/正文前缀；ICU zh-CN分词、BM25/向量权重0.5/1、候选60/60、最低余弦0.3。唯一变量是RRF30/10。官方固定检索单元不重切；正文完整输入，官方外部ID去重取最后一行；标题字段为空，因此配置中的标题权重2不产生额外标题得分。

这里调用生产retrieveQuery，对完整候选排序计算官方指标；未施加产品正文预算/原文件每篇3块，也没有运行Agent回答。FreshStack85/302个问题超过MCP公共schema的2000字符上限，本轮保留完整问题走检索层，不冒称MCP端到端成绩。各数据集独立建库和评分，不混合成一个总准确率。

## LangChain：203题、49505有效文档ID

原始49514行遵循官方last-row覆盖，两个条件的203题均唯一完整、没有空结果，索引前后SHA相等。两路每题均召回60，融合并集平均114.27，并非全局60。

| 条件       | α-nDCG@10 | Coverage@20 | Recall@50 |          Hit@10 | MRR@10 |
| ---------- | --------: | ----------: | --------: | --------------: | -----: |
| Echo RRF30 |    35.98% |      67.73% |    45.89% | 159/203；78.33% | 52.21% |
| Echo RRF10 |    35.00% |      67.34% |    45.20% | 158/203；77.83% | 50.81% |

α-nDCG奖励靠前的相关内容及不同事实支持；Coverage按每题被支持的nugget比例宏平均；Recall按相关文档比例宏平均。它们都不是“完整答对问题”的比例，不能与个人笔记完整事实覆盖或QASPER Evidence F1直接比较。

RRF10−30的成对差异：

| 指标        | 差值（百分点） | 95%题级bootstrap区间 | 题级赢/输/平 |
| ----------- | -------------: | -------------------- | -----------: |
| α-nDCG@10   |          −0.98 | [−2.16, +0.20]       |     53/62/88 |
| Coverage@20 |          −0.39 | [−2.63, +1.77]       |     10/9/184 |
| Recall@50   |          −0.69 | [−1.54, +0.12]       |    14/29/160 |

10000次、种子20260919；区间仅描述当前固定语料上的题级不确定性，非跨领域结论。全部203题的候选集合一致，167题前10顺序变化、104题前10成员变化；每条RRF分数已按两路rank与0.5/1权重复算一致。当前差异来自同一候选池重排，不是模型或语料变化。RRF30均值略高，但三个区间都包含0；既不能断言稳定胜出，也不能把这当成两者完全等效的证明。

### 官方公开参考

采用[固定官方榜单](https://github.com/fresh-stack/fresh-stack.github.io/blob/72f48c7560f1694796b0b4af6cf96b49e083d9bd/leaderboard_data.json)的LangChain单域行，排除oracle、nugget输入和Fusion行；不是五域平均。

| 官方榜单纯召回方法 | α-nDCG@10 | Coverage@20 | Recall@50 |
| ------------------ | --------: | ----------: | --------: |
| BM25               |     23.0% |       47.5% |     26.1% |
| BGE (Gemma-2) 9B   |     21.6% |       54.8% |     33.7% |
| E5 (Mistral) 7B    |     30.4% |       65.4% |     39.3% |
| Qwen3-8B Emb       |     33.1% |       69.4% |     42.3% |

Echo RRF30的α-nDCG和Recall高于该Qwen3-8B参考行，Coverage略低，不能称三个指标全面领先。官方[榜单说明](https://fresh-stack.github.io/)统一最大输入2048 tokens；Echo保留全文且使用不同模型与hybrid，所以这是同数据同指标的系统参考，不能将差值归功于Echo的RRF实现，也不是严格同输入模型对榜或SOTA声明。

## Godot / DuRetrieval

待全量向量、排名、官方评分和独立复核完成后补齐。Du只采用C-MTEB dev的100001文档/2000题，不与原DuReader-Retrieval约809万段落任务混称。

## 验证与执行代价

LangChain去重用途/输入44732条，引用5593份成功API响应、服务报告56247027 tokens；所有响应的模型、维度、规范化向量、输入指纹和用量与缓存逐条一致。这个scope引用用量可能包含其他scope复用的少量请求，最终总账应从全局attempts计数，不能把scope数直接相加。

串行LangChain离线P50约2.21–2.27秒、P95约2.56–2.70秒，不含API/MCP/Agent。后续Godot/Du采用4个只读worker，每个条件仍独立调用生产retrieveQuery。16条真实LangChain串行/并行probe除耗时外逐字段相同，绑定串行配置、查询、索引和结果SHA；并行计时含资源竞争，不作为单请求速度横比。

新增调度隔离测试验证乱序完成仍保持题目身份、失败后终止worker。当前本地170项测试通过、1既有跳过，另3项Python评分输入回归；QASPER阶段提交2dcc116双平台CI通过。LangChain评分、成对统计、向量绑定和16条等价probe已由两位Luna/max独立复核通过；该probe是抽样等价检查，不是对其余数据集全部题目的预先证明。

原始文件：E:/幻/Documents/八股-Echo测试/public-benchmarks-2026-09-19 的 fixed/langchain-rrf30.jsonl、rrf10.jsonl、langchain-run-receipt.json；analysis/langchain-official-score.json、langchain-paired-analysis.json、langchain-vector-audit.json、langchain-parallel-conformance.json。评分器拒绝重复/漏题、未知文档、重复名次与非法rank导出。

复跑入口：[串行运行器](../../evals/run-public-fixed.mjs)、[只读并行运行器](../../evals/run-public-fixed-parallel.mjs)、[官方评分](../../evals/score-public-benchmarks.py)、[成对分析](../../evals/analyze-public-fixed.py)、[原始向量审计](../../evals/audit-public-vectors.mjs)。已有结果以wx保护；失败残留由操作者核对并另存后重跑，不自动覆盖原产物。
