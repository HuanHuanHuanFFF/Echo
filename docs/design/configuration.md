# 配置与模块契约

日期：2026-09-15。状态：阶段 1 实现配置校验及类型契约，索引/搜索由后续阶段实现。
替代范围：落定[基线](../project/baseline.md)与[开发计划](../project/2026-09-15-development-plan.md)中的配置、驱动和模块候选。
最新用户要求：默认 embedding 使用 API，由用户配置地址、模型、维度、key；BM25 分词使用本地算法。之前本地 embedding 的选择已撤回，不下载模型。

## 配置

JSON 包含 `database`、`collections: [{id, root}]`、`chunker`、`embedding`、`retrieval`。
`loadConfig` 将相对路径按配置文件目录解析；`parseConfig` 仅校验。
未知键、重复 collection id、非法值明确报错。

内置属性按字段继承默认；自定义 `chunker.options` 由插件解释。
每次检索覆盖先与已生效配置合并，再完整校验，不因默认值填充而重置其他参数。

| 召回参数                           | 起点默认值 | 范围                  |
| ---------------------------------- | ---------- | --------------------- |
| mode                               | hybrid     | hybrid / bm25 / dense |
| topk / max_chunks_per_source       | 8 / 2      | 1–100，各自为硬上限   |
| bm25_candidates / dense_candidates | 60 / 60    | 1–1000                |
| rrf_k                              | 60         | 1–1000                |
| bm25_weight / dense_weight         | 1 / 1      | 0–10，不同时为 0      |
| max_context_chars                  | 12000      | 256–100000            |
| min_dense_similarity               | 0.3        | -1–1                  |

这些是阶段 5 评测前的起点，不是收益结论。采用精确字符预算便于复现，tokenizer 成本在评测中另报。
重排不进入首版；候选数量、融合权重、阈值和预算可调，不开放任意召回算法插件。

## 切块契约

[contracts.ts](../../src/contracts.ts) 定义 `Chunker`：
`id`、`version`、`chunk(input)`，可异步返回连续原文范围数组。
用户模块默认导出该对象，完整替换默认算法；这是可信本地代码，不是笔记指令。

输入 `lines` 保留完整原文件行号，仅包含可用内容；过滤 `echo_id` 字段及值，
`sourceId` 仅作为结构化身份。输出 1-based、两端包含的 `startLine/endLine` 和 `headingPath`；
可选章节范围供宿主补读。不能以一个范围表示不连续片段，也不能跨被过滤字段。
证据原文由 Echo 按范围生成，插件不能直接伪造引用正文。
模块版本、内容和配置变化应触发重新切块，行为在阶段 2 验证。

## 责任与模型接口

- [config.ts](../../src/config.ts)：校验、默认、覆盖与路径解析。
- [database.ts](../../src/database.ts)：SQLite 连接、FTS5 / sqlite-vec。
- `EmbeddingProvider`：维度、指纹、批量生成、query/document 用途、取消信号。
- 后续索引：身份写回、位置映射、差量检测和事务更新。
- 后续检索：统一范围、本地 BM25、API dense、RRF、预算和诊断。
- [server.ts](../../src/server.ts) 适配协议；[cli.ts](../../src/cli.ts) 为进程入口。

embedding 配置为 `provider: http`、`base_url`、`model`、`dimensions`、
`api_key_env`（默认 ECHO_EMBEDDING_API_KEY）、`timeout_ms`（30000）、`batch_size`（8）。
不预设厂商、模型或维度；未配置时允许读取配置和诊断，使用向量功能前必须明确报告缺项。
key 只从用户指定的环境变量读取，不写入配置或索引。
真实 API 接入和评测仍待后续阶段；测试固定向量不能替代效果评测。

## 依赖依据

2026-09-15 查询官方来源并安装固定版本，锁文件可复现：
better-sqlite3 13.0.3、sqlite-vec 0.1.9、MCP SDK 1.30.0、Zod 4.6.5；
TypeScript 7.0.2、Vitest 5.0.0、Prettier 3.9.6。

- [better-sqlite3 官方](https://github.com/WiseLibs/better-sqlite3)
- [sqlite-vec JS 绑定](https://alexgarcia.xyz/sqlite-vec/js.html)
- [SQLite FTS5](https://sqlite.org/fts5.html)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)

Windows 实测 vec0 主键绑定须使用 SQL integer（BigInt）；事务回滚和重开由测试验证。
同步 SQLite 计算不能凭 AbortSignal 中止，后续 MCP 长操作需要合适执行通道。
