# Agent 检索与补读接口调研

日期：2026-09-09。目的：为 Echo 的 search/read 契约提供依据，聚焦“命中局部内容后，Agent 怎样继续读取准确的原文”。本轮不重新选型数据库，不实现检索服务，不以第三方功能或宣传推断 Echo 的召回收益。

## 结论

**独立检索＋按原文范围读取值得采用；父章节补读可以通过返回现成参数完成，不必增加一组扩展工具。** QMD 提供了最直接的调用链参考，Claude 的文件工具提供了明确的范围读取语义。官方 filesystem MCP 更适合参考文件访问边界，Azure 更适合参考引用与执行状态的区分。

需要由 Echo 自己补齐：稳定身份与内容版本分离、实际返回范围、过滤头部字段后的原文位置映射、结构化补读／续读参数，以及真实客户端的可见性验证。它们是本轮推导出的建议，不是已经确认的接口。

## 1. 选取对象与证据等级

| 对象 | 为什么选它 | 本轮证据与专题 |
|---|---|---|
| QMD | 本地 Markdown 混合检索 MCP，最接近 Echo 的使用方式 | README、实现、测试源码静态阅读；[专题](2026-09-09-qmd.md) |
| 官方 MCP Filesystem | 通用 Agent 文件访问，用于判断“已有读取工具是否足够” | README、实现、测试源码静态阅读；[专题](2026-09-09-mcp-filesystem.md) |
| Claude text editor 的 view | 商业工具对行范围与工具指示的公开契约 | 官方接口说明，未调用服务；[商业接口专题](2026-09-09-commercial-interfaces.md) |
| Azure AI Search retrieve | 商业检索对证据、引用、子查询与失败的组织 | 官方 REST/MCP 文档，未调用服务；[商业接口专题](2026-09-09-commercial-interfaces.md) |

MCP 协议是补充约束来源，不作为第五个产品比较。没有运行开源项目、安装模型或调用商业 API；不能声称中文效果、延迟、资源占用或 Agent 实际调用成功率已经验证。

## 2. 沿同一条补读链比较

设搜索命中第 86～98 行，但相关章节在第 80～125 行；前面的条件和后面的步骤尚未返回。

| 对象 | 命中后能做什么 | Agent 仍需自行处理什么 |
|---|---|---|
| QMD | 搜索给命中行；工具说明提供围绕命中调用 get 的参数公式，支持起始行＋行数 | 自算范围；缺父章节与结构化续读；get 读取索引快照 |
| MCP Filesystem | 已知路径后可读全文、前 N 行或后 N 行 | 不能直接指定中间任意范围；路径搜索不返回正文命中 |
| Claude view | 按 1 起始的行区间读取；接入方执行实际操作 | 没有替 Echo 找文件、识别父章节或固定原文版本 |
| Azure retrieve | 组织命中材料与引用；预览 REST 可提供索引字段的补取地址 | 引用补取不是 Markdown 原文按行读；REST 和 MCP 暴露内容有差别 |

各行依据对应专题中的固定源码链接或官方文档。不能把四者当同一种产品排名：Filesystem 和 view 是文件工具，Azure 是托管检索接口，QMD 才是最接近的本地检索模块。

## 3. 改变原方案的发现

### 3.1 行号必须描述实际原文，而非展示字符串

[QMD 实现](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/mcp/server.ts#L380-L390)把带 diff header 的 snippet 再编号；结合[片段构造](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L5317-L5358)，静态可推断展示数字与原文位置可能偏移。本轮未运行复现，不据此评判整个项目质量。

对 Echo 的具体影响：先形成“原文范围＋原文内容”，再渲染标题和行号；添加 UUID 头部或检索标题都不能造成位置漂移。搜索截断后的 end_line 必须描述真正返回的内容。

### 3.2 “读取原文”还需说明读取哪个版本

[QMD get](https://github.com/tobi/qmd/blob/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9/src/store.ts#L4891-L4934)读索引库保存的文档；[Filesystem](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/index.ts#L191-L213)按当前路径读文件。两者都未提供本轮所需的预期版本读取参数。

因此 Echo 需要在“当前文件＋版本检查”和“明确标注的索引快照”之间选择。文档身份 UUID 不承担版本校验，改名保持身份也不代表内容未变。无需为此建立复杂身份恢复或完整版本历史。

### 3.3 有结构化字段，不等于模型拿到可操作信息

Filesystem 的结构化内容仍是一段字符串；Azure REST 和 MCP 的输出范围不一致，具体见[商业接口专题](2026-09-09-commercial-interfaces.md)。这说明检查 JSON 是否存在还不够，需要检查目标客户端实际交给模型的字段。

Echo 应将 read_more、next_read、实际范围与错误直接包含在 Agent 可见结果中；详细诊断按需展开，避免每个片段重复长篇说明。

## 4. 对 Echo 的建议及成本

| 建议 | 目的 | 成本／边界 |
|---|---|---|
| search 返回片段、来源、版本、实际行范围 | Agent 可判断证据位置并引用 | 自定义切块器需要提供真实原文映射 |
| read 接收来源＋版本＋行区间 | 绕开 chunk 边界补全文本 | 明确读磁盘还是索引；限制输出 |
| search 提供 read_more 参数 | Agent 直接补读父章节 | 需要解析章节范围；不是自动判断证据充分 |
| read 提供 returned_range、truncated、next_read | 避免把截断误认成全文；减少范围计算 | 续读必须前进；超长单行需要明确行为 |
| 保留 query_id 到命中的关系 | 对综合题知道哪一项需要继续查 | 不把“有命中”当成完整覆盖 |
| 工具描述给使用条件和下一步 | 减少猜路径、整篇读取和重复搜索 | 提示效果需真实 Agent 对照，不能只看字数 |

首版不建议照搬：QMD 的内容短哈希作为稳定笔记 ID、默认无行数限制的全文读取、内部 query 自动扩写；通用文件编辑工具；商业产品的全套规划、生成、权限平台。

具体请求形状、提示稿和最小验收场景集中在[Agent 接口草案](../design/agent-interface.md)，以那里为建议契约的唯一维护位置。

## 5. 参考代码与来源记录

两个参考仓库位于 Echo 根目录的 references/，已通过根 .gitignore 排除。它们不是 Echo 的依赖、Git 子模块或产品代码。

| 参考仓库 | 本地目录 | 固定提交 | 获取方式 |
|---|---|---|---|
| [tobi/qmd](https://github.com/tobi/qmd) | references/qmd | dbfd0b4736aeaf761d1a16ca8e424f071df8feb9 | 浅克隆 |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | references/mcp-servers | d73f99efbfd40c3aa1b61e88728b3d49fb52608f | 浅克隆，稀疏检出 src/filesystem |

复查时先核对本地 HEAD，再按专题中的 commit permalink 定位，避免上游更新造成结论错配。官方商业页面是 2026-09-09 访问记录，没有保存全文网页快照；页面可能更新，访问日期与文档 API 版本详见专题。许可证以对应参考仓库为准，本轮未复制产品实现到 Echo。

## 6. 后续验证

先确定接口草案，再用固定 Markdown 样本跑真实 MCP 客户端，核对范围读取、父章节补读、长输出续读及版本变化。然后对同一问题比较“搜索即可回答”和“需要补读”的调用轨迹，记录必要证据覆盖、错误引用、累计上下文量、调用次数与延迟。

原有 Chroma 12 题仅提供问题线索。综合题的候选缺失仍需要扩大候选池或拆子问题；补读不能找回另一篇从未召回的文档。首轮接口实验应固定索引和查询，避免同时更换模型、切块与检索算法后无法解释收益。
