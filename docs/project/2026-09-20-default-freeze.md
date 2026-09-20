# Echo默认冻结：2026-09-20

日期：2026-09-20。状态：用户已确认采用“新综合＋BM25 0.5＋RRF10”，实现、本地验证与两位Luna/max独立复核完成。本决定替代此前heading-1000/RRF30产品默认及本文“切块待采用”状态；不改写历史实验配置、标签或分数，不采纳此前讨论的BM25 0.4。

## 唯一默认组合

适用于新建v2工作区。可执行入口为[defaultMain](../../src/profiles.ts)、[retrievalSchema](../../src/config.ts)和[初始化器](../../src/profile-manager.ts)。

| 项目                 | 冻结值                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 切块                 | markdown-structure-v1@1.0.1（新综合）                                                                            |
| 切块规则             | 目标1000/常规最大1500字符、短节合并阈值200、长单元回退拆分时80字符整行overlap；保留标题与代码/列表/表格/引用结构 |
| 分词                 | icu-zh@1，zh-CN，无自定义词典；保持现有ICU词切分＋中文双字补充＋技术标识符处理                                   |
| 召回配置ID / 模式    | balanced / hybrid                                                                                                |
| BM25 / 向量权重      | 0.5 / 1                                                                                                          |
| RRF k                | 10                                                                                                               |
| BM25 / dense候选上限 | 60 / 60                                                                                                          |
| topk / 每篇上限      | 10 / 3                                                                                                           |
| 标题权重 / 最低余弦  | 2 / 0.3                                                                                                          |
| max_context_chars    | 16000，完整业务结果JSON的UTF-16长度上限                                                                          |
| rerank / MMR         | 无                                                                                                               |

默认只选择已经存在并评测过的[固定策略文件](../../examples/profiles/chunkers/markdown-structure-v1.mjs)，不改其算法、尺寸或版本。1500不是强制切断所有结构的绝对上限；80也不是每个相邻块固定重叠80字符。更改切块规则仍应另建策略ID。

依据：[个人开发统一标签对照](../evals/2026-09-18-label-revision-and-current-architecture.md)、[个人最终四臂](../evals/2026-09-18-final-four-arms.md)、[公开全量结果](../evals/2026-09-20-public-full-results.md)。这些结果支持选定一个可复现基线，但不证明它在所有数据、模型、指标上最优；尤其新综合段落F1、中文Du混合排序仍有已记录取舍。采用默认不等于产生新的盲测成绩。

## 模型配置

产品使用用户配置的HTTP embedding API；model、dimensions、base_url由用户填写，key通过环境变量引用，不写入Git。模型调用默认：batch_size=8、timeout_ms=30000、空正文/查询前缀、send_dimensions=true。

qwen3.7-text-embedding/1024是现有评测模型，后续同批对照继续使用它；不是所有用户必须使用的产品默认。默认模型配置ID为default，初始化不会自动获得模型或凭据。

## 参数覆盖与预算

新init会完整写出balanced.json，和[示例](../../examples/profiles/config/retrieval/balanced.json)一致。内置默认→所选配置→单次overrides的优先级不变；topk与单篇上限同时约束，不足时返回实际数量。冻结默认不禁止Agent显式扩大范围。

max_context_chars约束[检索层](../../src/retrieval.ts)完整业务结果JSON，不包括输入请求和MCP外层封装。现有QASPER评测另按“请求＋结果≤16000”，由[辅助函数](../../evals/lib/public-runtime.mjs)扣除请求长度。独立硬预算、游标和预览补读仍未实现，不能作为本次默认功能宣称交付。

## 初始化、构建与兼容

- 新工作区默认选择新综合，同时仍提供heading-1000、heading-500作为显式替代策略。
- 源码开发读取同一固定示例；npm run build通过[资源复制脚本](../../scripts/copy-builtin-strategies.mjs)将原字节复制到dist/strategies，编译后的初始化不依赖仓库examples目录。不是重新实现一套切块算法。
- 不覆盖已有工作区文件。旧显式值（例如rrf_k=30）继续优先；省略字段的稀疏配置仍继承当前代码默认，因此缺省RRF会采用10。
- 旧格式v1的heading helper与迁移语义保留；迁移不把已有heading策略偷偷换成新综合。采用不同chunk策略需要显式选择并同步，表身份仍按策略/分词/模型规则隔离。
- 旧安装升级时需显式放入新综合策略文件并选择对应配置；仅升级程序或重复init不会覆写已有主入口。E盘历史安装和冻结评测本轮未批量迁移，原笔记与旧Chroma不动。

## 后续实验约束

新实验以本表为共同起点，明确记录唯一变化项，不把某个小样本最高分自动回写默认。BM25权重0.4、RRF30、每篇5都是各自已测条件；旧报告保留原条件，不再称作新的产品默认。分词替代研究见[BM25现状与候选](../research/2026-09-20-bm25-tokenizer-options.md)，本次不同时改变分词。

## 验证与剩余边界

本地完整检查175通过、1既有跳过，另6项Python评分回归通过。新增[可移植运行时烟测](../../scripts/verify-default-runtime.mjs)已通过并纳入npm run check：复制dist＋package.json后初始化（复制目录没有src/examples，依赖仍从仓库node_modules解析），核对完整默认、旧显式heading/RRF30不被重复init覆盖、隔离Markdown同步与精确原文行、CLI与真实MCP返回证据一致。新综合源码SHA与QASPER冻结1.0.1逐字节相同；npm pack --dry-run确认CLI/检索实现/策略资源包含在包清单中。[验证收据](../evals/2026-09-20-default-adoption-smoke.json)记录实际检查和边界。两位Luna/max独立复核均无产品阻断。Windows/Linux CI运行同一npm run check（包含编译运行时烟测），结果以本文所在提交的Actions记录为准。

本轮不重跑个人最终集或公开全量、不调用真实模型、不迁移旧E盘安装；隔离烟测不等于模型质量评测。默认采用决定已生效；旧E盘安装的显式升级仍是独立动作。
