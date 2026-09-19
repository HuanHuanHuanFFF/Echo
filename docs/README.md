# Echo 文档入口

更新日期：2026-09-19。

Echo 是面向个人 Markdown 知识库的 TypeScript＋SQLite 检索 MCP。前四阶段已合并并通过双平台 CI；第五阶段已完成独立安装、真实向量、100题开发及最终200题四臂对照；产品默认采用与最新安装回归仍待验收。安装使用从[README](../README.md)开始，当前配置以[v2 配置契约](design/configuration-profiles.md)为准。

## 当前下一步

- [全量公开评测执行冻结](evals/2026-09-19-public-full-evaluation-freeze.md)：用户已授权全量QASPER三版、FreshStack/DuRetrieval固定片段RRF30/10。数据与协议核对完成，QASPER3015条检索已跑并按官方评分器核分，其余真实向量获取及全量对照进行中；不改默认。

- [默认方案外部验证与暂存设想](project/2026-09-19-default-validation-and-deferred-ideas.md)：索引式预览先记录、暂缓实施；优先验证默认策略。区分产品heading/RRF30和候选新综合/RRF10，建议FreshStack、DuRetrieval及新的笔记留出集，官方检索与Markdown切块分开计分；尚未运行。

- [渐进式取证、MMR与重排调研](research/2026-09-19-progressive-retrieval-and-reranking.md)：一个Luna/max子线程与主线程核对官方方案；建议紧凑预览、按范围补读，并区分MMR与精排。200份输出纯格式估算可减少19.61% token；尚未实现或验证Agent效果。

- [纯向量与混合的最终集诊断](evals/2026-09-18-dense-hybrid-diagnosis.md)：11题12项事实差异均已有候选，直接由排序与每篇3块竞争形成；全部缺失锚点也已进候选，另记录子问定位词与严格标签边界。50份原响应同条件重建相等，两位独立复核通过。

- [最终200题四臂结果](evals/2026-09-18-final-four-arms.md)：新综合混合179/196、纯向量178/196、纯BM25 139/196，heading混合159/196；40同题干扰另列，两位独立复核通过，未据最终集调参或改默认。

- [最终200题四臂冻结](evals/2026-09-18-final-evaluation-freeze.md)：新综合三模式＋heading混合；固定当前参数，200题/40既有题配对另列，已运行并复核，结果见上条。

- [标签修订与当前切块/模式对照](evals/2026-09-18-label-revision-and-current-architecture.md)：48个历史条件统一重算；当前同参数新综合hybrid92/95、heading91/95，新综合dense88/95、BM25 82/95。新增300次父题检索，零API，两位独立结果复核通过；默认未改。

- [固定RRF10：BM25 0.3/0.4组合对照](evals/2026-09-18-rrf10-bm25-combinations.md)：新增两组各100题；均90/95、220/226，低于0.5/RRF10基线91/95、222/226；课程丢证据，无新增K10事实，默认未改。

- [当前基线的BM25 0.2/0.25与RRF10单变量对照](evals/2026-09-18-current-parameter-comparisons.md)：新增3组各100题；分别89/95、90/95、91/95，基线90/95只读复用。RRF10补混合024且K10事实无回退，默认未改。

- [5道未完整题与5道无答案题诊断](evals/2026-09-18-failure-diagnosis.md)：同参数离线追踪，发现替代锚点漏标、单篇/全局配额占位及混合排序后预算排除；不改参数或历史分数。

- [固定16000预算：RRF40与30/60对照](evals/2026-09-18-rrf40-comparison.md)：仅新增40组100题；40为89/95、219/226，略低于30，默认仍30；两位独立复核通过。

- [采用RRF30＋预算16000并验证联合条件](evals/2026-09-18-rrf-budget-joint.md)：用户已确认默认调整，只新增联合100题，三份旧条件只读复用；联合90/95、220/226，与只改RRF相同；预算受限题74→18，双人独立复核通过。

- [四项独立单参数对照](evals/2026-09-17-four-parameter-comparisons.md)：四组800次检索与双人复核完成：RRF30小幅获益，标题1退化，阈值/更大预算无标注覆盖收益；当时未改默认，后续采用决定见上条。

- [新综合＋拆分＋每篇3：BM25权重0.5/0.25](evals/2026-09-17-bm25-weight-comparison.md)：权重降低后完整89/95→87/95，事实总数相同但分库得失不同；零新增API，两位独立复核通过，继续保留0.5。

- [新综合＋固定拆分：每篇3/4对照](evals/2026-09-17-source-limit-comparison.md)：单篇上限3→4只补回B-D17，完整89/95→90/95；同真实向量，两位独立复核通过，默认仍3。

- [新综合：保留/取消固定子问题对照](evals/2026-09-17-decomposition-comparison.md)：只用新综合，两组100题真实运行完成；33拆分题完整覆盖27/33对父问句21/33，两位独立复核通过；披露数值波动与唯一完整题反例。

- [三策略Hit、Recall与MRR](evals/2026-09-17-chunk-ranking-metrics.md)：同一100题离线重算，分库列出K=1/3/5/10；区分单块命中、跨块事实覆盖及已标注来源指标。

- [三策略100题同参数结果](evals/2026-09-17-structure-chunker-comparison.md)：heading90/95、原八股83/95、新综合89/95；完整参数、分库事实、上下文及得失均保留，双人结果复核通过；本轮未替换默认。

- [综合切块实施与100题同参数对照](development/2026-09-17-structure-chunker-comparison.md)：三策略hybrid100题对照与复核已完成；固定0.5/1权重、topk10、每篇3；实现与结果已push，本轮未新建PR或合并。

- [开源与商业Markdown切块调查](research/2026-09-17-markdown-chunking-solutions.md)：Luna/max调查7个方案，另核对QMD固定参考；比较结构保护、超长回退、尺寸/overlap口径与Echo采用边界；后续实施见上方综合策略记录。

- [开发语料段落与chunk尺寸分布](evals/2026-09-17-corpus-shape.md)：337篇只读结构统计，作为本轮综合策略设计依据；原始分布与判断边界保留。

- [小范围排查与问题清单](project/2026-09-17-small-scope-retrieval-investigation.md)：保留早期诊断假设与历史安排；已执行项见上方对照，后续按用户指示逐项推进。

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
