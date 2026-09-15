# 阶段 1：工程基础与接口

日期：2026-09-15。状态：已验收并合并。PR #2 当前提交 dfd39fc 的 Windows/Linux push 与 PR CI 均成功；合并提交 03d8f23。
承接[开发计划](../project/2026-09-15-development-plan.md)；最新用户授权替代旧计划“仅编写计划”和“合并需另行授权”的任务范围。

## 实现与责任

- Node 24 + TypeScript、锁文件、严格类型、2 空格格式、Vitest。
- [CI](../../.github/workflows/ci.yml)：main PR、main/codex push；Windows/Linux 执行锁文件安装、格式、类型、测试和构建。
- [模块与配置契约](../design/configuration.md)：数据库、切块、API embedding、部分覆盖。
- [真实客户端测试](../../tests/foundation.test.ts)：独立 stdio MCP 进程、工具列举、调用及响应一致性。
- [安装与开发入口](../../README.md)。

## 验证

临时数据库验证 FTS5 写入/查询、vec0 写入/KNN、两路事务回滚及重开持久化。
配置验证非法值、未知键、部分覆盖和 collection 冲突；MCP 验证 text 与 structuredContent 同源。
首次测试发现默认发现规则包含参考项目，已限定 `tests/**/*.test.ts`。本地 `npm run check` 通过：格式、类型、3 项测试、构建；`git diff --check` 通过。远程 CI 以 PR 当前提交为验收门槛。

## 边界

当前只有基础 echo_status；导入/UUID/切块/同步在阶段 2，混合检索和 API 接入在阶段 3，
Agent 完整查询在阶段 4，真实模型对照和最终默认参数在阶段 5。
固定向量仅验证数据库/接口，不是语义评测。没有操作个人笔记或旧 Chroma。

## 远程证据

[PR #2](https://github.com/HuanHuanHuanFFF/Echo/pull/2)；[PR CI](https://github.com/HuanHuanHuanFFF/Echo/actions/runs/34949638069)；[push CI](https://github.com/HuanHuanHuanFFF/Echo/actions/runs/34949632710)。
