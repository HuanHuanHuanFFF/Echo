# 阶段 4：Agent 查询完整流程

日期：2026-09-15。状态：本地实现与 45 项检查通过，双人压力审查和当前 PR CI 待完成。
从阶段 3 合并提交 71a2bde 开始；承接[计划](../project/2026-09-15-development-plan.md)。
本文件落定[Agent 接口草案](../design/agent-interface.md)中的字段、查询组织、失败与预算；不增加专用读取工具或引用链。

## 输入与结果

[server.ts](../../src/server.ts)提供 echo_search 与 echo_status，两者不修改笔记。
echo_search 接收 query，或 queries 数组（二选一）；最多 8 个独立问题，每项含唯一 query_id、
text 和最多 3 个同意图 variants。Echo 不生成变体、不拆问题，也不自动额外搜索原问题。
过滤与 overrides 沿用[阶段 3](phase-03-hybrid-retrieval.md)，所有子问题共用最终预算。

同意图的重复文本先去重，各次 BM25/dense/RRF 贡献按表达数量平均，再组成该 query_id 的候选榜；
不同 query_id 保留独立榜单，按名次轮流取片段。相同 chunk 只输出一次，保留全部关联 query_id。
每个问题 status 反映检索成功/空/失败/部分失败，returned 说明分配到的证据数；并不证明答案完整。
变体场景的片段排名字段表示各表达的最佳排名，RRF 分数是表达贡献平均值；不应当作单次排名公式或置信度。

输出是一份紧凑 JSON 文本，content 数组只有一项；不再复制正文到 structuredContent。
max_context_chars 限制这份实际 Agent 可见 JSON 的 UTF-16 长度，包含证据、定位、配置和诊断。
普通非法输入/进程错误以 isError 返回，不冒充空命中；成功结果仍同时受 topk 和每篇上限约束。
全部子问题失败时整体 error，部分失败保留成功结果。

## 原文补读

每个片段包含 source_id、collection_id、绝对真实路径 path、relative_path、source_version、
1-based 双端包含的 start_line/end_line、heading_path，以及可选 section_start_line/section_end_line。
证据正文以 LF 表示；文件可以是 CRLF/BOM，行号按写回 UUID 后的完整文件。
Agent 使用宿主已有文件工具读取 path 的片段或章节范围，自己判断补读是否充分并生成回答。
要求笔记修改后先成功 sync；搜索后再编辑产生的时窗不增加一致性协议。

[示例客户端](../../examples/mcp-client.mjs)可在构建后调用真实 stdio MCP：
先按 README 同步样本，再运行 node examples/mcp-client.mjs。
它只调用搜索并展示返回结果；后续文件读取由宿主完成。

## 执行、取消与状态

[executor.ts](../../src/executor.ts)与[search-worker.ts](../../src/search-worker.ts)把 SQLite 检索放到独立 worker，
避免主 MCP 通道被同步数据库计算阻塞。默认最多 2 个在途搜索（runtime.max_concurrent_searches，1–8）；
超过容量明确 busy。总请求期限 runtime.search_timeout_ms 默认 120000（1–600000），与 API 超时分别生效。

MCP 取消信号传入 worker 的 AbortController，继续传给 fetch；随后等待 worker 结束，
必要时调用 terminate。不能把返回等待结束理解为远端模型服务必然停止计费，也不声称原生 C 计算能在任意指令处立即中断。
echo_status 可在查询等待 API 时响应；embedding_configured 仅说明配置字段/key存在，不发付费健康检查。

## 验证与边界

[mcp.test.ts](../../tests/mcp.test.ts)使用独立真实客户端/服务进程，验证多问题共享证据、同意图重复变体、
实际可见 JSON 预算、文件补读一致性、单个 API 失败、在途状态响应、并发上限，以及取消后下游 HTTP 连接关闭。
普通 CI 的 HTTP 服务和向量是隔离协议样本，不构成真实语义检索效果证据。
[foundation.test.ts](../../tests/foundation.test.ts)在独立无配置目录验证启动、列工具与状态，避免依赖开发者配置。

本阶段未修改桌面宿主的长期 MCP 配置，示例通过标准 SDK stdio 客户端调用。
真实模型语义评测、默认组合收益与最终安装交付在阶段 5，仍需真实 API 配置及调用额度。

## 依据

2026-09-15 核对已安装 MCP SDK 1.30.0 的 ToolCallback/RequestOptions，
并查阅[官方取消协议](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)、
[Node worker_threads](https://nodejs.org/api/worker_threads.html)。本地取消与响应性结果来自上述实际测试。

### 本轮 Agent 实际调用与补读

构建后运行标准 SDK 客户端调用 echo_search，收到 recovery/custom 两个 query_id 各自的证据及绝对路径。随后本 Agent 使用宿主 PowerShell 文件工具读取 transactions.md 第 6–12 行（补得 WAL 说明）及 chunking.md 第 9–12 行；与搜索片段一致，额外上下文可读。该证据是 SDK 桥接调用加宿主补读，不表示桌面应用已安装或长期注册 Echo。
