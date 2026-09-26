# 2026-09-22 cap6 公开全量两臂结果

日期：2026-09-22。状态：**公开全量检索、官方评分、独立审计和分组分析已完成**。本轮没有修改产品默认，没有新增 API 调用，也没有把个人 200 题并入公开总分。

## 结论

在 3307 个公开父题上，A/B 两个主 hybrid 条件共完成 6614 次离线检索。A 是 BM25=0.5、dense=1、RRF10；B 是 BM25=0.31、dense=0.8、RRF5。两臂都使用新综合 markdown-structure-v1@1.0.1（QASPER）、MiniSearch 7.2.0 无匹配词数量乘数、ICU 原扩展、候选 60/60、标题权重2、最低余弦0.3、topk10、每篇6、累计 request+response 预算20000 UTF-16 字符；无 rerank、无 MMR。

A 在 LangChain 的 alpha-nDCG@10 高于 B，Godot差值很小且区间跨0；B 在 Du 的 nDCG@10 高于 A。QASPER A 的严格文本完整覆盖为636/800，B为634/800；论文簇 bootstrap 差值区间跨0。结果支持将 A/B 的取舍写成数据集相关的排序差异，不能据此改产品默认或宣称通用优胜。

## 题量、输入和边界

| 数据集                 | 全量题数 | 主条件执行 | 检索单位              | 主要评分                                                  |
| ---------------------- | -------: | ---------: | --------------------- | --------------------------------------------------------- |
| FreshStack LangChain   |      203 |        406 | 固定官方单元49505     | 官方 alpha-nDCG@10、Coverage@20；另列 Hit/MRR/Recall/nDCG |
| FreshStack Godot       |       99 |        198 | 固定官方单元25477     | 同上                                                      |
| C-MTEB DuRetrieval dev |     2000 |       4000 | 固定官方单元100001    | C-MTEB dev 协议 nDCG@10；另列 Hit/MRR/Recall              |
| QASPER v0.3 dev        |     1005 |       2010 | 新综合结构，281篇论文 | 严格文本800题完整证据、官方1005题 Evidence F1             |

固定片段库没有重切，也没有施加 Echo 的 source cap 或最终 JSON budget。QASPER使用原始完整问题、已知目标论文 source filter；严格文本分母为800，145题不适用/无法映射，60题所有标注均为无答案。所有公开题目已被打开和检查，本轮是全量诊断，不是盲测或 held-out 证明。

## 两个主 hybrid 结果

FreshStack 的 alpha-nDCG、Coverage、Recall 聚合实际调用固定 reference/freshstack_metrics.py；Du 使用固定 C-MTEB dev 说明与 pytrec_eval 实现。下表指标以0到1的小数表示。

| 数据集      | 臂  | alpha-nDCG@10 | Coverage@20 | nDCG@10 | Hit@10 | MRR@10 | Recall@10 | Recall@50 |
| ----------- | --- | ------------: | ----------: | ------: | -----: | -----: | --------: | --------: |
| LangChain   | A   |        0.3518 |      0.6730 | 0.25447 | 0.7882 | 0.5104 |    0.2386 |    0.4526 |
| LangChain   | B   |        0.3361 |      0.6718 | 0.24436 | 0.7833 | 0.4732 |    0.2368 |    0.4554 |
| Godot       | A   |        0.2947 |      0.5470 | 0.23986 | 0.6768 | 0.4849 |    0.2540 |    0.4535 |
| Godot       | B   |        0.2918 |      0.5503 | 0.23730 | 0.6768 | 0.4843 |    0.2545 |    0.4527 |
| DuRetrieval | A   |             — |           — | 0.84355 | 0.9800 | 0.9025 |    0.8808 |    0.9659 |
| DuRetrieval | B   |             — |           — | 0.85712 | 0.9805 | 0.9122 |    0.8858 |    0.9666 |

成对 A−B bootstrap（题级，10000次）为：LangChain alpha-nDCG +0.01563，95%区间 [+0.00678,+0.02489]；Godot +0.00291，区间 [−0.00809,+0.01552]；Du nDCG −0.01356，区间 [−0.01606,−0.01106]。这三个区间使用各库自己的题级分母，不能合成总体准确率。

### QASPER

| 臂  | 全部题 | 严格文本 eligible |     完整证据 | 严格覆盖 | 官方 Evidence F1 /1005 | text-evidence-only F1 | 平均 request+response UTF-16 | source-limit发生题数 | budget发生题数 |
| --- | -----: | ----------------: | -----------: | -------: | ---------------------: | --------------------: | ---------------------------: | -------------------: | -------------: |
| A   |   1005 |               800 | 636 (79.50%) |  0.83230 |                0.18316 |               0.18459 |                     10929.66 |                 1003 |              0 |
| B   |   1005 |               800 | 634 (79.25%) |  0.83032 |                0.18275 |               0.18417 |                     10855.53 |                 1003 |              0 |

论文簇 bootstrap 的 A−B 差值为：严格完整 +0.00250，95%区间 [−0.00597,+0.01108]；严格覆盖 +0.00198，区间 [−0.00511,+0.00938]；官方 Evidence F1 +0.00041，区间 [−0.00148,+0.00233]。source-limit 是实际打包排除计数；最终行没有完整候选 ID，因此不能据此断言 gold 证据一定在候选池内或一定被 cap 挡住。

## 旧331样本与剩余2976题

旧331题来自已打开的历史 cohort：LangChain20、Godot10、Du200、QASPER101。剩余2976题是同一全量数据中本轮新增诊断题，二者均不应写成盲测。

| 数据集    |    旧样本题数 |       其余题数 | 旧样本 A/B 主指标                                       | 其余题 A/B 主指标                                       |
| --------- | ------------: | -------------: | ------------------------------------------------------- | ------------------------------------------------------- |
| LangChain |            20 |            183 | 0.42624 / 0.39426 alpha-nDCG                            | 0.34362 / 0.32977 alpha-nDCG                            |
| Godot     |            10 |             89 | 0.16270 / 0.16201 alpha-nDCG                            | 0.30958 / 0.30642 alpha-nDCG                            |
| Du        |           200 |           1800 | 0.84248 / 0.85639 nDCG                                  | 0.84367 / 0.85720 nDCG                                  |
| QASPER    | 101（严格78） | 904（严格722） | 严格完整0.76923 / 0.76923；官方全题F1 0.15809 / 0.15590 | 严格完整0.79778 / 0.79501；官方全题F1 0.18596 / 0.18575 |

QASPER旧样本与剩余题的方向一致性有限：旧样本严格完整并列，剩余题 A 略高；官方全题 F1 分别按101/904题计算，不能与严格78/722题的完整覆盖混用。两组的论文簇区间都跨0。该分组用于识别历史已调参数据与剩余题诊断边界，不用于提升证据等级。

## 差异来源和代表模式

固定三库的2302题中，A/B 的 BM25 与 dense candidate pool 逐题完全一致；差异来自融合分数和最终排序。RRF公式按每个候选逐条核验：

score = bm25_weight / (rrf_k + bm25_rank) + dense_weight / (rrf_k + dense_rank)

A/B hybrid top10 不同题数为：LangChain154/203、Godot61/99、Du1787/2000。典型模式是同一批相邻相关单元因权重和 RRF 衰减不同交换前排位置：

- LangChain 77947395（标题“LangChain + Hugging Face -> HuggingFacePIpeline Error”）：正确 huggingface_pipeline.py 单元支持4/4 nuggets，dense第4、BM25第15；A融合排第1，B排第3，B前两名是支持0个nugget的 `__init__.py` 与 README。两组前10都含4/4，差异来自正确证据更晚，alpha-nDCG 从0.8799变为0.5154。
- Godot 76560345：A 0.8365，B 0.4538；CanvasItem/Texture2D/AtlasTexture 等相关单元的名次交换后影响多样性覆盖。
- Du 8f3a1b4a40d9d7f5a9455ffecf4dc557（问题“10周年英文简写”）：唯一相关单元553987f1e6698b1a189a633c29bf0fb1是 dense 第1、BM25不在前60。A 将它排第4（RRF .090909），前3个 qrels=0；B 将它升到第1（.133333），因此 nDCG 从0.4307变为1.0。该例说明两路加分会改变 dense 头部证据的位置，体现的是 BM25权重与RRF组合效应，不能单独归因其中一项。Du全量平均结果也显示B更适合该中文检索分布。
- QASPER bfc2dc913e7b78f3bd45e5449d71383d0aa4a890（论文1802.06024）：A证据F1 0.6667且严格完整，B为0.2857且不完整；另一题 c6a0b9b5dabcefda0233320dd1548518a0ae758e 则 B 完整而 A 不完整，说明单题排序取舍双向存在。

这些例子是已运行结果的逐题诊断，不是新的调参或额外实验臂。

## 私有200题对照（单列）

个人结果没有进入3307题公开分母：

- A：2026-09-21-default-budget20-cap-v1，default20-cap6 hybrid 190/196、393/403、MRR@10 0.8557458698。
- B：2026-09-21-budget20-followup-v2，recall20-cap6 hybrid 191/196、394/403、MRR@10 0.8674744898。

旧收据 SHA 已在 analysis JSON 和最终 manifest 中绑定；私有结果仅作个人场景对照。

## 复跑、审计和产物

冻结与入口：

- [公开全量冻结协议](2026-09-22-cap6-public-full-freeze.md)
- [公开全量 runner](../../evals/run-public-full-cap6.mjs)
- [共享检索核心](../../evals/run-minisearch-parameter-exploration.mjs)
- [官方 scorer](../../evals/score-public-full-cap6.py)
- [分组/原因分析](../../evals/analyze-public-full-cap6.py)

复跑需先准备与[原全量协议](2026-09-19-public-full-evaluation-freeze.md#独立复跑入口)一致的语料、只读索引、真实向量缓存和 Python 评分依赖；本轮使用 Node 24.15、ICU 78.2、Python 3.12。`OUT` 必须是尚不存在的新目录，`REFERENCE_A/B` 分别指向前批 default-budget20-cap-v1 与 budget20-followup-v2 目录，供旧331题一致性核验。

```text
npm run build
node evals/run-public-full-cap6.mjs PRIVATE_ROOT PUBLIC_ROOT OUT freeze
node --expose-gc --max-old-space-size=6144 evals/run-public-full-cap6.mjs PRIVATE_ROOT PUBLIC_ROOT OUT run
python evals/score-public-full-cap6.py PUBLIC_ROOT OUT
python evals/analyze-public-full-cap6.py PUBLIC_ROOT OUT --private-a-root REFERENCE_A --private-b-root REFERENCE_B
node evals/audit-public-full-cap6.mjs PUBLIC_ROOT OUT REFERENCE_A REFERENCE_B
```

审计本次已归档的 v2 时，在 audit 命令末尾追加 `OUT/execution-source`，以核对实际执行版源码；重新运行时使用新 `OUT`，不覆盖已有输出。

真实公开数据、向量和完整 JSONL 位于：

${EVAL_ROOT}/2026-09-22-cap6-public-full-v2

其中 freeze.json 冻结全量 ID、输入/DB/corpus/docs/vector hash、arms 和运行时 hash；run-receipt.json 记录 before/after 数据库 hash、向量 cache hash、6614 executions、0 new embedding calls；public-score.json 是官方评分结果；independent-audit.json 绑定11份独立主审计 JSONL、旧331逐字段复现、QASPER正文及12052条 RRF 检查；[manifest-final](2026-09-22-cap6-public-full.manifest.json) 绑定全部23份公开 JSONL、8份逐题评分、execution-source 原字节、格式等价收据和依赖；[provenance-final](2026-09-22-cap6-public-full.provenance.json) 绑定版本关系与 SHA。

执行版10份文件保存在 execution-source/；格式化交付副本与执行版的差异只由 Prettier 产生，见 format-equivalence.json。本轮仓库检查为190 passed、1既有 skipped，包含 format、typecheck、build、默认 CLI/MCP smoke；代码 b88d318 的 [Windows/Linux CI](https://github.com/HuanHuanHuanFFF/Echo/actions/runs/35689281894)通过。两位独立审查者复核原始检索、官方评分和来源绑定；工程检查不替代本轮公开评分。

## 本轮默认建议

若本轮公开资料必须选一个工作起点，A 更适合作为一般混合资料的候选：它在 LangChain 更稳，QASPER严格完整略高，Godot差异很小；B 在 Du 中文检索上有明确优势。Godot 与 QASPER 的区间跨0，因此本轮只给出有边界的选择建议，不自动修改产品默认。

## 限制和后续

本轮没有生成答案、没有进行 Agent 多轮改写、没有测 rerank/MMR，也没有扩大产品默认 source cap。QASPER的 source-limit 计数不等于候选池缺证；固定库的候选池/排序诊断不代表 QASPER。公开全量的完成只说明本轮冻结条件已被执行并核分，不能外推为通用优秀、SOTA 或产品默认已被证明最优。
