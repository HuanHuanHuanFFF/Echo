# Echo 项目基线

更新日期：2026-09-06。用途：供用户和后续 Agent 继续讨论、确定开发范围。详细检索方案见[检索设计草案](D:/CodingProject/echo/docs/design/retrieval.md)，测试数据见[探索性基线](D:/CodingProject/echo/docs/evals/2026-09-05-chroma-baseline.md)。

## 1. 已确认决定

| 项目 | 决定 | 含义 |
|---|---|---|
| 项目 | 名称 `echo`，目录 `D:/CodingProject/echo` | 作为新项目推进；文档统一位于 `docs/` |
| 用途 | 为自己的 Markdown 笔记提供日常可用的检索 MCP，同时形成简历项目 | 对外成果必须以实际实现、评测和使用证据为准 |
| 技术栈 | **TypeScript＋SQLite** | 具体驱动、扩展和版本尚未确认 |
| 轻量约束 | 进程内嵌入、无需额外数据库服务 | 已排除 Qdrant 独立服务方案 |
| 检索目标 | BM25＋向量召回、RRF、支持子问题联合查询 | 查询规划归属、融合层次和预算仍需细化 |
| 切块 | 保留适合现有笔记结构的核心规则，移植到 TS | 移植是可接受的一次性小工作，不作为语言选择的主要理由 |
| 资料治理 | Echo 的讨论与开发文档集中管理 | NoteRAG 提供源码与历史实验参考，不继续维护第二份 Echo 基线 |

旧 NoteRAG 的 Java、PostgreSQL、Web Chat 工程约束不自动成为 Echo 的技术要求。本会话目前仅完成资料整理、方案讨论和外部评测分析，没有初始化 Echo 应用代码、安装依赖或验证 MCP 运行。

## 2. 选型理由与当前建议

语言选择主要考虑工具契约、请求编排、安装分发与长期维护。TS 的倾向性推荐以 embedding、重排主要调用 API 为前提；模型部署模式尚未由用户确认。不把类型检查优势表述为检索效果或运行性能优势，也没有同环境的 Python/TS 资源实测。

| 层次 | 当前建议 | 待确认或验证 |
|---|---|---|
| 运行与 MCP | Node.js＋官方 TypeScript MCP SDK，首版 stdio | 运行时与 SDK 版本、多个客户端的进程行为 |
| SQLite 访问 | 显式 SQL 和小型迁移；better-sqlite3 等为候选驱动 | Windows 原生依赖、扩展加载、事务与关闭行为 |
| 关键词 | FTS5 BM25 | 中文分词、技术词典、标识符规则和字段权重 |
| 向量 | sqlite-vec | 所选版本的 API、过滤能力、延迟和更新恢复；不能把 SQLite 的成熟度等同于扩展成熟度 |
| 模型 | 独立 embedding、重排客户端 | 提供方、模型、维度、本地/API 模式、超时及重试 |
| 验证 | 严格类型检查、运行时输入校验、Vitest、固定 JSONL 评测 | 依赖版本与真实 MCP 调用验收 |

FTS5 是 SQLite 官方全文检索模块，sqlite-vec 是第三方向量扩展。两者为同一应用内的 SQLite 提供能力，不是两套独立服务；模型负责生成 embedding，Echo 负责两路检索和结果编排。

SQLite 有利于集中保存原文、元数据、同步状态和检索数据，但 vec0 的 KNN 过滤不等同于任意 SQL，事务和中断行为需实测。LanceDB OSS 是同样无需独立服务的嵌入式备选：已有混合检索能力，也有表版本、索引整理和跨进程刷新事项。仅在 SQLite 路线出现已验证的问题、用户决定调整时重新讨论。

长时间同步索引或数据库计算应有合适的执行通道，避免阻塞 MCP 响应。取消需要向下游传播；结束等待不代表原生计算或远程调用已停止。资源占用以运行时、依赖、模型和数据规模的实测为准。

## 3. 现有资产：按需要读取

### NoteRAG

仓库：[D:/CodingProject/NoteRAG](D:/CodingProject/NoteRAG)。参考职责分工与行为，不默认继承前端、会话和答案生成流程。

| 需求 | 来源 |
|---|---|
| 标题解析与切块边界 | [MarkdownSectionParser.java](D:/CodingProject/NoteRAG/src/main/java/com/huanf/noterag/chunk/MarkdownSectionParser.java)、[MarkdownChunker.java](D:/CodingProject/NoteRAG/src/main/java/com/huanf/noterag/chunk/MarkdownChunker.java) |
| 检索与重排的职责拆分 | [QueryService.java](D:/CodingProject/NoteRAG/src/main/java/com/huanf/noterag/service/QueryService.java) |
| 正文／SUMMARY 的向量文本 | [NoteEmbeddingService.java](D:/CodingProject/NoteRAG/src/main/java/com/huanf/noterag/service/NoteEmbeddingService.java)、[RagTextFormatter.java](D:/CodingProject/NoteRAG/src/main/java/com/huanf/noterag/rag/RagTextFormatter.java) |
| 旧切块对照实验 | [retrieval-baseline-report.md](D:/CodingProject/NoteRAG/src/test/http/responses/compare/retrieval-baseline-report.md) |

旧实验只有单篇 JavaGuide MySQL 文档、15 题；对照为相近切块粒度的 Spring AI baseline。Hit@1 从 80.0% 到 93.3%，两组 Recall@5/10 都为 100%。只支持该样本的靠前排序改善，不能代表八股全库、最终回答质量或 Echo 收益。旧 SUMMARY chunk 是否用于 Echo 是可选实验。

### 八股知识库

知识库：[E:/幻/Documents/八股](E:/幻/Documents/八股)。Markdown 是源数据，Chroma 是可重建检索缓存。

- 核对层级和工作边界：读取 [AGENTS.md](E:/幻/Documents/八股/AGENTS.md)。`10_topics` 为知识主干，`05_scaffolds` 为表达支架，`20_review` 为复习材料；其他层以该仓库规则为准。
- 核对实际切块和载荷：读取 [prepare_chroma_mcp_batches.py](E:/幻/Documents/八股/tools/prepare_chroma_mcp_batches.py)。该脚本生成载荷，实际模型与数据库操作由现有 Chroma MCP 承担。
- 执行查询测试或同步时：读取 [obsidian-rag-importer/SKILL.md](E:/幻/Documents/八股/skills/obsidian-rag-importer/SKILL.md)，按当次任务区分只读检索与索引写入。

脚本默认处理 `20_review`、`10_topics`、`05_scaffolds`。既有检索文本包含“文档标题＋标题路径＋正文”，保留来源、层级、哈希和位置等元数据；不要把它误当成没有上下文的裸片段检索。

Python 和 Java 切块方向一致，但输出尚未证明完全等价。Python 元数据 token 数使用估算，Java 持久化计数使用 CL100K。移植前以固定 Markdown 样本锁定目标行为；原文位置需核对 frontmatter 等处理造成的偏移。

## 4. 当前进展与下一轮决策

12 题 Chroma 探索性评测已完成，原始结果已读取分析。此前“Chroma 出错、尚无结果”的状态已由测试完成事实取代；这不等于本会话已诊断原故障或证明其根因被修复。评测值是历史快照，不是实时服务状态。

下一轮按以下问题推进：

| 顺序 | 问题 | 完成条件 |
|---|---|---|
| 1 | 首版工具和范围 | search/read/status 输入输出、预算、无结果与部分失败行为明确 |
| 2 | 数据关联与更新 | note/chunk/section/source/version 标识、删除重命名、更新可见性和恢复规则明确 |
| 3 | 查询规划和模型 | 原问题与子问题关系、规划归属、API/本地模式及配置明确 |
| 4 | 实现依赖 | Windows 干净环境能安装、加载全文与向量能力并完成一次 MCP 调用 |
| 5 | 最小闭环 | 固定笔记下验证切块目标、过滤、更新中断恢复和取消 |
| 6 | 收益 | 按评测文档完成预算可比的对照，记录覆盖、排序、延迟和成本 |

首版建议集中在 Markdown、本地单用户检索和显式索引同步。Web Chat、账号系统、复杂 Agent 平台、自动多跳和其他文件格式不是当前需求；后续新增需求再调整范围。

## 5. 依赖参考

以下链接是讨论来源，不能替代选定版本的兼容性验证。

- [官方 TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)：核对同一代 SDK、示例与协议。
- [FTS5](https://sqlite.org/fts5.html)：BM25、tokenizer 与全文索引维护。
- [sqlite-vec](https://github.com/asg017/sqlite-vec)、[vec0](https://alexgarcia.xyz/sqlite-vec/features/vec0.html)：绑定、版本和过滤限制。
- [LanceDB](https://docs.lancedb.com/quickstart)、[一致性设置](https://docs.lancedb.com/tables/consistency)：仅在讨论嵌入式替代方案时读取。
