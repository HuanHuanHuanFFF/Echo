# 新综合＋拆分：四项独立单参数对照

日期：2026-09-17。状态：预先固定方案，待依次执行。
依据用户本轮明确要求，四项都测完；每组都从相同基线开始，不把前一组的变化带入下一组。承接[BM25权重对照](2026-09-17-bm25-weight-comparison.md)，保留每篇3、BM25权重0.5和候选60/60。

## 配置能力与预算口径

这四个字段都已经可配置：召回profile持久保存默认值；MCP echo_search 的单次 overrides 可覆盖。
例：overrides.max_context_chars=16000限制本次完整返回业务JSON的字符数。评测中的总预算另外包含规范请求；脚本会先扣掉请求占用，再把剩余额度写入该override。
[配置schema与覆盖入口](../../src/config.ts)、[评测请求扣额](../../src/retrieval-evaluation.ts)是代码依据。单位为UTF-16字符长度，不是模型token数。

## 预先固定四组

| 顺序 | CLI预设         | 唯一变量                       | 对照值 | 候选值 |
| ---- | --------------- | ------------------------------ | -----: | -----: |
| 1    | rrf-k           | rrf_k                          |     60 |     30 |
| 2    | title-weight    | title_weight                   |      2 |      1 |
| 3    | dense-threshold | min_dense_similarity           |    0.3 |   0.25 |
| 4    | context-budget  | max_context_chars / 同一总预算 |  12000 |  16000 |

预算组由一个预算值同时派生profile返回上限、评测总额度和单次请求扣额，不能只扩大总额度却仍被原12000返回上限卡住。
其余三组总预算固定12000。所有组保留topk10、每篇3；预算组也不增加块数或来源上限。

## 共同条件

- markdown-structure-v1，新综合的原策略与索引；hybrid，无rerank。
- 相同开发100题（95可答+5无答案），A30/B25/C15/混合30，原33父题/68固定子问题不变；每组两臂各100，四组共800次父题执行，仍只有100个独立父题。
- A150/B22/C165篇，混合并集337篇。原索引只读复用；允许SQLite自身-shm运行时痕迹，不重建或修改原笔记/旧Chroma。
- 基线：topk10、每篇3、BM25/dense权重0.5/1、候选60/60、RRF60、标题2、最低相似度0.3、累计上下文12000字符。
- qwen3.7-text-embedding、1024维，原DashScope响应；batch8、timeout30000ms、send_dimensions=true、空文档/查询前缀，icu-zh/zh-CN、无自定义词典。
- 原E盘b454686检索运行时。全部复用同一135份真实响应，逐文件/查询key/向量哈希校验，网络上限0；预期四组1080次逻辑重放，新增API和服务tokens均0。
- 不运行最终200题，不自动采用胜出参数，不组合参数，不创建或合并PR。

## 验证与交付

[驱动](../../evals/run-source-limit-comparison.mjs)扩展四个固定预设；每次prepare/run/summarize均明确 --experiment。
核对基线配置revision没有漂移；配置只有预声明字段不同，语料、索引、模型、问句与真实向量相同。
预算组允许唯一派生的max_context_chars override随额度改变，其他请求字段必须逐项相同；严格核对请求字符加响应额度不超过对应总预算。

分别报告各组及分库的完整覆盖、事实Recall、严格单块Hit/MRR（K=1/3/5/10）、逐题事实得失和实际上下文。无答案独列；16000组的效果与增加的字符量放在一起，不能与同预算改进混报。
先完成隔离回归和完整检查，按顺序运行并保留全部失败/指纹记录。所有原始题目、响应、向量与索引仍只在E盘；公开文档/统计进入仓库并持续push。两位Luna/max独立复核整批结果。

```powershell
node evals/run-source-limit-comparison.mjs --experiment rrf-k --lab "E:/幻/Documents/八股-Echo测试/2026-09-16" --run-id <新的run-id> --phase prepare
# 同样的experiment和run-id，再依次执行run与summarize
# 其他预设为 title-weight、dense-threshold、context-budget
```
