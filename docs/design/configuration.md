# 配置与模块契约（旧格式）

2026-09-16：新工作区使用 [v2 配置契约](configuration-profiles.md)。本文保留旧格式、历史评测和兼容接口依据；不覆盖最新固定策略和多索引决定。

日期：2026-09-15。状态：接口已实现；默认 hybrid 组合的真实语义效果仍待阶段 5。
本文落定[基线](../project/baseline.md)中的配置、切块和模块候选；旧日期设计保留为历史。
最新用户决定：embedding 默认由用户配置 API/key；BM25 使用本地算法。

2026-09-17：下表的 topk、每篇上限和 BM25 权重按用户决定更新为 10、3、0.5；替代范围与兼容行为见 [v2 召回契约](configuration-profiles.md)。历史评测参数保持原记录。

2026-09-18：RRF与返回JSON预算默认值按用户新决定改为30、16000，旧格式同样按字段继承；已有显式配置与历史评测不改写。见[v2当前契约](configuration-profiles.md)。

## 配置与覆盖

[config.ts](../../src/config.ts)是可执行字段校验依据。JSON 包含 database、collections、chunker、
lexical、embedding、retrieval、runtime。相对路径以配置文件目录解析。
内置属性按字段继承默认；未知字段和非法数值报错。自定义 chunker.options 由模块解释。
单次 overrides 先合并配置，再完整校验；不能用默认值覆盖用户已设置的其他参数。

| retrieval 字段                     | 默认    | 合法范围                                     |
| ---------------------------------- | ------- | -------------------------------------------- |
| mode                               | hybrid  | bm25 / dense / hybrid                        |
| topk / max_chunks_per_source       | 10 / 3  | 1–100，两个硬上限                            |
| bm25_candidates / dense_candidates | 60 / 60 | 1–1000                                       |
| rrf_k                              | 30      | 1–1000                                       |
| title_weight                       | 2       | 0–20，正文权重为 1                           |
| bm25_weight / dense_weight         | 0.5 / 1 | 0–10，不同时为 0                             |
| min_dense_similarity               | 0.3     | -1–1                                         |
| max_context_chars                  | 16000   | 256–100000，实际紧凑结果 JSON 的 UTF-16 长度 |

单次 filters 支持 collections、source_ids、path_prefix；空 ID 数组表示空范围。
UUID 规范成小写；两路在范围内取候选。当前不开放任意召回算法插件或重排器。

## 切块与定位

[contracts.ts](../../src/contracts.ts)定义 Chunker：id、version、chunk(input)，可以异步返回范围数组。
配置 module 的默认导出完整替换算法；它是用户可信的本地程序，不是笔记中的指令。

输入 lines 保留完整原文件的行号，但整个 frontmatter 不进入切块；sourceId 仅为结构化身份。
输出 startLine/endLine 为 1-based、两端包含；headingPath 表示章节，sectionStartLine/sectionEndLine
可供补读。产物不能越界或跨过滤区；证据文本由 Echo 从原文行生成，插件不能伪造正文。

默认 echo-heading-lines@1 保留 ATX 层级，围栏代码中的伪标题不改变层级；
同 section 内按 max_chars=1000（64–100000）聚合整行、去掉边缘空行、不重叠。
单行可超过软上限；结构父标题目前可以形成独立 chunk。
[结构标题示例](../../examples/structural-heading-chunker.mjs)是完整自定义候选，尚未替换 hybrid 默认方案。

主模块字节、导出版本、配置参与指纹。模块依赖变化须提升版本并重新同步。
切块/分词/embedding 指纹变化由 sync 重建；查询参数变化不要求重切块。

## 本地词项与 API embedding

lexical.locale 默认 zh-CN，dictionary 默认空（最多 1000 条，每条最多 200 字符）。
实现为本地 ICU 词分割、汉字双字词和技术标识符拆分；词项与原文分别存储。
算法/ICU/词典变更需要同步。

embedding.provider 固定 http。用户填写 base_url、model、dimensions；
api_key_env 默认 ECHO_EMBEDDING_API_KEY，仅从环境变量读 key。
timeout_ms=30000（1–600000）、batch_size=8（1–128），query_prefix/document_prefix 默认空，
send_dimensions=true（不兼容的服务可关闭）。接口为 POST base_url/embeddings。
不自动重试计费请求；用量统计是请求尝试数和服务明确报告的 token，未知值为 null。

向量按稳定幅值缩放后单位化，再转 Float32；规则计入指纹。拒绝无效维度、非有限值和零范数。
API key 轮换不改变向量指纹。bm25 模式同步不保留向量，恢复 hybrid 后需重新同步。
API 模型不可用时 hybrid 明确 partial_failure，dense 明确 error。

## 执行与资源

database.ts 管理 SQLite；store.ts/sync.ts 管理事务快照与索引；retrieval.ts 管理召回、融合和预算。
server.ts/transport.ts 适配 MCP；executor.ts/search-worker.ts 让数据库计算离开主通道。
runtime.search_timeout_ms 默认 120000（1–600000），max_concurrent_searches 默认 2（1–8），
状态查询另限一个在途任务。取消/断连会传播并回收 worker。

普通错误（含 SDK 参数校验）编码成不超过 256 字符的 JSON。
完整搜索失败仍按本次配置预算返回全部 query_id 诊断。
同步期间源文件需稳定；搜索后再次编辑不增加一致性协议。
具体恢复与协议证据见[阶段 2](../development/phase-02-import-sync.md)、
[阶段 3](../development/phase-03-hybrid-retrieval.md)、[阶段 4](../development/phase-04-agent-mcp.md)。

## 依赖依据

锁定版本见 package-lock.json；Windows/Linux 实际验收见阶段 PR。
实现参考：[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)、
[sqlite-vec JS](https://alexgarcia.xyz/sqlite-vec/js.html)、
[FTS5](https://sqlite.org/fts5.html)、
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)。
官方能力、确定性测试与真实模型效果分别记录，不相互替代。
