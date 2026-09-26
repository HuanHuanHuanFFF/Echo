# Agent 接口收尾：原文检查与精简响应

日期：2026-09-26。状态：实现及本地验证完成，PR 双平台 CI 待运行。
基线：main `2e1173a`；分支 `codex/agent-interface-polish`。

用户确认范围：按 hash 检查原文是否变化；公开完整参数约束和过滤范围；正常搜索省略不必要元数据，详细诊断显式获取。本文替代[阶段 4](phase-04-agent-mcp.md)和[v2 契约](../design/configuration-profiles.md)中对应的状态与响应呈现约定；其余检索、同步和证据职责保持。默认参数仍以[最终默认](../project/2026-09-26-final-default-profile.md)为准。

## 状态与只读原文检查

```sh
echo-mcp status --config /absolute/path/echo.config.json
echo-mcp status --check-sources --config /absolute/path/echo.config.json
```

MCP 对应 `echo_status({})` 与 `echo_status({"check_sources":true})`。仍只提供原有两个工具。

| 字段                | 语义                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`             | 所选本地索引组合满足查询前提；不代表原文未编辑，也不代表远端模型健康                                                                         |
| `last_sync`         | 所选切块索引最后成功同步时间；无内容变化的成功同步也会更新它                                                                                 |
| `collections`       | 配置中的 collection ID、根目录、当前切块索引中的来源数；可用 ID 作为过滤参数                                                                 |
| `freshness.state`   | `unchecked` 未扫描；`unchanged` 扫描到的文件与索引相同；`changed` 有变化；`unknown` 无法完成检查或无可比较索引                               |
| `needs_sync`        | 索引缺失/过期或检测到原文变化为 true；索引就绪且扫描无变化为 false；未检查或检查失败且索引本身就绪为 null。配置问题需先按 `reason.next` 处理 |
| `freshness.changes` | 完整扫描的新增、修改、删除数量；移动计作旧路径删除＋新路径新增，不尝试恢复身份                                                               |
| `checked_at` 等     | 完成扫描/失败的时间、耗时、已读文件数量和字节数，位于 `freshness` 中                                                                         |

[status.ts](../../src/status.ts)使用与同步相同的扫描规则、UTF-8 解码和 SHA-256，逐一比较 `(collection_id, 真实路径, source_version)`。不使用修改时间跳过正文 hash；同大小且恢复 mtime 的编辑仍能检测。新增无 UUID 文件只读不写，不解析或修复 UUID。

状态与比较基线取自一次 SQLite 只读事务；读取前后检查文件属性，并复查扫描清单。文件不可读、超大小、无效 UTF-8、扫描中观察到变化时返回 unknown，不能当成原文最新。取消/超时沿用状态 Worker 的执行边界。原文不加锁：结果只描述本次扫描观察，不能保证整个文件系统同一时刻快照，也不能保证随后补读前文件未被编辑。源检查不是同步预演，不验证自定义策略或重复 UUID。

默认状态不扫描原文；搜索也不隐式扫描或自动同步。原文变化通常执行增量 sync；缺失的策略/模型索引由显式 sync 建立。没有个人笔记修改、旧 Chroma 重建或模型健康请求。

## 可发现的参数与范围

[config.ts](../../src/config.ts)为配置和单次 overrides 共用字段类型、范围及解释。工具定义列出全部可覆盖字段；单次对象不注入默认值，未传字段继续使用当前配置。合并后校验权重不能同时为零。

- `query` 与 `queries` 二选一；独立问题共用 topk、单篇限制和预算；variants 是同一意图的不同表达。
- `filters.collections` 使用状态中列出的 ID。任何未知 ID 报 `INVALID_COLLECTION`，混有有效 ID 也不会静默忽略错误项。空数组仍表示空范围。
- `filters.path_prefix` 是相对各 collection 根目录的字面前缀，反斜杠规范为 `/`，不是 glob。绝对路径、盘符路径及 `..` 路径段报 `INVALID_PATH_PREFIX`。合法但未匹配的相对前缀仍是正常空结果。

## 默认紧凑与显式诊断

MCP `echo_search({"query":"..."})` 默认紧凑。需要诊断时传 `diagnostics:true`；CLI 使用 `search --query ... --diagnostics`。

| 正常输出                                         | 显式诊断额外输出                                     |
| ------------------------------------------------ | ---------------------------------------------------- |
| 原文、绝对路径、标题及片段/章节行号              | 相对路径、各路排名、RRF 分数、向量相似度             |
| chunk/source/collection ID、来源版本、关联子问题 | 完整 applied 参数、selection 配置 ID 与修订/语料标识 |
| 整体与子问题执行状态、返回数量、错误及修复提示   | 各路候选数、完整排除计数和所有变体执行情况           |
| 仅有实际影响时返回 `limits`；仅保留失败变体明细  | 诊断格式保留既有字段，供排查与历史工具使用           |

零证据时，紧凑响应的每个非全失败子问题补充 `empty_reason`：`no_candidates` 没有候选；`budget` 候选受到预算排除；`limits` 受到数量/单篇限制。`limits` 数组报告本次实际出现的 `budget`、`source_limit`、`topk` 排除；不输出全零计数或去重流水。

`status:ok` 仍仅表示检索执行成功；可能同时 returned=0。这些字段只说明检索事实，不判断答案是否存在或完整，不把分数解释为回答置信度。来源版本继续保留供宿主核对；补读由宿主文件工具完成。

[retrieval.ts](../../src/retrieval.ts)在预算装箱前选择实际输出格式。默认与诊断均以实际紧凑 JSON 的 UTF-16 长度计预算；默认 20000，topk10、每篇6同时作为上限，正文不截半块。诊断会消耗更多预算，可能返回较少块；不能把两种格式的覆盖视作同条件结果。

升级兼容：依赖 `applied`/`selection`/`relative_path`/排名的调用方需显式开启 diagnostics。新的产品检索评测按紧凑输出计预算，评分从来源 ID/真实路径映射到冻结语料，不把额外评分字段加回响应。直接使用内部 `packResults` 的历史离线实验保留原诊断格式默认；历史成绩和快照不改写。本轮没有重新声明真实语义检索质量提升。

## 模块与验证依据

- [status.ts](../../src/status.ts)：只读状态、来源清单与 hash 比较；CLI 与 MCP 复用。
- [executor.ts](../../src/executor.ts)、[search-worker.ts](../../src/search-worker.ts)：状态参数跨 Worker 传递，沿用取消、超时和容量控制。
- [server.ts](../../src/server.ts)、[cli.ts](../../src/cli.ts)：参数说明、check_sources 和 diagnostics 入口。
- [agent-interface.test.ts](../../tests/agent-interface.test.ts)：真实 MCP/CLI、字段约束、部分覆盖不注入默认、源变化/路径变化/扫描错误/缺失索引、只读与无 API、精简前装箱及零证据反馈。
- 既有 [MCP](../../tests/mcp.test.ts)、[配置热切换](../../tests/profile-runtime.test.ts)、[检索](../../tests/retrieval.test.ts)、[MiniSearch](../../tests/minisearch.test.ts)和[评测脚本](../../tests/retrieval-evaluation.test.ts)回归覆盖原有边界。需要内部诊断的测试改为显式请求，原文定位测试改验绝对路径。

### 本地测量

复跑入口：先 `npm run build`，再 `node scripts/measure-source-check.mjs`。
[测量脚本](../../scripts/measure-source-check.mjs)在系统临时目录生成、同步并最终清理自己的样本；BM25-only，零模型请求。

2026-09-26，Windows、Node v24.15.0：1000 篇共 3435000 字节，普通状态 7 ms；三次 hash 扫描 631 / 636 / 666 ms。刚写入并同步后的热缓存条件，不代表冷盘、网盘或真实大库速度。同一固定查询和20k预算下，紧凑/诊断都返回10块，响应分别14723/16118字符；这只是该生成样本的格式开销对照。

### 审查与剩余边界

两位 Astra/high 独立只读审查，一位侧重新鲜度与预算、一位不设重点。首轮均发现旧格式仅用 last_sync 判 ready 的遗漏；已增加旧格式词法/模型索引身份检查与回归，两位复审均未发现剩余产品阻断问题。重点审查另执行96组预算/数量组合及BOM＋CRLF原文检查；整体审查复验旧格式模型切换与本地测量脚本。

本轮验证接口与本地执行行为；未进行新的付费向量评测或规模化 Agent 回答任务验收。游标、索引预览、重排和自动同步不在本轮范围。

本地验证：`npm run check` 通过格式、类型、构建、41 个测试文件（261 passed、1 项既有 skipped）及独立安装布局 CLI/MCP 冒烟检查；Python公开计分校验6项通过；文档216个本地链接存在，`git diff --check` 通过。

验证过程中，原 CLI 多进程测试在全套并行时重复超过15秒，单跑通过。该测试改用构建后的 CLI 执行所有同步/查询，并显式检查切换前 ready=true、切换后 false、同步后 true；保留全部原断言和15秒限时，避免重复 TypeScript loader 启动及跨运行时指纹混用。其他源码 MCP/热切换回归保持。本机16个可用逻辑处理器下，高并行仍触发该期限；单变量限制最多4个测试Worker后，全部261项通过（45.95秒）。[Vitest配置](../../vitest.config.ts)据此将并行Worker上限设为 min(4,可用CPU数)，保留进程隔离、全部断言和15秒期限。最终结果以 PR 当前提交的双平台 CI 为准。
