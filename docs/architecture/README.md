# Echo 架构与模块

日期：2026-09-26。状态：当前实现说明，按本地源码提交 `62df00f` 核对；参数以[最新默认决定](../project/2026-09-26-final-default-profile.md)和运行配置为准。本文说明现有模块及边界，不替代[配置契约](../design/configuration-profiles.md)或阶段验收记录。

![Echo 本地索引与证据检索概览](assets/echo-architecture.svg)

[打开可交互架构图](echo-architecture.html)可聚焦模块、追踪连线并导出图像；[图的 Archify 源规范](echo-architecture.json)固定了节点、关系和对应源码。GitHub 中直接查看上方 SVG。

## 一条主线、两类工作

Echo 是供 Agent 调用的本地 Markdown 证据检索 MCP。Agent 自己拆题、决定是否补读原文并组织答案；Echo 接收单个问题，或 Agent 明确给出的多个问题和同意图变体，只返回可定位的证据与检索状态。`matched_query_ids` 表示片段与哪些查询相关，不代表答案已经完整。[MCP 工具说明](../../src/server.ts)和[阶段 4 记录](../development/phase-04-agent-mcp.md)定义了这一边界。

系统有两条工作流：

1. **显式同步**：CLI 读取当前配置，扫描所选笔记目录，写入缺失的 `echo_id`，按固定策略切块，生成本地词项，并按需调用用户配置的 HTTP embedding API 生成文档向量；最后在一个 SQLite 事务中发布所选索引。[入口](../../src/cli.ts)、[同步实现](../../src/profile-sync.ts)。
2. **只读搜索**：MCP 每次请求读取一份配置快照，交给可复用的搜索 Worker；Worker 在 SQLite 只读事务中检查索引就绪、应用来源过滤、取词法和向量候选，融合并按数量及响应预算装箱。结果包含原文、真实文件路径和行范围。[服务](../../src/server.ts)、[检索](../../src/retrieval.ts)。

一个 v2 工作区的主配置选择 chunker、tokenizer、embedding 和 retrieval ID，并指定一个 SQLite 文件。`sources.json` 可配置多个集合及各自的本地 Markdown 根目录；它们进入同一个所选数据库，`source_id` 在该数据库内唯一。不同工作区选择不同数据库路径即可隔离文件；同库内部再按策略与模型身份隔离索引表，不能把“一个目录”误当作“一张独立数据库”。[配置加载](../../src/profiles.ts)、[表身份](../../src/profile-store.ts)。

## 模块职责

| 责任           | 主要模块                                                                                                                                                                                                                   | 行为                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 命令与配置管理 | [cli.ts](../../src/cli.ts)、[profile-manager.ts](../../src/profile-manager.ts)、[profiles.ts](../../src/profiles.ts)、[config.ts](../../src/config.ts)                                                                     | `init`、`config list/show/use/migrate`、`sync` 和 `search`；校验配置 ID、文件及策略资源，形成请求快照；召回参数按内置默认→所选配置→单次覆盖解析。 |
| 原文身份与切块 | [identity.ts](../../src/identity.ts)、[chunker.ts](../../src/chunker.ts)、[lexical.ts](../../src/lexical.ts)                                                                                                               | 校验并补写 frontmatter UUID；按原文连续行切块、保留标题路径；本地 ICU 中文词项及技术标识符扩展。frontmatter 不进入检索正文。                      |
| 同步与持久化   | [sync.ts](../../src/sync.ts)、[profile-sync.ts](../../src/profile-sync.ts)、[profile-store.ts](../../src/profile-store.ts)、[database.ts](../../src/database.ts)                                                           | 扫描真实 Markdown、计算变更，维护来源、chunk、词项和向量表；按身份复用已有数据，检查 readiness，事务提交时发布索引版本。                          |
| 向量服务       | [embedding.ts](../../src/embedding.ts)                                                                                                                                                                                     | 通过用户配置的 HTTP API 批量取得文档/查询向量，校验顺序、维度和数值；密钥取自环境变量，不保存到配置。                                             |
| 词法缓存与检索 | [minisearch.ts](../../src/minisearch.ts)、[retrieval.ts](../../src/retrieval.ts)                                                                                                                                           | 从 SQLite 已保存的词项构建 Worker 内 MiniSearch 缓存；范围过滤先于候选截断，随后合并 BM25/dense、RRF 排名、跨问题去重与预算装箱。                 |
| MCP 与执行隔离 | [server.ts](../../src/server.ts)、[search-pool.ts](../../src/search-pool.ts)、[search-session-worker.ts](../../src/search-session-worker.ts)、[executor.ts](../../src/executor.ts)、[transport.ts](../../src/transport.ts) | 提供 `echo_search`/`echo_status`；搜索 Worker 串行处理各自请求并可复用，主协议通道保持响应；控制并发、取消、超时及 stdio 错误边界。               |

### 配置与策略快照

主入口 `echo.config.json` 保存四类活动 ID 和数据库位置；切块/分词策略 `.mjs`、embedding/retrieval JSON、sources/runtime/logging 文件分开加载，路径相对主入口解析。固定策略须由文件名对应的 ID 与版本导出；代码和声明资源被捕获并参与指纹，同一次索引与查询使用相应分词快照。v2 不用外部数字选项临时改写固定切块算法，换规则应新建策略 ID 并显式同步。[加载实现](../../src/profiles.ts)、[v2 契约](../design/configuration-profiles.md)。

新默认 `markdown-structure-v1@1.0.1` 保留标题、代码、列表、表格和引用结构：目标约 1000 字符，常规最大约 1500，短块阈值 200，超长单元回退时按整行 overlap 80 字符。1500 不是所有结构的强制断点，80 也不是每对相邻块的固定重叠。[默认冻结记录](../project/2026-09-20-default-freeze.md)。

### 索引身份、缓存与失败恢复

SQLite 是持久层：保存来源、原文 chunk、FTS 词项和向量。v2 登记的 chunk 身份由切块策略及其指纹决定，词项索引再绑定 tokenizer 身份，向量索引再绑定 embedding 身份；更换召回评分参数本身不重切或重算向量。切换切块、分词或模型后，旧组合可保留，但新组合缺失或来源快照变化会要求显式 `sync`。[表登记与就绪检查](../../src/profile-store.ts)、[同步](../../src/profile-sync.ts)。

默认 MiniSearch 是从这些 SQLite 词项构建的**可重建内存缓存**，不是另一份持久数据库。每个搜索 Worker 最多保留一个词法组合；缓存键绑定数据库真实路径、chunk/FTS 表和成功同步发布的 `index_revision`。两个并发 Worker 可各保留一份，旧库没有可靠版本时不跨请求复用。显式 `lexical_engine=sqlite` 仍可用。[缓存实现](../../src/minisearch.ts)、[采用记录](../project/2026-09-21-minisearch-default.md)。

同步在 `BEGIN IMMEDIATE` 后准备来源，完成后才提交表数据及索引版本；错误或取消会回滚数据库，旧的完整提交仍供读者使用。**原文文件不是 SQLite 事务的一部分**：缺失 UUID 时已写入 Markdown 的 `echo_id` 不随数据库回滚撤销，重试同步复用该 ID。同步期间外部编辑可能使本次失败；Echo 不自动监听文件变化。[源码](../../src/profile-sync.ts)、[阶段 2 恢复边界](../development/phase-02-import-sync.md)。

### 请求、排名与证据

`echo_search` 接收一个 `query`，或最多 8 个带唯一 `query_id` 的独立 `queries`，每个最多 3 个由调用方提供的同意图 `variants`。集合、来源 UUID、相对路径前缀过滤在候选截断之前生效。词法默认 MiniSearch BM25+，取消其原生“匹配查询词数量”乘数；向量路在 SQLite 中用余弦距离精确检索。两路按 `weight / (rrf_k + rank)` 融合，排名从 1 开始；RRF 分数不是答案置信度。[输入与实现](../../src/retrieval.ts)、[默认决定](../project/2026-09-21-minisearch-default.md)。

同意图变体的贡献按表达式数平均、按 chunk ID 合并；不同问题保留各自候选榜，最终按名次轮流取完整片段并去重。`topk`、每篇来源上限和 `max_context_chars` 同时约束输出，数量不足不会强行填满。预算计算对象是完整业务结果 JSON 的 UTF-16 长度，包含定位、选择和诊断；它不是 token 预算，也没有独立的请求加响应硬上限。各问题明确标为 `ok`、`empty`、`partial_failure` 或 `error`，向量服务部分失败时仍可保留可用证据。[结果装箱](../../src/retrieval.ts)、[阶段 4 契约](../development/phase-04-agent-mcp.md)。

每条证据包含 `source_id`、集合、绝对真实路径、相对路径、`source_version`、标题路径，以及从完整原文计数的 1-based、两端包含的片段行与可选章节行范围。Agent 可使用宿主文件工具按路径与行号补读；Echo 没有专用读取工具，也不保证搜索后原文未被外部程序再修改。[证据结构](../../src/retrieval.ts)、[原文身份](../../src/identity.ts)。

### 运行配置与热切换

`config use` 在所有目标配置校验通过后原子更新主入口，不触发模型调用或索引重建。MCP 从下一请求加载新组合，在途请求保留已取得的配置和 SQLite 快照。读取过程中配置文件变化或损坏会使本次请求失败，不混用半份配置。数据库路径或运行参数改变会返回 `RESTART_REQUIRED`，需要重启服务；切到缺失/过期索引则提示显式同步。[配置管理](../../src/profile-manager.ts)、[请求重载](../../src/config-runtime.ts)、[服务](../../src/server.ts)。

默认最多两个在途搜索，超额返回 busy；取消或超时后失败 Worker 被丢弃。`echo_status` 只检查配置和索引状态，`embedding_configured` 仅说明字段与 key 存在，不是付费 API 健康检查。embedding 调用不自动重试计费请求。[Worker 池](../../src/search-pool.ts)、[状态工具](../../src/server.ts)、[模型调用](../../src/embedding.ts)。

## 当前默认与未实现范围

**新建 v2 工作区**默认 `markdown-structure-v1@1.0.1`、`icu-zh@1`、MiniSearch 7.2.0、`hybrid`；MiniSearch k/b/d 为 1.2/0.7/0.5，BM25/dense 权重 0.5/1、RRF k=10、两路候选各 60、topk=10、每篇最多 6、完整结果 JSON 预算 20000。初始化只生成这一套切块与召回配置；已有显式配置优先，重复初始化不覆盖或删除旧文件。[完整参数及升级边界](../project/2026-09-26-final-default-profile.md)。

游标翻页、独立预算硬上限、rerank/MMR、索引预览后再由 Echo 补读、专用读取工具尚未实现。图中返回“证据 JSON”只表示检索结果；答案生成与证据充分性判断仍由 Agent 负责。[当前决定](../project/2026-09-21-minisearch-default.md#后续调参纪律与剩余边界)。
