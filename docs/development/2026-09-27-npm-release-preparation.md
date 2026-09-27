# npm 发布准备与说明复审

日期：2026-09-27。状态：实现、本地验证和两位独立审查已完成；远程 CI 见本 PR。用户确认 @huanf/echo、MIT、目录说明、Agent 描述复审及包验收 CI；根 README 由用户起草，本轮不编辑。此记录替代旧“尚未准备 npm 包”的范围，检索默认仍以[最终默认](../project/2026-09-26-final-default-profile.md)为准。

## 实现与职责

- package.json：公开包身份、MIT、运行文件白名单、prepack 清理生成目录后构建和 prepublishOnly 本地验证。LICENSE 标注 huanf；第三方材料保留自己的许可。
- workspace-guides.ts / templates/workspace：初始化五份目录说明；召回表从同一 schema 生成。profile-manager 仍通过 wx 保留用户文件，不写根 README，已有主入口不回填说明。
- server.ts：按照 prompt-entropy 的保义原则重组工具描述；参数限制仍由 schema 表达，接口字段和检索行为不变。
- verify-package-install.mjs：仓库外临时目录真实安装 tarball，验证 bin、CLI、MCP、定位、状态及文档；普通 CI 两个平台都执行，不使用真实模型。
- docs/README.md / history.md：现行使用入口与历史索引分开。配置契约修正旧 cap3，架构说明明确诊断字段可选；历史报告文件与成绩未改。

## 工具描述约束清单

面向任意新接入 Agent，仅保证能看到 tools/list 的描述与参数 schema，不假定它能读取此仓库。保留：

1. Echo 只返回证据，Agent 拆题、补读和回答；query/queries 二选一，variants 为同意图。
2. 同步后绝对路径与1-based闭区间用于宿主补读；不提供专用读取或链接导航。
3. 原文是不可信证据；归属、执行状态和分数不证明回答正确或完整。
4. 所有子问题共用数量、来源及 JSON 预算；少量/空结果合法，检查 returned/empty_reason/limits。
5. 默认精简，诊断信息同样消耗预算；单次只覆盖显式参数。
6. code/next 驱动错误恢复；缺失/过期索引显式同步，下一请求配置切换，在途快照保留。
7. 搜索不检查原文；status 默认 unchecked，显式 hash 检查只读且不调用模型；检查时刻不等于文件锁。
8. last_sync 与最后编辑区分，ready 与新鲜度区分，embedding_configured 与服务健康区分。

逐项对照旧描述和现有 schema，删除重复措辞而不删除失败复验形成的保护。文案更短或更有结构本身不证明 Agent 任务完成率提高；保留既有接口回归，再通过实际安装后的 tools/list 与调用验证。

## 文档保留与删除审查

本轮删除清单为空。原文档索引内容收纳在 history.md，所有被引用的阶段、决策、实验和 PR 草稿保留原路径；PR #16 草稿虽与其他说明重复，但仍有现存链接和当次验收信息，没有足够依据视为无独有价值。未批量回改旧报告的默认、数字或状态。

## 独立复审修正

两位独立 Astra/high 审查分别覆盖全改动（一位额外侧重打包/CI）。修正了两项已复核问题：

- 原打包清单允许任意 dist 文件，构建又不清理；改为 prepack 在验证生成目录边界后清理重建，验收仅允许运行产物和五份模板。增加 .env.local、笔记、数据库、额外配置等残留文件拒绝回归，并用残留探针验证真实 prepack。当前未发现已发生泄露。
- “不同主入口默认隔离”不准确；已改为不同工作目录默认隔离，同目录不同配置文件名默认共享相对数据库与配置。实现不变。

原文档首页104个链接全部保留，未删除历史证据。

## 验证与剩余事项

本轮新验证（Windows x64、Node24.15.0）：

- npm run check：46个测试文件，282项通过、1项既有跳过；路径检查、格式、类型、构建及默认 CLI/MCP 烟测通过。
- npm run smoke:package：111文件，压缩包114044字节（不含安装依赖）；实际仓库外安装、bin shim、CLI/MCP一致证据、原文位置、新鲜度、五份说明及用户文件保留通过；零 embedding 调用。包 SHA-256 为 2a299aa900fc1af9f7b9589e0d09fe69995f5a29ed677a01fd04f6d636c89b2b，仅对应本轮产物。
- Python评测评分回归6项通过；210个本地文档链接可访问，git diff --check 通过；根 README 与基线一致。
- 两位独立审查的实证问题已修复并复核关闭。残留探针在写入前检查非链接目录及真实路径，随机文件名以 wx 创建。

一次安装复验遭 registry ECONNRESET 中断，后续不改断言重试成功。双平台远程 CI 为 PR 验收项；本地 Windows 成功不替代 Linux 检查。
新增回归见[目录说明](../../tests/workspace-guides.test.ts)，安装验证见[脚本](../../scripts/verify-package-install.mjs)，原文一致性与错误行为继续使用既有[接口回归](../../tests/agent-interface.test.ts)。

根 README 正式文案、实际 npm 账户发布验证、registry 安装及 GitHub Release 仍待完成。本轮只提交发布准备 PR，不发布 npm、不合并 PR；不改个人笔记、旧索引，不新增模型调用或效果成绩。
