# Echo 文档入口

更新日期：2026-10-04。Echo 是本地 Markdown 证据检索 MCP：Agent 拆题、补读和回答，Echo 返回证据与定位。当前实现包含显式同步、BM25/API向量、混合检索、多配置、只读新鲜度检查与精简响应。

## 安装与使用

- [由 Agent 配置 Echo MCP](guides/agent-setup.md)：先初始化和准备本地配置，再集中补齐模型、API key 等外部条件，完成同步与 MCP 验证。

- [npm 安装、MCP 接入与发布](guides/npm-release.md)：安装环境、工作区初始化、包验收与发布步骤。
- [配置与策略契约](design/configuration-profiles.md)：目录隔离、模型、召回覆盖、切块/分词接口与同步。
- [最终默认](project/2026-09-26-final-default-profile.md)：新综合、BM25/dense 0.5/1、RRF10、topk10、每篇6、预算20000。
- [Agent 查询说明](guides/agent-usage.md)：工具选择、子问题、补读、来源新鲜度及错误处理。
- [架构与模块](architecture/README.md)：图、模块职责和持久化边界。
- [根 README](../README.md)：项目介绍、角色图、Agent 配置入口、请求与返回示例、架构、评测和扩展。

新初始化还会在 config、embedding、retrieval、chunkers、tokenizers 目录创建各自 README。召回说明中的参数表按安装版本代码生成；已有文件不覆盖。

## 验证与效果

- [Agent 接口复验](evals/2026-09-26-agent-recheck.md)：36次MCP调用、47项检查；接口通过不等于整体回答质量通过。
- [私有200题与默认cap6对照](evals/2026-09-21-default-budget20-cap-comparison.md)、[公开全量cap6对照](evals/2026-09-22-cap6-public-full-results.md)：参数、评分口径和预算按各报告冻结，不能跨口径直接比较。
- [QMD 私有题对照](evals/2026-09-25-qmd-private-comparison.md)、[固定补读](evals/2026-09-26-echo-qmd-supplement-results.md)、[公开固定单元](evals/2026-09-26-qmd-public-fixed-results.md)。
- [Dify 对照](evals/2026-09-24-echo-dify-results.md)：产品范围和模型条件不同，按原协议解释结果。
- [Dify 父块分隔符 A/C 探索](evals/2026-09-25-dify-parent-separator-pilot.md)：75 题局部对照；后续因耗时停止，不替代全量对照或修改默认配置。

真实模型检索评测已有冻结结果；完整 Agent 日常任务的回答、补读、引用与累计成本验收仍独立。游标翻页、rerank/MMR、自动同步未实现。

## 开发与维护

- [后续更新计划](project/2026-10-04-follow-up-plan.md)：Jev 证据判断实验、游标、独立硬预算、短预览、MMR/rerank 与 Agent 任务评测；区分已完成工作和待验证方向。
- [发布准备记录](development/2026-09-27-npm-release-preparation.md)：本次范围、工具描述约束、验证和剩余发布事项。
- [发布路径约定](project/2026-09-26-public-paths.md)：本机路径脱敏与历史记录字节边界。
- [历史开发与评测索引](history.md)：阶段验收、旧决定、实验协议、结果与失败记录；保留原路径。

project 保存决定，design 保存当前契约，development 保存实现验收，evals 保存按日期冻结的实验，research 保存调研，guides 保存使用流程。新增长期文档需更新本页或历史索引；历史数字不回写成新默认。仓库说明使用相对链接，个人数据、密钥和索引不进入 Git。Echo 自有代码采用 [MIT](../LICENSE)，第三方代码/资料保留各自许可。
