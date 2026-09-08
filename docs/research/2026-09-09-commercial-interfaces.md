# 商业接口：Claude 文件读取与 Azure 检索证据

访问日期：2026-09-09。证据等级：官方文档及接口示例，未调用收费服务、未验证实际客户端行为；闭源内部实现未知。本文选取与 Echo 补读相关的部分，不作产品排名。

## 1. Claude text editor：按范围读文件

参考 [Text editor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)，关注 “view”“Line numbers”“Implement the text editor tool”。文档示例类型为 `text_editor_20250728`，不据此选定 Echo 的模型或 SDK。

`view` 接收路径和 `view_range=[起始行,结束行]`，行号从 1 开始，结束值 -1 表示读至文件尾。输出示例给每行添加编号；`max_characters` 控制查看输出的截断。文件操作由接入应用执行，并非模型或云服务自动访问本机。本文所查接口没有提供 Markdown 父章节、稳定笔记 ID 或原文版本参数。

**对 Echo 的推论**：按行读取足以作为基础操作；标题解析器可以给出章节范围，不必为每种上下文扩展再增加一个工具。Echo 需要自己规定实际返回范围、预算耗尽和继续读取的返回值，不能把文档中的长度选项理解成完整的续读协议。

## 2. 工具指示应与调用接口放在一起

[Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) 的 “Best practices for tool definitions” 要求说明用途、触发场景、参数和局限，强调返回与下一步决策有关的信息，并使用有意义的工具命名。

**对 Echo 的推论**：稳定规则放在工具描述，动态的补读位置放在结果字段。笔记正文属于被检索的数据，不承担指导 Agent 调用 Echo 的职责。描述应让调用方知道“何时补读、何时换子问题”，但没有证据证明描述越长越好；最终需检查目标客户端实际送入模型的内容。

## 3. Azure AI Search：区分证据、引用和执行过程

参考 [Query Knowledge Base via API or MCP](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-retrieve)，所访问页面更新日期为 2026-09-04，同时包含 `2026-04-01` 和 `2026-08-01-preview` 两套分支，字段不可混用。

REST retrieve 区分 response、references、activity：引用 ID 只在本次响应内有效，docKey 才关联索引文档。预览版 citationUrl 可进一步获取索引字段，并非按行读取源文件，也不是不可变原文快照。超出输出预算的材料可能被省略，activity 可提示原因。该页的 MCP 输出说明则明确：当前只返回承载检索内容的 text，没有独立的 activity/references 数组。

这意味着，底层 API 有执行信息，不等于 Agent 经 MCP 调用时也拿得到。对 Echo 最有价值的是“命中、未返回、调用失败分别表达”，而非复制 Azure 的全部响应层级。

[Retrieval reasoning effort](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-set-retrieval-reasoning-effort) 的 minimal 模式允许调用方控制规划，服务执行检索并返回抽取材料。Echo 已由用户决定让 Agent 拆子问题，因此这里只借鉴职责分离；不引入内部规划或答案生成。

## 4. 协议能力不等于 Agent 可见内容

[MCP Tools，2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) 定义 `structuredContent` 与可选 `outputSchema`；提供输出 schema 时，结构化结果须符合它。规范建议同时以 TextContent 返回序列化 JSON，兼容只处理文本的客户端。

**对 Echo 的推论**：维护一份规范结果对象，再生成协议输出，避免文本与结构化字段各写一套。真实 MCP 验收要核对 Agent 能否看到 source_id、行范围、补读参数和错误状态；仅验证 SDK 返回对象不够。本次查阅的是固定规范版本，不代表已选定 Echo 的协议或 SDK 版本。

## 5. 本轮采用边界

| 借鉴 | Echo 需要补上的内容 |
|---|---|
| 有行号的范围读取 | 原文位置映射、父章节范围、真实返回范围 |
| 工具描述解释用途和下一步 | 结构化 read_more；无硬编码客户端专属提示 |
| 引用与执行状态分离 | 子问题到证据的对应关系；部分失败与空命中区分 |
| 输出长度限制 | 截断状态与可执行的继续读取参数 |
| 文档标识与本次引用标识分离 | 复用已确认的 echo_id，另行记录原文版本 |

本轮没有发现可直接照搬的“Markdown UUID 头部过滤＋原文件行号＋父章节补读＋跨版本校验”完整契约。这是所查接口的范围限制，不是对所有商业产品能力的否定。Echo 的具体建议见[接口草案](../design/agent-interface.md)。
