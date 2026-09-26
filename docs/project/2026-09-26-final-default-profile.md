# 最终默认与精简初始化

日期：2026-09-26。状态：用户已确认采用最后评测的 A 版 cap6；实现验证见下文。本决定替代 [2026-09-21 默认记录](2026-09-21-minisearch-default.md)中每篇3和初始化附带多份候选配置的范围；历史实验参数、成绩和原始收据保持不变。

## 唯一初始化方案

| 项目                   | 默认                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- |
| 切块                   | markdown-structure-v1@1.0.1；目标1000、常规最大1500、短块200、超长单元回退overlap80字符 |
| 分词                   | icu-zh@1；zh-CN，无额外词典                                                             |
| 召回配置 / 模式        | balanced / hybrid                                                                       |
| 词法引擎               | MiniSearch 7.2.0，取消匹配词数量乘数；k/b/d=1.2/0.7/0.5                                 |
| BM25 / dense 权重      | 0.5 / 1                                                                                 |
| RRF k                  | 10                                                                                      |
| 两路候选               | 60 / 60                                                                                 |
| topk / 每篇最多        | 10 / 6，同时作为上限                                                                    |
| 标题 / 正文权重        | 2 / 1                                                                                   |
| 最低向量余弦           | 0.3                                                                                     |
| 完整业务响应 JSON 预算 | 20000 UTF-16 长度；不是 token 预算                                                      |
| rerank / MMR           | 无                                                                                      |

模型服务、模型名、维度和 key 环境变量仍由用户配置。qwen3.7-text-embedding/1024 是历史评测条件，不强制成为用户模型默认值。切块1500和overlap80的适用边界仍见[切块冻结记录](2026-09-20-default-freeze.md)。

`init` 只创建 `chunkers/markdown-structure-v1.mjs`、`tokenizers/icu-zh.mjs`、`config/embedding/default.json`、`config/retrieval/balanced.json`，以及主入口、sources/runtime/logging 和本地数据库。不再自动创建 heading-1000、heading-500 或 bm25.json。其他策略与纯 BM25 仍可由用户新增；无 key 的本地检索可直接将 balanced 的 mode 改为 bm25。

[初始化实现](../../src/profile-manager.ts)负责生成文件；[内置参数](../../src/config.ts)与[balanced 示例](../../examples/profiles/config/retrieval/balanced.json)统一为上述参数。仓库 examples 中的可选策略和历史评测仍保留，用于示例、兼容验证和复核；它们不再自动安装到新工作区。

## 升级与评测边界

已有文件不覆盖、不删除；显式每篇3仍是3，省略该字段的配置继承新默认6。需要升级已有 balanced 时手动设置 max_chunks_per_source=6，MCP 下一请求生效；这类召回参数修改不重建索引。配置文件可继续新增、切换和部分覆盖。

本次采用的是[cap6全量对照](../evals/2026-09-22-cap6-public-full-results.md)的 A 版（0.5/1、RRF10），也是[QMD对照](../evals/2026-09-26-qmd-public-fixed-results.md)采用的 Echo 基线参数。B 版0.31/0.8、RRF5不设为默认。私有200题A版190/196、393/403属于历史冻结结果，本次不重新运行模型或生成新的质量成绩。固定片段公开库只比较排名，不施加产品source cap和JSON预算；不能把其成绩写成默认MCP端到端成绩。历史评测累计请求加响应预算也不等同于产品仅完整响应JSON的预算。

## 验证

验证入口为 `npm run check`：格式、类型、隔离回归、构建和可移植 CLI/MCP 烟测。初始化只生成单一默认方案、重复初始化保留自定义文件和旧显式cap3；可选策略测试显式安装自己的样例，继续验证配置切换、迁移与索引隔离。

依据：[配置回归](../../tests/profiles.test.ts)、[覆盖规则](../../tests/foundation.test.ts)、[MCP热切换](../../tests/profile-runtime.test.ts)、[运行时烟测](../../scripts/verify-default-runtime.mjs)。本次 `npm run check` 通过：40个测试文件、251项通过、1项既有跳过；格式、类型、构建和默认CLI/MCP烟测均通过。烟测验证新初始化只有新综合与balanced、cap6/20k生效、旧显式cap3/16k保留、原文行号与CLI/MCP证据一致；零新增embedding调用。历史实验测试显式固定cap3，旧迁移策略保持原生成代码指纹。
