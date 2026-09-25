# MiniSearch 默认采用与参数基线

日期：2026-09-21。状态：用户已确认；产品接入、本地验证、双平台CI与两位Luna/max独立复核完成。

## 决定与替代范围

用户确认“默认取消，当前默认先这样确定，后续改参数在这个上面改”。本决定将产品词法评分默认从 SQLite FTS5 切换为 MiniSearch 7.2.0，并固定取消原生的“匹配查询词数量”乘数；保留库默认 k/b/d。替代[2026-09-20冻结记录](2026-09-20-default-freeze.md)的词法引擎范围，以及[取消乘数评测](../evals/2026-09-21-minisearch-without-coverage.md)当时“尚未切换产品”的状态。其余已确认参数不变；旧报告仍记录原条件和分数。

| 项目             | 当前默认                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| 切块             | markdown-structure-v1@1.0.1；目标1000、常规最大1500、短块200、超长单元回退overlap80字符 |
| 分词             | icu-zh@1，zh-CN，无额外词典；现有ICU/中文双字/技术标识符扩展保留                        |
| 词法引擎         | lexical_engine=minisearch；BM25+，取消匹配词数量乘数                                    |
| MiniSearch参数   | minisearch_k=1.2、minisearch_b=0.7、minisearch_d=0.5                                    |
| 模式 / 配置ID    | hybrid / balanced                                                                       |
| BM25 / dense权重 | 0.5 / 1                                                                                 |
| RRF k            | 10                                                                                      |
| BM25 / dense候选 | 60 / 60                                                                                 |
| topk / 每篇最多  | 10 / 3，同时作为上限                                                                    |
| 标题 / 正文权重  | 2 / 1                                                                                   |
| 最低向量余弦     | 0.3                                                                                     |
| 完整结果JSON预算 | max_context_chars=20000，UTF-16长度                                                     |
| rerank / MMR     | 无                                                                                      |

切块尺寸与重叠的适用边界继续见[前版冻结记录](2026-09-20-default-freeze.md)，1500不是所有结构的强制断点，80不是所有相邻块的固定重叠。模型仍由用户配置HTTP API、模型ID、维度及key环境变量；qwen3.7-text-embedding/1024仅是既有评测条件。

## 2026-09-21 预算修订

状态：用户已确认默认预算上调至20000。本条仅替代本页原16000预算；每篇上限仍为3，其他参数不变。内置默认、示例balanced和新init同步采用20000；已有配置显式写入的16000或其他值仍优先，重复init不覆盖。单次overrides继续可用，未新增独立预算硬上限。

依据[参数探索](../evals/2026-09-21-minisearch-parameter-exploration.md)：固定BM25=0.31、dense=1、RRF10、cap6时，累计请求＋响应预算16000→20000，使自建200题预算排除63→1题、平均累计字符13814→14391；完整190/196和事实392/403不变。该实验参数与产品默认并不相同，不能宣称本次提高了默认检索覆盖。产品max_context_chars约束完整响应JSON的UTF-16长度；历史评测累计预算与冻结结果保留，不因本次改动重写。E盘安装和冻结runtime本次不覆盖。

验证入口：既有配置继承/覆盖、CLI配置展示和可移植初始化/CLI/MCP烟测；增加旧显式16000在重复init后仍保留的断言。下方MiniSearch接入的331题结果与原CI记录属于本次修订前的16000基线。

当时的[运行时烟测原始回执](../evals/2026-09-21-minisearch-default-runtime-smoke.json)保留MiniSearch默认值、CLI/MCP证据一致和零新增embedding调用；其中16000预算是本节上调至20000前的历史值。

本次npm run check通过：188项通过、1项既有跳过，格式/类型/构建/默认CLI与MCP烟测均通过；旧显式16000保持验证通过，新增API为0。历史评测测试补上显式16000，避免产品默认变化改变冻结对照。首轮另有两项MCP测试遇到本地随机端口的fetch bad port错误，未修改MCP实现，完整重跑通过。

## 配置与兼容

新init写出[完整balanced配置](../../examples/profiles/config/retrieval/balanced.json)。召回文件和单次overrides均支持lexical_engine、minisearch_k/b/d；优先级仍为内置默认→所选配置→单次覆盖。k范围(0,100]、b范围[0,1]、d范围[0,100]；非法值拒绝。SQLite兼容模式显式设置lexical_engine=sqlite，MiniSearch参数在该模式不参与评分；FTS5自身k1/b不可通过这几个字段调整。

取消乘数是MiniSearch产品评分规则，没有另设打开原生乘数的开关。对全部命中文档先除以实际匹配查询词数，再按分数降序/ID排序，最后取候选上限；不只重排旧的前60条。前缀和模糊匹配关闭，词间OR；分词、编码、词频与MiniSearch的唯一词项字段长度定义均与已测版本一致。

升级程序不会改写配置文件。旧配置省略lexical_engine时继承新的MiniSearch默认；要保持旧词法排序需显式填sqlite。已有chunk、模型、分词和召回显式值保留。引擎/k/b/d属于召回配置，不参与表身份，单纯切换它们不需重新embedding。

已有SQLite词项直接复用，成功sync在同一事务发布index_revision。无此字段的旧库仍可查询，但跨请求不缓存；一次正常sync后启用缓存。失败sync不发布新版本，旧完整索引仍可用。重复init不会覆盖已有策略或配置；切换新的chunk仍需显式配置并同步。

本次修改仓库产品与初始化入口；E盘历史安装、冻结benchmark runtime、个人笔记和旧Chroma均未就地改写。旧安装需更新程序后才运行本实现。

## 模块与运行行为

- [minisearch.ts](../../src/minisearch.ts)：从SQLite已保存的标题/正文词项派生内存索引，评分、过滤、取消乘数和候选截断；不另存一份个人正文。
- [retrieval.ts](../../src/retrieval.ts)：在同一SQLite只读事务完成索引就绪检查、来源过滤、候选与原文定位读取；RRF、子问题合并及结果预算逻辑保持。
- [sync.ts](../../src/sync.ts)、[profile-sync.ts](../../src/profile-sync.ts)：成功提交时原子更新缓存版本；失败回滚不变。版本覆盖整个数据库，未变化的成功sync也会保守刷新缓存。
- [search-pool.ts](../../src/search-pool.ts)、[search-session-worker.ts](../../src/search-session-worker.ts)、[server.ts](../../src/server.ts)：MCP复用工作线程，每线程一次只跑一个请求、保留一个词法组合缓存。新请求重新读取配置快照及SQLite版本；取消/超时失败的线程丢弃，关闭MCP释放缓存和线程。
- [config.ts](../../src/config.ts)：默认值、参数范围、部分覆盖；MiniSearch为生产依赖并固定版本/lockfile。

SQLite继续持久化来源、chunk、FTS词项和向量，MiniSearch索引是可重建的RAM缓存。数据库路径＋chunk/FTS表名＋同步版本作为缓存键；切换模型/召回参数无需重复建词法索引，切换切块/分词则选择对应表。旧库没有可靠版本时仅同一请求内复用。

默认并发仍2，两个工作线程可能各保留一份索引，内存占用可叠加；CLI独立进程每次有冷启动。大规模个人库内存和冷启动延迟仍需按实际机器检查，不能从小样本成功推导任意规模可用。可降低服务并发或显式使用SQLite兼容引擎。不会启动外部搜索服务。

## 验证与依据

- 本地npm run check通过：188项测试、1项既有跳过；格式、类型、构建、可移植初始化/CLI/MCP烟测通过。普通CI仅用隔离样本，不需模型key。
- [MiniSearch产品回归](../../tests/minisearch.test.ts)：库评分与冻结评测适配器一致；原生第61名在取消乘数后进入第1；过滤先于候选截断；标题权重0、参数覆盖、取消未完成构建、缓存复用、内容/路径/删除刷新、旧库兼容、真实Worker复用/并发取消/超时/关闭。
- [多配置同步回归](../../tests/profile-index.test.ts)：分词/模型/切块组合隔离、向量复用、失败同步回滚版本；[MCP回归](../../tests/mcp.test.ts)和[热切换回归](../../tests/profile-runtime.test.ts)通过。
- [产品候选等价收据](../evals/2026-09-21-minisearch-production-parity.json)：LangChain20、Godot10、Du200、QASPER101共331题，16279条候选ID/顺序/原始分数全部精确匹配取消乘数的冻结实验。由[只读复核脚本](../../evals/verify-minisearch-production.mjs)运行实际dist模块，完整库49505/25477/100001/7404块；数据库及候选文件哈希前后不变，新增API调用0。这是接入等价验收，不是新的端到端混合检索或盲测成绩。
- 两位Luna/max独立复核均无功能阻断。审查提出的MCP引擎热切换测试缺口已补齐：MiniSearch→SQLite→MiniSearch、b参数覆盖和在途配置快照，审查者独立9/9通过。旧库缺少版本时重复冷建的性能边界保留，建议升级后正常sync一次启用缓存。
- 实现提交8630799的[Windows/Linux CI](https://github.com/HuanHuanHuanFFF/Echo/actions/runs/35526899092)全部通过（npm run check及6项Python评分回归）。npm pack --dry-run确认MiniSearch、池/线程入口及固定chunk策略在运行包清单中。没有用模拟embedding证明语义质量。

工程依据：[MiniSearch官方API](https://lucaong.github.io/minisearch/classes/MiniSearch.MiniSearch.html)；[Node工作线程复用/ref/unref](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)。实际规则以锁定的7.2.0代码及本地回归为准。采用缓存版本而非新连接的[SQLite data_version](https://www.sqlite.org/pragma.html#pragma_data_version)，因为后者只适合同一连接比较。

## 后续调参纪律与剩余边界

以本表为共同起点，一次改变一个明确变量；保存完整参数、语料、题目、embedding、候选及上下文预算。已打开的小样本可继续探索，但不称为新的盲测。

此次采用基于已测331题的取舍与用户选择，不宣称全面胜过SQLite或纯向量：取消乘数后LangChain混合与Du纯BM25改善，QASPER混合完整覆盖从50/78降至48/78。详细分母、指标和局限保留在[冻结评测](../evals/2026-09-21-minisearch-without-coverage.md)。

游标、独立预算硬上限、索引预览后补读、专用读取工具以及rerank均未在本次实现；Echo继续只返回证据，由Agent拆题与生成答案。
