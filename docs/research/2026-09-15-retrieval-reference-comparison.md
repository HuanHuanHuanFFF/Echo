# Echo 检索参考补充：QMD、Basic Memory 与 Qdrant MCP

日期：2026-09-15。状态：**官方文档与固定提交源码调研；建议尚未确认或实现**。本轮关注查询组织、命中后的探索、工具与存储的职责分离。与 [2026-09-09 调研](2026-09-09-agent-retrieval-interfaces.md)互补，不覆盖旧快照。

## 1. 结论与阅读入口

**QMD 作为检索主流程参考，Basic Memory 作为证据导航参考，Qdrant MCP 作为小型适配层参考。** Basic Memory 当前源码的按行读取和轻量关系导航，比只看 search_notes/read_note/build_context 三个工具名更值得借鉴。

| 项目 | 已核对的机制 | Echo 值得借鉴 | 采用边界 |
|---|---|---|---|
| QMD | typed queries → 各路召回 → 按文件融合 → 选块重排 → query/get | 同意图融合、分阶段诊断、搜索与读取分离 | 单份排名不是独立子问题的覆盖契约；参数需要自己的实验 |
| Basic Memory | Markdown 解析关系、search_notes、范围 read_note、compact build_context | 明确链接导航、连续读取、先返回入口再读正文 | 首版可只做一跳显式链接；无需引入完整记忆写作与治理系统 |
| Qdrant 官方 MCP | 工具注册 → Connector → EmbeddingProvider → 存储 | 固定配置收敛参数、只读工具注册、模型适配边界 | 本次 MCP 搜索实现是向量路径，不提供 Echo 的完整检索与定位流程 |

已确认的 TS＋SQLite、Agent 拆问题、Echo 只返回证据、UUID v4 身份规则以[项目基线](../project/baseline.md)为准。下文“建议”没有改变这些决定。

## 2. 参考版本和证据边界

| 仓库 | 本地参考目录 | 本轮固定提交 |
|---|---|---|
| [tobi/qmd](https://github.com/tobi/qmd) | references/qmd-2026-09-15 | 04e4dbd8245c527a88f1a8f0bda547aef9ca81fb |
| [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) | references/basic-memory | 79a422256ffe7892f171cb8a27d24e721f927565 |
| [qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant) | references/mcp-server-qdrant | c56ae5adf62bb78d852bf7bbcbc5d7b75e2bbe41 |

三者均为本轮取得的浅克隆，位于已忽略的 references/；旧 references/qmd 保留供前次报告复查。本轮没有安装依赖、下载模型、运行服务器或测试套件，也没有修改个人笔记、索引。源码存在、测试有断言、当前环境运行通过是不同证据等级。

官方网页访问日期均为 2026-09-15。Basic Memory 的[工具参考](https://docs.basicmemory.com/reference/mcp-tools-reference)没有完整列出本轮源码中的 start_line/end_line、compact；其云端 review/checksum 文档也不能作为本地 read 的版本保证。以下行为以固定源码为准，不把 main 分支能力等同于任意已发布安装包。

## 3. QMD：学习编排过程，不直接继承排名策略

### 3.1 searches 是一项检索意图的多种表达

MCP 同时提供两条入口：query 由服务展开；searches 直接执行调用方提供的 lex/vec/hyde 查询。后者适合 Echo 的 Agent 规划边界，但应理解它的语义。

structuredSearch 先执行 lex，再批量生成 vec/hyde 向量；各列表进入同一次 RRF。接着优先选第一个 lex（否则 vec）作为主查询，给每篇文档选一个片段并重排。最终是一份结果列表，MCP 不返回各独立子问题的分组覆盖状态。[工具入口](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/mcp/server.ts#L330-L405)、[召回与融合](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/store.ts#L6007-L6088)、[重排](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/store.ts#L6162-L6189)。

对 Echo 的推论：同一个“审批如何恢复”问题，可以融合关键词与自然语言表达；“审批恢复”“状态迁移”“Trace 审计”则应保留独立 query_id、候选与结果状态。跨问题可以共享 embedding 批次、去重片段和分配总预算，不能因为请求是数组就无条件压成一个榜单。跨意图融合不是数学上禁止，而是会改变优化目标，需要另行验证覆盖。

### 3.2 它的 RRF 包含额外策略

本轮代码使用按文件键累加的加权 RRF，还加入靠前名次奖励；重排后继续按 RRF 名次分段混合重排分数。这是一套完整启发式，并非只有标准 RRF 公式。[融合函数](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/store.ts#L4657-L4701)、[混合分数](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/store.ts#L6176-L6189)。

还有一个静态可见的细节：工具说明称“第一个子查询 2 倍权重”，实现实际给**第一个非空结果列表**加权；列表先按 lex、再按 vec/hyde 构造，也受集合顺序影响。因此输入数组顺序并不总能表达文档描述的优先级。本轮未运行复现。[参数说明](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/mcp/server.ts#L338-L341)、[列表构造及权重](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/store.ts#L6007-L6074)。

Echo 建议先实现可解释的基础融合，权重绑定到明确的查询／召回路标识；额外奖励和重排混合留作单独实验。保留 query_id、召回路、原始排名、融合贡献、候选被截掉的位置，便于诊断“没找到、被挤掉、上下文不足”。QMD 的 [RRF trace 测试](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/test/rrf-trace.test.ts#L5-L44)核对贡献与总分，值得参考这种验证方式；本轮未执行它。

### 3.3 搜索与读取分离继续适用

get 接收命中的 file/docid、起始行和行数；实际读取 SQLite 保存的文档再切行，仍不是实时磁盘正文，也没有 source_version 入参。[读取参数](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/mcp/server.ts#L440-L451)、[索引正文读取](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/store.ts#L4963-L5005)。

Echo 保留自己的 UUID、版本、实际行范围及可调用 read_more。文档聚合可减少同篇占位，但不能因此固定每篇只返回一个片段；综合问题可能需要同篇中多个互补章节。

另一个可做小实验的点是中文 FTS：QMD 将连续 CJK 字符按单字加空格，并转换相应查询，而不是直接把中文交给普通 unicode61 分词。[规范化实现](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/store.ts#L878-L884)。这可以作为低依赖基线，与中文分词＋技术词典比较；存在实现不证明它更适合 Echo 的中文笔记。

## 4. Basic Memory：最有新增价值的是证据导航

### 4.1 关系来自可追溯的 Markdown 链接

Basic Memory 区分笔记实体、局部 observation 和 relation。显式关系可以携带 depends_on 等标签，普通链接则可形成 links_to；不需要依靠向量相似度猜一条关系。[官方关系说明](https://docs.basicmemory.com/concepts/observations-and-relations)。

本轮源码还解析普通 Markdown 链接，由 Markdown 解析器处理链接语法与代码排除，并按来源文件解析相对路径。[关系抽取](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/markdown/entity_parser.py#L158-L192)、[链接目标规范化](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/markdown/path_links.py#L7-L29)。

对 Echo 的最小建议：保留现有 Markdown 写法，先识别已有 `[[笔记]]` 和 `[标题](相对路径.md)`，记录来源、链接所在范围、目标及解析状态。只把可确定的目标绑定到 source_id；重名或失效链接返回未解析状态。无需要求用户将所有笔记改成 observation 格式，也不需要额外图数据库。

这里“关系成立”只表示笔记作者写下了链接或关系标签，不表示目标正文一定支持当前问题；Agent 仍需读证据。

### 4.2 build_context 是有界遍历，不是再次语义检索

服务从来源实体出发，以递归 SQL 查询 relation 和关联 entity，包含入链／出链与防止循环回访的路径记录；调用者控制深度。SQLite 就能承载这种显式图关系。[遍历入口](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/services/context_service.py#L314-L395)、[SQLite 查询](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/services/context_service.py#L618-L742)。

compact=true 在返回阶段省略笔记和 observation 正文，保留导航标识及关系信息，调用方再 read_note。这种“先选入口再读全文”很适合 Echo。[compact 输出](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/mcp/tools/build_context.py#L383-L404)。

但不能把相关参数照搬为性能保证：

- compact 发生在组装图之后，减少输出不等于减少遍历工作，也不是 token 上限。
- max_related 在服务中传作最终相关结果的总上限，包含关系行与实体行；不是每层各有 N 篇笔记。网页“per level”描述不能替代代码语义。
- page/page_size 分页的是起始结果；has_more 根据起始结果数量计算，不证明所有相关节点已返回。
- 工具默认 timeframe 为 7d，日期过滤会参与扩展；面向长期学习笔记，Echo 不应直接继承这一时间窗口。

证据：[默认值与参数边界](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/mcp/tools/build_context.py#L182-L230)、[结果数量与分页](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/services/context_service.py#L215-L267)、[排序及总限制](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/services/context_service.py#L721-L742)。

Echo 建议先把一跳出链做成读取结果中的可选导航项；入链需要索引后再提供。每项保留“为何相关”的链接来源，而不是自动附带所有目标正文。是否增加独立 relations 工具，等实际使用证明 read 的返回形式不够再决定。跨库遍历、多跳自动扩展暂不加入首版范围。

### 4.3 read_note 已有行范围，但续读语义与 Echo 不同

当前源码提供 start_line/end_line，两端包含，从完整 Markdown（含 frontmatter）编号；明确范围读取不会删除头部行。JSON 带实际范围、total_lines、has_more、next_start_line/next_end_line；没有预期版本参数，工具注释明确承认两次读取间编辑可移动行号。[读取契约](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/mcp/tools/read_note.py#L74-L147)。

例如请求 80～100 行、文件共有 200 行，代码会给 101～121 行作为下一段。此时请求本身已读完，has_more 只说明未到文件尾；不是预算导致请求未完成。[续读构造](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/mcp/tools/read_note.py#L270-L295)。

Echo 的草案应继续区分：扩展上下文的 read_more、本次范围受预算截断后的 next_read，以及是否到文件尾。不要用一个 has_more 混合三种情况。头部过滤和版本检查仍以[Echo 接口草案](../design/agent-interface.md)为待确认方案，不能直接复制 Basic Memory 的头部返回行为。

测试源码有“扫描命中窗口后按行读回一致正文”、范围包含 frontmatter 与 EOF 的断言。这些适合转化成 Echo 自己的固定样本验收。所谓 token savings 的测试实际比较 JSON 字符串长度，不是目标模型 tokenizer 的成本实测。[扫描与补读测试](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/tests/mcp/test_line_scanning.py#L17-L54)。

### 4.4 它的 hybrid 不等于 RRF

当前 Basic Memory 代码对 FTS 分数做归一化与门槛处理，再与向量分数按 max(v,f) + 0.3 × min(v,f) 融合，奖励两路同时命中。[融合实现](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/repository/search_repository_base.py#L2946-L3005)、[系数](https://github.com/basicmachines-co/basic-memory/blob/79a422256ffe7892f171cb8a27d24e721f927565/src/basic_memory/repository/search_repository_base.py#L111-L115)。

它说明混合检索有不同实现路线，不能仅看 hybrid 名称断言算法。Echo 继续以 RRF 为起点；只有固定语料与预算的对照表明排名信息不足时，再比较分数融合。分数归一化不等于概率校准，两种策略都没有在 Echo 上验证。

## 5. Qdrant 官方 MCP：适配层可以很小

### 5.1 三层职责值得借鉴

工具处理器负责参数和返回；QdrantConnector 负责写入／查询；EmbeddingProvider 分别提供文档 embedding、查询 embedding、向量名称和维度。这种接口可以让 Echo 更换模型提供方时不连带重写 MCP 工具。[工具处理器](https://github.com/qdrant/mcp-server-qdrant/blob/c56ae5adf62bb78d852bf7bbcbc5d7b75e2bbe41/src/mcp_server_qdrant/mcp_server.py#L88-L163)、[模型接口](https://github.com/qdrant/mcp-server-qdrant/blob/c56ae5adf62bb78d852bf7bbcbc5d7b75e2bbe41/src/mcp_server_qdrant/embeddings/base.py#L4-L25)。

固定 collection 时，注册阶段就隐藏相应工具参数；只读配置则不注册 store。Echo 可借鉴“配置决定可调用能力”，不需要只靠说明文字要求 Agent 不调用写入工具。[注册逻辑](https://github.com/qdrant/mcp-server-qdrant/blob/c56ae5adf62bb78d852bf7bbcbc5d7b75e2bbe41/src/mcp_server_qdrant/mcp_server.py#L167-L199)。

这里没有证明任意模型开箱即用：本轮 [factory](https://github.com/qdrant/mcp-server-qdrant/blob/c56ae5adf62bb78d852bf7bbcbc5d7b75e2bbe41/src/mcp_server_qdrant/embeddings/factory.py#L6-L17) 只实现 FastEmbed 分支。抽象接口与实际实现数量需要分开描述。

### 5.2 修正部署印象，保留已选技术栈

官方 MCP 支持 QDRANT_LOCAL_PATH，并传给 AsyncQdrantClient 的 path，不是只能连接独立数据库服务。此前排除的是独立 Qdrant 服务，不能泛化为它所有部署形式。[设置](https://github.com/qdrant/mcp-server-qdrant/blob/c56ae5adf62bb78d852bf7bbcbc5d7b75e2bbe41/src/mcp_server_qdrant/settings.py#L76-L86)、[客户端构造](https://github.com/qdrant/mcp-server-qdrant/blob/c56ae5adf62bb78d852bf7bbcbc5d7b75e2bbe41/src/mcp_server_qdrant/qdrant.py#L37-L52)。

这不构成 Echo 更换 SQLite 的理由：本轮 MCP 查询路径是生成一个查询向量后 query_points，未实现 BM25＋RRF、Markdown 原文范围读取或同步身份规则。底层 Qdrant 数据库的完整能力也不能等同于这个 MCP 已经暴露的能力。

### 5.3 最小语义存取不等于 Markdown 索引

store 每次新建随机 UUID 点；search 最后只映射 content 与 metadata，没有保留 point ID、score 作为固定返回字段。也没有一个原生 get-by-source/按行读工具。metadata 能容纳定位字段，不等于服务器会生成、校验或补读它们。[写入与查询](https://github.com/qdrant/mcp-server-qdrant/blob/c56ae5adf62bb78d852bf7bbcbc5d7b75e2bbe41/src/mcp_server_qdrant/qdrant.py#L63-L138)。

因此 Echo 可以学习分层，但要继续维护自己的 source/chunk 身份、更新语义、返回定位和空结果状态。不能把通用 store 直接用作增量同步，否则同一笔记重传并不会因该接口自动替换旧点。

## 6. 给 Echo 的收敛建议

以下为后续讨论的优先级，不是开发授权或确认契约。

| 优先级 | 建议 | 解决的问题 |
|---|---|---|
| 首版核心 | 单 query_id 内 BM25＋向量＋RRF；独立子问题分别保留结果 | 避免综合题只剩最强主题 |
| 首版核心 | search 返回带定位证据，read 按范围补齐；身份与版本分离 | Agent 能复查和补全文本 |
| 首版诊断 | 按需保存召回路、排名、融合贡献和预算裁剪原因 | 定位收益及失败发生在哪一层 |
| 小规模验证后加入 | 已有 Markdown 链接的一跳导航，先返回入口 | 找到另一个可能漏召回的来源 |
| 实验项 | 中文字级规范化 vs 中文分词；基础 RRF vs 分数融合／重排 | 让参数由实际笔记决定 |
| 暂缓 | 自动构图、自动多跳、统一记忆写作系统、复杂云端能力 | 保持个人检索 MCP 的范围 |

建议的联合查询过程：

```text
Agent 给出 q1 审批恢复、q2 状态迁移、q3 Trace 审计
  → 每个 query_id 各自召回与融合
  → 保留各问题的命中与失败状态
  → 在总预算内去重、选择互补证据
  → Agent 按需补读章节
  → 如果返回显式链接，再选择性读取目标笔记
```

同一意图的查询变体若需要支持，应与独立问题有明确归属；不必首版就暴露 lex/vec/hyde 的全部组合。首版普通 query 可以自动走确定性的两路检索，这不等于服务在做 LLM 问题拆解。

关系导航也不是现有 Q11 的已证实修复：只有当返回来源确实链接到缺失材料时才有帮助。没有链接时，仍需要 Agent 搜索相应子问题。

## 7. 下一轮怎样验证参考价值

以[现有 Chroma 样本](../evals/2026-09-05-chroma-baseline.md)提供的失败线索为起点，但使用新实验快照，不覆盖旧标签。

1. 固定语料、切块、embedding 和问题，比较 dense-only 与 BM25＋dense＋基础 RRF；分别记录候选池中的必要证据和最终返回证据。
2. 固定候选，再比较单榜单截取与保留子问题分组的预算分配，观察 Q11 各证据点及同篇占位。
3. 固定检索，比较“仅片段”和“片段＋章节补读”。按累计上下文预算比较，而非仅限制首轮结果。
4. 先统计相关样本的显式链接是否指向缺失证据；有链接再比较一跳导航。记录新增有效证据、无效链接、读取次数与总返回量。
5. 范围验收覆盖中文、CRLF、UUID 头部、超长单行、文件中途编辑；检查真实 MCP 客户端交给 Agent 的下一步参数。

预期产物是可复查的召回轨迹与证据覆盖记录。本轮调研本身不证明 Echo 的召回率、延迟或 Agent 使用效果已经提升。
