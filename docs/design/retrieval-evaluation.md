# 单轮召回评测脚本

日期：2026-09-16。状态：已实现，验证见[开发记录](../development/2026-09-16-single-turn-evaluation.md)。
用户最新范围：只测独立问题的一次召回，包含预先拆好的子问题；暂不测试历史对话分析、
Agent动态改写、回答生成或宿主补读。此范围替代[原评测协议](../evals/2026-09-16-personal-knowledge-protocol.md)中本轮Agent/补读安排。

## 运行接口

先用普通sync显式准备所选索引；真实笔记测试始终在E盘副本与独立安装上执行。
本脚本只读已有索引和笔记，不自动同步、不写UUID，也不为每题运行Agent。
模型为dense/hybrid时必须提供本轮查询API请求上限；建索引费用另行记录。

```sh
npm run eval:retrieval -- snapshot --config /path/echo.config.json --output /path/corpus.json
npm run eval:retrieval -- run --config /path/echo.config.json --dataset /path/questions.json --output /path/new-run --budget 12000 --max-api-calls 100
```

也可构建后直接执行node dist/retrieval-eval-cli.js，避免重复构建。
snapshot写出实际扫描范围的路径/哈希清单；笔记必须已有有效UUID。
run要求v2配置。snapshot输出和run目录均须位于笔记目录之外，且不会覆盖已有文件/运行。
max-api-calls是查询embedding请求数上限，不是token或题数；一题多个子问题可能产生多个请求。
bm25模式不调用embedding，可不提供该参数。退出码0表示运行完成，2表示有检索部分失败，1表示输入/运行失败。

## 题集契约

JSON version=1，必需name、split（development/test）、scenario（id和separate/mixed）、corpus、facts、questions。
corpus直接采用snapshot输出的数组，要求与配置实际扫描文件完全匹配；题集不提供隐式答案来源过滤。

```json
{
  "version": 1,
  "name": "library-a-development",
  "split": "development",
  "scenario": { "id": "library-a", "kind": "separate" },
  "corpus": [
    {
      "collection_id": "notes",
      "path": "transaction.md",
      "sha256": "<用snapshot生成的64位哈希替换>"
    }
  ],
  "facts": [
    {
      "id": "rollback",
      "evidence": [
        {
          "collection_id": "notes",
          "path": "transaction.md",
          "start_line": 6,
          "end_line": 6,
          "quote": "失败时回滚未提交的修改。"
        }
      ]
    }
  ],
  "questions": [
    {
      "id": "q1",
      "intent_group": "transaction-recovery",
      "type": "single_fact",
      "query": "事务失败时，未提交的修改怎样处理？",
      "required_facts": ["rollback"],
      "no_answer": false
    }
  ]
}
```

以上展示结构，路径/行号/quote及哈希必须替换为该冻结语料的真实标签，不能直接作为任意资料的题集。
quote必须等于所标原文整行范围（LF连接），不可跨frontmatter或超出原文。
一个fact的多个evidence条目表示可互相替代的支持来源；需要多项同时成立时拆成多个required_facts。
同一事实可由实际返回的多个chunk共同覆盖其范围；不能补读未返回正文来凑分。
除空白行外，支持范围必须被返回片段完整覆盖。脚本验证来源身份、版本、原文内容与范围，避免同词异源误计分。

## 固定子问题

为复杂完整问题增加subquestions：

```json
[
  {
    "id": "transaction",
    "text": "事务失败如何回滚？",
    "required_facts": ["rollback"]
  },
  {
    "id": "approval",
    "text": "审批批准后从哪里继续？",
    "required_facts": ["resume"]
  }
]
```

父题required_facts需要同时列出rollback和resume，facts中必须存在其真实标签。
子问题ID沿用Echo的1–64字符去空白规则，每题最多8个且唯一；各子题标签的并集须覆盖父题标签。
脚本把这些子问题作为一次echo_search的queries输入，记录父题总覆盖、各子题覆盖及引擎原始子题状态。
不在执行时临时调用模型拆题。原问题、子问题和标签都提前冻结，各chunk方案接收同样输入。
这衡量固定拆分下的召回表现，不衡量Agent自动规划能力。

无答案题no_answer=true且required_facts为空；非空返回单独统计，不能直接称为幻觉。
同义问法、时间/版本条件和实体辨别均由完整query表达，不依赖此前对话。
特殊时间信息若仅存在未返回的frontmatter等字段，须作为范围限制记录，不伪造正文标签。

## 输出、预算和失败

- .attempt.json：独占运行占位，防止并发或重跑覆盖。
- dataset.json：该次实际标签输入副本。
- manifest.json：语料哈希、运行代码哈希、配置/模型与索引绑定。
- rows.jsonl：逐题完整请求/结果、父子题覆盖、状态、延迟和上下文字符。
- usage.json：实际查询API用量与本轮内查询向量缓存命中。
- report.json：最后发布的成功/部分失败汇总，含按题型与独立意图组统计。
- failure.json：未能完成时记录错误、已完成行数和已知用量；不发布成功报告。

请求与完整JSON响应合计不超过budget；同时保留所选配置的max_context_chars上限。
其余召回参数不被脚本自动放宽。当前无Agent或补读，因而不计不存在的回答/补读成本。
每题计时包含实际embedding调用（如有）与引擎检索，不包含语料校验、MCP传输或Agent执行；
缓存命中与API请求数逐题可见，不把它冒充统一冷启动延迟。

索引/原文变动、错误标签、失效索引、额度耗尽或输出落盘失败均不能生成成功报告。
运行前后校验语料、选定索引及运行代码；不自动修复或重建它们。
这是逐次运行器；跨方案统计区间、来源审计和正式300题标签仍须独立完成，不能只凭脚本跑通宣布效果验收。
