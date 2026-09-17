# RRF30＋预算16000：采用默认值与联合验证

日期：2026-09-18。状态：用户已确认采用，联合组100题已执行，结果待独立复核。
本决定承接[四项单参数对照](2026-09-17-four-parameter-comparisons.md)，替代其“RRF30/16000只作候选、不改默认”的状态；用户本轮明确授权联合测试这两项。其他参数不变。

## 已采用的默认

- RRF k=30；完整返回业务JSON预算max_context_chars=16000。
- topk10、每篇3、BM25/dense权重0.5/1、候选60/60、标题2、最低相似度0.3保持。
- 更新src/config.ts、显式balanced样例、当前使用文档；初始化/缺省字段继承新值，已有显式配置仍优先，单次overrides仍可覆盖。
- 当前eval:retrieval的缺省累计预算及CLI帮助同步为16000；调用方显式budget仍优先。历史E盘冻结运行时、旧实验配置/记录不回写。
- 本轮仍在新综合markdown-structure-v1和固定拆分下评估；没有切换产品默认chunk或声称其他chunk均验证过。

## 只运行一个新条件

| 条件     | RRF k | 总预算 | 来源           |
| -------- | ----: | -----: | -------------- |
| 原基线   |    60 |  12000 | 复用旧结果     |
| 只改RRF  |    30 |  12000 | 复用旧结果     |
| 只改预算 |    60 |  16000 | 复用旧结果     |
| 联合组   |    30 |  16000 | 本轮唯一新运行 |

同一冻结开发100题（95可答+5无答案，33父题/68固定子问题）、原4个库、新综合策略/索引及135份真实模型向量。
联合组只执行100次父题/135次逻辑向量重放；其他300行仅作历史比较，不计新增执行。网络上限0，不新调用API、不重建索引、不跑最终200题。

固定：qwen3.7-text-embedding/1024、batch8/timeout30000ms/send_dimensions=true/空前缀、icu-zh/zh-CN/无词典、原E b454686检索运行时、无rerank。A150/B22/C165篇，混合337篇并集。
联合预算同时设置profile返回cap、评测总额度及扣除请求后的单次额度。比较旧12k时仅允许预算派生override变化，原父/子问句和模型向量严格相同。

## 证据与复现

[驱动](../../evals/run-source-limit-comparison.mjs)增加rrf-budget-combined，仅有joint一个取值；[比较器](../../evals/lib/joint-comparison.mjs)绑定上一批交付SHA，读取三个旧条件并核对语料、索引、运行时、检索参数、查询/向量哈希和实际正文事实。
既有旧结果不重跑或覆盖；联合组各库配置位于新的实验根configs目录，明确为30/16000，可用于后续本地检索。E盘根目录最初的BM25入口及其他历史显式配置不被默认值升级强制改写。

```powershell
node evals/run-source-limit-comparison.mjs --experiment rrf-budget-combined --lab "E:/幻/Documents/八股-Echo测试/2026-09-16" --run-id <新的run-id> --phase prepare
# 相同experiment/run-id，依次执行run、summarize、compare
```

初步结果：联合组完整90/95、事实220/226，与旧RRF单改相同；只新增100次检索、135次重放、新API为0。完整npm run check通过145项测试、1项原有跳过；详细分库与逐题比较等待独立复核后交付。默认值采用是用户决定；联合效果必须以实际运行判断，不能把两个单项收益相加。
本轮保持commit/push，完成独立结果复核；不创建或合并PR。
