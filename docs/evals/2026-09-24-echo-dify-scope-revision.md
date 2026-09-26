# Echo 与 Dify 全量对照范围修订

日期：2026-09-24。状态：**用户已确认取消 Khoj 后续测试；Echo/Dify 已核分，见[正式结果](2026-09-24-echo-dify-results.md)。**

本记录修订[2026-09-22 三产品对照协议](2026-09-22-product-comparison-protocol.md)中“Khoj 两条件全量查询、四条件评分与交付”的范围。语料、问题、模型、已冻结的检索参数和共同预算不变；保留原协议及[执行恢复记录](2026-09-24-product-comparison-recovery.md)供追溯，不把未确认建议当作新默认。

## 正式比较

- Echo A 与 Dify hybrid 各使用同一批 3507 道父题：私有笔记 200、QASPER 1005、FreshStack LangChain 203、Godot 99、Du 2000。私有题保留冻结子问题；没有 Agent 答案生成。
- Echo A 仍是本轮高召回实验条件，每篇最多 6 块、topk 10、20,000 UTF-16 字符累计预算；不改变产品默认的每篇 3 块。Dify 保留原生父子切块和 0.7/0.3 加权混合配置。
- 两条件九个范围的真实查询与原始结果均已通过[运行完整性核验](../../evals/lib/product-run-integrity.mjs)。最终[模型来源审计](../../evals/audit-product-model-provenance.mjs)验证当前缓存 221,360 条记录；它包括实验期间产生的 Khoj 缓存记录，不代表 Khoj 全量成绩。审计程序本身没有新增模型 API 调用，实验调用量另计。
- 官方评分、逐题配对、上下文与运行成本仅对 Echo/Dify 发布。完整结论必须等待评分文件、条件归属回执、分母与映射核验以及独立复查；两产品质量结论及其边界见[正式结果](2026-09-24-echo-dify-results.md)，本记录仅定义范围。

## Khoj 中止边界

用户因本地重排耗时取消 Khoj。隔离服务已停止，未改索引和原始结果，也未生成 Khoj 评分。私有五范围各 200 题的向量/重排两列已验真；QASPER 向量列 1005 题已验真，重排列中止于 641/1005；LangChain、Godot、Du 均未查询。取消时的文件 SHA、题量和状态保留在 E 盘实验目录 `attempts/v5-khoj-user-cancelled/manifest.json`。这些部分数据只作运行归档，不进入正式比较，不推断 Khoj 的全量效果。

本轮全局 `freeze.json` 仍保留原四条件输入指纹；较新的本记录只替代交付范围，不伪造一份“事前冻结的两条件协议”。评分脚本按条件独立运行，报告必须明确选择 Echo/Dify 两条件并拒绝把不完整的 Khoj 当成零分或缺失预测。
