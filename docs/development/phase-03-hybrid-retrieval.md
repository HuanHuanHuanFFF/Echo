# 阶段 3：混合检索与配置

日期：2026-09-15。状态：已验收并合并。PR #4 当前提交 7308b23 双平台 CI 全部通过，合并提交 71a2bde。
从阶段 2 合并提交 b6703d7 开始，沿用[计划](../project/2026-09-15-development-plan.md)与[配置契约](../design/configuration.md)。
本阶段将默认 embedding 落定为用户配置的 API；不下载本地 embedding 模型。

## 实现与责任

- [lexical.ts](../../src/lexical.ts)：本地 ICU 中文词分割、连续汉字双字词、完整技术标识符及组成词；词项编码后交给 FTS5，与原文分开。
- [embedding.ts](../../src/embedding.ts)：HTTP 批量调用、环境变量 key、超时/取消、结果按 index 复序、维度/有限数/非零范数校验。
- [store.ts](../../src/store.ts)、[sync.ts](../../src/sync.ts)：全文与向量一起进入原事务边界；失败不发布部分数据，删除清理两路索引。
- [retrieval.ts](../../src/retrieval.ts)：BM25、精确向量召回、RRF、来源硬上限、去重、输出预算与诊断。
- [cli.ts](../../src/cli.ts)：search 管理入口，真实 MCP 搜索留到阶段 4。

## 默认组合与开放参数

默认仍为标题感知 max_chars=1000，hybrid、每路候选 60、RRF k=60、两路权重 1、
topk=8、每篇最多 2、最低余弦相似度 0.3、max_context_chars=12000。新增 title_weight=2（0–20）。
这是阶段 5 的评测起点，未宣称优于 dense-only。
所有召回参数均可通过配置或本次 overrides 部分覆盖，未知键和非法值报错。

本地 lexical 配置为 locale（默认 zh-CN）和 dictionary（默认空，最多 1000 条，每条 200 字符）。
词索引/查询使用同一算法；算法版本、ICU 版本与配置变化需 sync 重建。
并非 jieba、神经分词或远程服务；中文效果需真实语料验证。

API 配置含 base_url、model、dimensions、api_key_env，默认只读取 ECHO_EMBEDDING_API_KEY。
向 base_url/embeddings POST input 数组、model、encoding_format=float；send_dimensions 默认 true，可关闭。
query_prefix/document_prefix 默认空，用户按所选模型契约配置；timeout_ms 默认 30000，batch_size=8。
不自动重试计费请求；调用失败后用户可重试同步。拒绝携带 URL 用户信息、查询串及跳转的服务地址。
未配置 API 时可显式使用 bm25；hybrid 查询模型失败保留 BM25，并标记 partial_failure，dense-only 明确 error。
默认 hybrid 同步缺少 API 配置直接报错，不把无向量索引冒充混合索引。

## 排名、范围与预算

两路在集合、来源 UUID、相对路径前缀范围内选候选，再取各路上限。
向量以 SQLite 扩展的 vec_distance_cosine 对范围内向量精确扫描并排序，无额外服务；首版不使用近似 ANN。
这保证范围语义清楚，成本随候选范围增长，不声明大规模性能。
同一个 chunk 的两路贡献为 weight/(rrf_k+rank)，rank 从 1 开始；单路仍保持其排名。
RRF 分数不是答案置信度。结果保留两路排名、余弦值及 RRF 分数。

topk 和 max_chunks_per_source 同时限制最终 chunk 数；不扩配额填满。
以 chunk_id 去重，不合并不连续原文，也不把相同来源的互补片段强行压成一条。
max_context_chars 限制**整个规范结果 JSON 的 UTF-16 长度**（含路径、证据、配置和诊断），不是 token 数。
只返回完整 chunks；超预算片段被跳过，极低预算容不下状态/配置时明确报错。
诊断包含每路/融合候选数、配额/重复/预算/topk 淘汰计数；不能由有命中推断答案完整。

## 同步兼容与验证

数据库 schema 2 增加 FTS5 和 embeddings 表；阶段 2 的索引应重新 sync 后搜索。
切块、分词、模型指纹变化重建相关片段；API key 轮换不改变向量指纹。
模式切成 bm25 后同步会删除向量，恢复 hybrid 后需要 API 重新同步。

[retrieval.test.ts](../../tests/retrieval.test.ts)覆盖三种模式、中文/标识符、过滤先于候选上限、
数量与完整输出预算、空命中/失败区分、模型/分词变更、失败回滚和本地 HTTP 协议。
普通 CI 无模型 key、无个人笔记；固定向量与本地服务桩仅验证流程，真实语义检索和费用评测尚未完成。

## 官方依据

2026-09-15 查阅：[SQLite FTS5](https://sqlite.org/fts5.html)、
[sqlite-vec API](https://alexgarcia.xyz/sqlite-vec/api-reference.html)、
[Node ICU 支持](https://nodejs.org/api/intl.html)、
[阿里云 embedding API](https://www.alibabacloud.com/help/en/model-studio/text-embedding-synchronous-api)。
通用 HTTP 形状已在本地服务验证，具体供应商/模型由用户配置后做真实验收。

## 独立压力审查与验收

两位只读审查者以 699dd44 为基线，针对 3d14627 / 4c0cb56 复审通过。
修复并建立失败回归：同步写者存在时搜索误写 schema 导致锁冲突、UUID 范围大小写不一致、
极端有限向量产生 SQL NULL 距离后误报为空、dense 全失败顶层状态不准确。
搜索现用只读连接，旧 schema 明确要求 sync；向量在稳定缩放/单位化后转 Float32，转换版本计入指纹。
本地 npm run check：40 项测试、格式、类型、构建通过；构建后的样本 CLI 同步 2 篇/4 块，关键词搜索返回定位正确的原文。
两个审查者各自复跑 17 项检索测试及针对性样本；最终远程 CI 仍以 PR 当前提交为准。

[PR #4](https://github.com/HuanHuanHuanFFF/Echo/pull/4)；[PR CI](https://github.com/HuanHuanHuanFFF/Echo/actions/runs/34957619729)；[push CI](https://github.com/HuanHuanHuanFFF/Echo/actions/runs/34957613378)。GitHub 合并接口停留在进行中后，按授权本地普通合并并核验合并树与已审查头一致，再正常推送 main；远程确认 PR 为 MERGED。
