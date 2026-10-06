# 预览预算与返回上限

日期：2026-10-06。状态：实现、本地验证与独立审查完成，待 PR 验收。依据用户逐项确认的行为，替代[阶段 3](phase-03-hybrid-retrieval.md)超预算丢整块及[接口收尾](2026-09-26-agent-interface-polish.md)的预算空命中行为；旧实验和报告保留。[后续计划](../project/2026-10-04-follow-up-plan.md)仍是其他事项入口。

## 契约与实现归属

- [config.ts](../../src/config.ts)：topk 默认仍为 10；配置新增 max_results 默认 20，允许 1–100，topk 不得超过它，单次 overrides 不能修改上限。旧配置省略时继承 20，旧 topk>20 应显式调整，不静默截取。
- [retrieval.ts](../../src/retrieval.ts)：保持排名、子问题轮流取块、去重及每篇默认 6 块；preview 先选块再装正文，不因正文预算丢选中块。完整元数据放不下时报 CONTEXT_BUDGET，建议增大预算或降低 topk。新增 whole 的整块预算规则见下节。
- [preview.ts](../../src/preview.ts)：预留完整定位/状态/诊断后，将剩余转义 JSON 正文空间均分，短块余量回收；连续取原文前缀，允许行内裁剪，不切开代理对。为变化的预览位置数字预留少量空间，不保证精确填满预算。
- 每块的 start_line/end_line、section 范围与 chunk_id 保留完整块语义；text_truncated 和 preview_range 描述实际正文。预览为 1-based 行/UTF-16 列，终点不包含；空正文对应空范围。正文全部能放下时保持完整。
- max_context_chars 仍计完整业务 JSON UTF-16 码元（默认 20000），不含请求、MCP 外层和后续读取。preview 的 limits.budget 表示裁剪；diagnostics.excluded.budget 为 0。whole 的 budget 表示整块剔除，计数保留，两个口径不混用。
- [retrieval-evaluation.ts](../../src/retrieval-evaluation.ts)：核实返回的原文前缀和预览范围；按实际返回文字检查标注行覆盖，不能因完整块行号仍包含事实，就给未展示的事实计分。

## 使用与边界

[evaluation.ts](../../src/evaluation.ts) 保留开发评测默认 8000 的累计预算。元数据不足时记录带 CONTEXT_BUDGET 的 error 行、零事实覆盖并计入错误数，继续运行；其他异常仍中止并保留失败工件。不自动降低 topk 或增大预算，显式选择 20000 仍独立记录。

[Agent 查询说明](../guides/agent-usage.md)、[新工作区模板](../../templates/workspace/config/retrieval/README.md)、[工具描述](../../src/server.ts)和根 README 已更新。新 init 从配置 schema 生成包含配置专属上限的参数表；已有目录 README 仍不覆盖。已有调用方必须检查截断标记后补读，不能继续假设 text 等于整个 start_line/end_line 范围。

这是检索响应变化，不改切块、分词、模型或数据库结构，无须重建索引。补读、源文件版本核对、证据充分性判断和回答由调用方负责。游标、Jev、自动引用恢复、自动读取和独立字符硬预算不在本次范围；没有调用付费模型或修改个人笔记。

## 装箱模式修订与 Review 问题

用户进一步确认：packing_mode 支持默认配置和单次传入，默认 preview；传统检索评测采用原来的完整块评分。whole 模式在完整 JSON 预算内跳过放不下的整块，再尝试后续较小候选，不是遇到一块放不下就停止。末尾状态计数引起超限时移除尾块；不裁正文、不中途占用来源名额。两模式均返回完整块位置、text_truncated 和 preview_range，响应顶层 packing_mode 明确实际模式；whole 正文始终完整。

Review 指出 [参数探索运行器](../../evals/run-minisearch-parameter-exploration.mjs) 和 [Qasper 运行器](../../evals/run-public-qasper.mjs) 的评分校验仍要求完整正文。两入口现在显式选 whole，配置与请求记录模式；[Qasper 评分器](../../evals/lib/public-runtime.mjs) 保留完整行校验和原评分公式，不把未返回文字计覆盖。运行器的固定参数不允许单个参数臂意外覆盖装箱模式。旧冻结成绩不修改，新运行需用包含本参数的代码/运行时重新冻结。

本次不引入自动补读或固定分配检索/补读总预算；真实 Agent 按相关性选读仍独立评测。新增回归覆盖配置继承/单次覆盖、非法模式、预算空命中、后续较小块、来源配额和 Qasper 长块整块舍弃。

新冻结身份还明确固定 whole，并绑定脚本及全部已记录运行时模块（含 preview.js）。普通执行、单范围续跑与 finalize 入口均先检查身份；旧冻结必须用其原脚本/运行时，不由新入口追认。隔离 CLI 回归确认旧冻结在读取输入之前拒绝，Qasper 配置回归实际执行无模型 configure，生成配置显式为 whole。

压力审查发现大正文在裁剪前合并序列化会越过运行时字符串上限。现先序列化空正文元数据，再用带预算上限的转义字符成本核算；不先生成完整大 JSON，whole 也用此方式判断候选。位置计算扫描换行，不拆出大行数组。100 个 6M 字符块及单块 100M 控制字符的两模式回归，修复前均 RangeError，修复后返回预算内预览或 whole 的预算空命中。

模式扩展本地 npm run check 通过：47 文件、304 项通过、1 项 Windows 条件跳过；格式、类型、构建、默认运行验收与路径检查通过。打包隔离安装、CLI/MCP、配置说明及 6 项公开评分 Python 回归通过。审查后的身份门禁及大正文修复均有实际失败复现和通过回归；最终独立复审核对成本计数与完整 JSON 序列化规则等价。没有重跑真实语义检索实验或修改历史输出，远端 CI 以本次 PR 最新提交为准。

## 首批验证（5bddbe6）

- [预算预览回归](../../tests/budget-preview.test.ts)：固定 20 个长块及 20000 预算，检查全部定位保留、均分及余量回收；极小预算、空正文、JSON 转义、Unicode、行内位置、来源限制和否定句在预览外。
- [Agent 接口回归](../../tests/agent-interface.test.ts)：真实 MCP 下预览标记、块数不缩水、配置上限拒绝、预算错误和可见完整 JSON 长度。
- [冻结检索评测回归](../../tests/retrieval-evaluation.test.ts)：长行尾部事实被裁掉时不得计为覆盖。
- 回归反证：临时恢复 origin/main 的旧装箱实现，9 项预览回归中的 8 项失败（固定 20 长块/20000 预算只返回 2 块），随后恢复新实现通过。配置上限回归独立验证，不改变旧候选集合或预算。
- 本地 npm run check 通过：路径检查 438 文件，格式、类型、构建，47 测试文件中 293 项通过、1 项 Windows 平台条件跳过，默认 CLI/MCP 验收通过。npm run smoke:package 通过：114 个打包文件，隔离安装、生成说明、CLI/MCP、来源定位与更新检查有效，无新模型调用。
- 两位独立只读审查无剩余阻塞。分别复跑 70 项相关测试及 54/17 项定向测试，追加 1080 组和 6000 次确定性预算边界检查。审查发现默认 8000 评测入口被元数据错误中止，已修复为明确 error 行；默认 42 行中 6 条预算错误，20000 对照 42 行零错误，预算均合规。首次并发测试出现一次原生 worker 异常退出，单 worker 复跑通过，完整项目检查也通过，未证实为实现缺陷。
- 文档本地引用及 git diff --check 已核对；远端双平台 CI 以 PR 当前提交为准。本轮隔离样本不证明真实语义检索变好，也不证明 Agent 会正确补读；历史整块结果不能直接当作新预览版本成绩。
