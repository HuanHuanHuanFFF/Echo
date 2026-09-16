# Echo 文档入口

更新日期：2026-09-17。

Echo 是面向个人 Markdown 知识库的 TypeScript＋SQLite 检索 MCP。前四阶段已合并并通过双平台 CI；第五阶段已完成独立安装、真实文档向量及100题开发对照；默认组合选择与最终评测仍待验收。安装使用从[README](../README.md)开始，当前配置以[v2 配置契约](design/configuration-profiles.md)为准。

## 从这里继续

| 目的                                       | 文档                                                                               | 内容归属                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 查看开发阶段、职责与验收条件               | [首版开发计划](project/2026-09-15-development-plan.md)                             | 五阶段安排、第一阶段基础 CI、分支／PR 节奏与交付标准     |
| 了解定位、约束、选型与下一步               | [项目基线](project/baseline.md)                                                    | 已确认决定、当前建议、现有资产和未决事项                 |
| 讨论搜索工具、混合召回、文档分组及证据覆盖 | [检索设计草案](design/retrieval.md)                                                | 算法流程、工具边界和实现前需确定的契约                   |
| 了解 Agent 搜索、补读与定位的参考实现      | [2026-09-09 接口调研](research/2026-09-09-agent-retrieval-interfaces.md)           | 四个代表方案、证据等级、参考版本和采用边界               |
| 比较查询融合、关系导航与轻量工具边界       | [2026-09-15 三项目补充调研](research/2026-09-15-retrieval-reference-comparison.md) | QMD、Basic Memory、Qdrant MCP 的固定源码、差异及采用建议 |
| 讨论搜索定位与宿主文件工具补读             | [Agent 接口草案](design/agent-interface.md)                                        | 路径与行范围、同步前提、验收场景；首版不提供专用读取工具 |
| 查看现有 Chroma 测试、失败案例及对照方案   | [2026-09-05 探索性基线](evals/2026-09-05-chroma-baseline.md)                       | 评测快照、证据边界与下一轮实验                           |

本轮已确认的本地读取范围、默认切块与召回参数组合及自定义能力见[项目基线 §1.3–1.4](project/baseline.md#13-本地读取与同步边界2026-09-15-已确认尚未实现)。日期调研保留当时的候选建议，实施范围按用户最新明确需求和最新适用的计划／决定执行；优先级规则见 [AGENTS.md](../AGENTS.md)。

## 目录约定

- `project/`：项目定位、已确认决定、阶段计划与接续信息。
- `design/`：按功能组织设计；区分草案与已确认契约。
- `evals/`：按日期记录评测与实验；保留原始产物来源和可复现条件。
- `research/`：按日期记录外部方案调查；固定源码版本，注明官方文档访问日期，区分事实、推论和本地验证。

后续文档统一放在此目录下，按需要增加内容，不预建空目录。新增长期入口时更新本页；新决定在对应主题文档或新版计划中标明日期、状态、替代范围及旧文档链接；无需全面回改旧文档。历史评测保持为有日期的快照。

当前正式讨论基线已从 NoteRAG 迁入这里。旧文档只保留迁移指引，避免双份维护。文档链接按当前 Windows 工作区绝对路径记录，变更根目录时需一并更新。外部知识库修改与索引重建以任务授权为准；阶段提交、推送和文档要求遵循 [AGENTS.md](../AGENTS.md)。

## 配置修订

- [当前配置组织决定（2026-09-16）](project/2026-09-16-configuration-decisions.md)：固定切块策略、多模型/多召回配置、按 ID 选择；已获授权进入开发，见[修订开发记录](development/2026-09-16-configuration-revision.md)。
- [前版调整草案（2026-09-15）](project/2026-09-15-pending-adjustments.md)：保留被修订范围和其他索引隔离背景。

## 开发与当前契约

- [阶段 1 工程基础验收](development/phase-01-foundation.md)
- [配置与模块契约](design/configuration.md)
- [安装开发入口](../README.md)
- [阶段 2 导入与同步](development/phase-02-import-sync.md)
- [阶段 3 混合检索与参数](development/phase-03-hybrid-retrieval.md)
- [阶段 4 Agent MCP 完整流程](development/phase-04-agent-mcp.md)
- [阶段 5 评测与交付状态](development/phase-05-evaluation-delivery.md)
- [Echo 本地评测快照](evals/2026-09-15-echo-local-evaluation-r2.md)
- [PR #3 / #4 的 P2 修复与升级说明](development/2026-09-16-pr-review-fixes.md)

- [v2 配置、固定策略与索引契约](design/configuration-profiles.md)
- [配置修订开发与验收](development/2026-09-16-configuration-revision.md)
- [v2 固定样本 BM25 检查](evals/2026-09-16-configuration-bm25-check.md)

## 正式默认方案评测（2026-09-16）

- [执行决定与验收边界](project/2026-09-16-evaluation-revision.md)：产品/面试双目标、E盘独立运行、仓库文档职责。
- [个人知识库评测协议](evals/2026-09-16-personal-knowledge-protocol.md)：开发100/最终200题、分库70%/混合30%、标签/预算/统计和执行顺序。
- [机器可读题量配额](evals/2026-09-16-question-allocation.json)。
- [已完成的准备验证](evals/2026-09-16-evaluation-readiness.md)及[公开证据清单](evals/2026-09-16-preparation.manifest.json)：不包含私有笔记或密钥，不代表正式语义评测已完成。
- [外部笔记来源初筛](evals/2026-09-16-corpus-source-audit.md)：公开候选固定提交与Markdown规模，尚未入库。

## 单轮脚本评测

- [评测脚本契约](design/retrieval-evaluation.md)：独立题目、固定子问题、原文范围标签、只读运行。
- [实现与验证](development/2026-09-16-single-turn-evaluation.md)。
- [benchmark方法参考](research/2026-09-16-single-turn-benchmark-methods.md)：时间、更新、比较、证据和无答案题。
- [2026年正文候选落地](evals/2026-09-16-corpus-preparation.md)：198篇外部候选、分库/混合库BM25准备，规模及D库题量仍待审计。

- [成对统计与标注准备](development/2026-09-16-paired-evaluation-statistics.md)：冻结报告比较、意图组区间、父子题分组。

- [2026年实质内容筛选修正](evals/2026-09-16-substantive-freshness-correction.md)：撤回仅链接/拼写更新的旧D候选，核查替代个人学习记录。

- [语料v2与题库准备快照](evals/2026-09-16-corpus-v2-and-annotation-status.md)：364篇范围、真实新增来源与冻结前复核问题。
- [标签冻结与首轮开发集BM25对照](evals/2026-09-16-frozen-labels-and-development-bm25.md)：100/200标签冻结、两切块开发结果与同题干扰；[公开统计指纹](evals/2026-09-16-development-bm25.manifest.json)。真实语义与最终评测仍待完成。

- [真实向量准备与开发集语义对照](evals/2026-09-17-real-model-development.md)：真实索引与首轮开发语义对照已完成，结果复核及默认方案选择仍在进行；[用量与指纹](evals/2026-09-17-real-vector-preparation.manifest.json)。
