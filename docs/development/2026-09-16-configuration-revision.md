# 配置修订开发与验收

日期：2026-09-16。实现及独立审查完成；远端 Windows/Linux CI 以本修订 PR 当前提交为准。基线 main ca7ef07；用户已授权合并 PR #6 后进入本轮开发，替代[配置决定](../project/2026-09-16-configuration-decisions.md)的“先记录”安排。PR #6 合并和本轮工程交付不代表真实 embedding 效果验收完成。

## 实现与职责

| 模块                                                                                                            | 职责                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [profiles](../../src/profiles.ts)、[config](../../src/config.ts)                                                | 按 ID 解析文件，校验同名策略，保存代码/资源快照和指纹，v2 禁止外部切块 options     |
| [profile-manager](../../src/profile-manager.ts)、[CLI](../../src/cli.ts)                                        | 幂等初始化、list/show、原子切换、保留旧参数的配置迁移；show 显示实际文件及生效设置 |
| [profile-store](../../src/profile-store.ts)、[profile-sync](../../src/profile-sync.ts)                          | 来源/chunks、FTS、模型向量按依赖分表，事务同步、兼容数据复用和失效管理             |
| [config-runtime](../../src/config-runtime.ts)、[server](../../src/server.ts)、[executor](../../src/executor.ts) | 下一请求热重载，在途快照隔离；数据库/运行设置变化需重启；工作线程取消与并发控制    |
| [errors](../../src/errors.ts)、[transport](../../src/transport.ts)、[logging](../../src/logging.ts)             | 有界 code/next 恢复信息，保留部分证据，只记录事件/计数的轮转日志                   |
| [evaluation](../../src/evaluation.ts)                                                                           | 新旧配置均可用于固定隔离语料，记录实际策略快照、索引、预算和调用统计               |

使用从 [README](../../README.md)、[v2 契约](../design/configuration-profiles.md)及[无 key 样本](../../examples/profiles/example.json)开始。默认规则和召回参数在契约中集中维护。

## 行为验收

- [配置回归](../../tests/profiles.test.ts)：初始化不覆盖自定义文件；切换校验全部引用，失败保留主入口；模块 ID 与文件名一致；不接受参数覆盖；声明资源快照不随后续编辑变化。
- [索引回归](../../tests/profile-index.test.ts)：切分词不重切、不改向量且 embedding 新增调用为零；切模型/维度只生成所选向量；不同切块和模型组合复用；编辑/改名/删除/过滤更新定位并使不兼容组合失效；失败回滚及显式重试。
- [运行与真实 MCP](../../tests/profile-runtime.test.ts)：init/list/show/use/migrate、同连接四类 ID 切换、在途与下一请求隔离、缺索引/坏配置/重启提示、日志轮转、旧自定义规则参数固化、v2 评测和模型无效响应。
- [导入](../../tests/import.test.ts)/[检索](../../tests/retrieval.test.ts)/[MCP](../../tests/mcp.test.ts)继续覆盖身份、原文坐标、混合召回、两类数量上限、子问题归属、预算、取消和旧接口兼容。
- 构建 CLI 样本实测：2 篇/4 块、wrote_ids=0，返回原文路径及正确行号。
- 真实语义不在这些确定性模型/localhost 回归中冒充完成；没有访问个人笔记或旧 Chroma 索引。

## 双人审查与修复

两位独立只读审查者最终复验代码 1b5256b，均无本轮剩余阻断。A 在最终提交独立跑 73 项通过、1 项 Windows 跳过；B 完整测试 85 项通过、1 项 Windows 跳过，并重新构建后验证真实 MCP。

| 已复现问题                                                            | 修复和回归                                                                                                      |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 来源修改/删除/过滤后恢复原状，旧 corpus 哈希令已缺行的 FTS/向量假复活 | 共享 chunk 变动时持久清空其依赖索引的有效快照，只在各组合填充完成后发布；edit/delete/exclude 恢复均先失败后通过 |
| legacy sync 忽略 SQLite 等待设置                                      | 所有同步入口传入 sqlite_busy_timeout_ms；0ms 隔离锁实验由约 5507ms 降为约 2ms                                   |
| UUID 补写后超过文件大小上限，下一次相同同步却失败                     | 在写临时文件前校验最终 UTF-8 字节数；ASCII/中文边界回归，失败不改原文，调高上限后可稳定重试                     |
| HTTP 200 返回 HTML 时误报为请求输入错误                               | 在 embedding 解码边界规范化错误；保留取消/超时，MCP 返回 MODEL_UNAVAILABLE 并保留两条 BM25 证据                 |

主任务补查还修复了兼容入口的扫描规则落空、config show 缺文件位置两项，均有失败到通过的回归。原审查失败记录保存在 .echo/verification/reviewer-a/ 与 reviewer-b/，没有覆盖成成功记录。

## 首次 Agent 使用

两位审查者先不读实现，仅依据 README、v2 使用文档及工具列表，经[交互 SDK 桥](../../examples/mcp-agent-session.mjs)建立真实 MCP 会话；未修改宿主长期配置：

| 观察                           | A                                        | B                                        |
| ------------------------------ | ---------------------------------------- | ---------------------------------------- |
| 工具发现/搜索                  | 1 次 list、5 次 search                   | 1 次 list、5 次 search                   |
| SDK 返回累计字符（含工具列表） | 10046                                    | 10040                                    |
| 宿主补读正文字符               | 185                                      | 185                                      |
| 切换恢复                       | 同连接 INDEX_REQUIRED → 显式 sync → 重查 | 同连接 INDEX_REQUIRED → 显式 sync → 重查 |

没有产品故障重试；切换后的重查是预期恢复步骤。同步失败回滚问题有原文依据；第二个“代码围栏内伪标题”问题在公开样本中没有对应事实，补读后仍不足，因此未宣称回答成功。随后另建带相关事实的隔离样本验证多子问题与模型失败。

B 另验证 1500/256 字符预算实际返回 1469/183 字符，原文定位一致。字符量区分 SDK 返回与补读正文，不当成 tokenizer 的 token 数。

主任务最终 Windows npm run check 已通过：格式、类型、85 项测试通过、1 项 POSIX 专项跳过、构建通过；98 个本地文档引用和 git diff --check 通过。

## 安装与本地评测

从 e5f654c 的干净 git archive 在独立目录 npm ci + npm run check：78 项通过、1 项 Windows 跳过，格式/类型/构建通过。后续修复没有新增依赖；最终源码仍需当前提交 CI 的干净安装验收。归档校验与收据在 .echo/verification/install-profiles-e5f654c-receipt.json。

[v2 固定样本检查](../evals/2026-09-16-configuration-bm25-check.md)绑定干净 9d8bf04：默认 BM25 23/24 事实，与 R2 相同；14 题累计上下文由 57519 增至 61215，差异逐题均是新增 264 字符 selection 元数据。没有宣称效果提升。

## 边界与剩余项

策略是自包含 ESM（第三方逻辑可先打包），数据依赖须声明 resources；可信策略应遵守确定性约定。源码/构建 helper 字节变化可能需要新索引，同一索引统一运行入口。旧配置迁移保留备份，已有文件不覆盖，数据库由用户按需备份；无法验证等价的旧策略需同步重建。

普通同步调用额度、旧索引清理、自动监听、写入型 MCP 工具、专用原文读取、引用链/远程读取未纳入本轮。API key 保持用户环境变量配置。真实模型语义效果、最终默认 hybrid 组合、大型库性能和其他 MCP 宿主仍无新验收结论。
