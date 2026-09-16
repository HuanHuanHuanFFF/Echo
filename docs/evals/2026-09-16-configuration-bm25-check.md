# v2 配置接入的固定样本 BM25 检查

日期：2026-09-16。代码：干净提交 9d8bf04ee578e0fa2ac12f358434c2255723c82c。状态：本地 BM25 验证完成，未调用真实 embedding，不是第五阶段真实语义验收。

## 条件与证据

使用 [固定语料/标签](../../evals/dataset.json)，10 篇自编 Markdown、14 题、24 项事实；与 [R2 默认快照](2026-09-15-echo-local-evaluation-r2.md) 的 corpus/labels SHA-256 完全一致，每题累计请求/搜索/补读预算同为 8000 字符。切块为 heading-1000 固定策略，使用同一标题感知 1000 字符规则；tokenizer=icu-zh，embedding 未使用，retrieval=bm25，具体参数和实现快照见 manifest。

```sh
npm run eval -- --lexical-only --config examples/profiles/example.json --output .echo/evals/configuration-9d8bf04
```

输出目录不可复用。索引与原始报告在上述忽略目录，公开证据为 [manifest](2026-09-16-configuration-bm25.manifest.json) 与 [42 行逐题记录](2026-09-16-configuration-bm25.rows.jsonl)，不含个人笔记或 key。

## 结果

| 方案            | 事实覆盖 | 完整可答题 | 14 题累计上下文字符 |
| --------------- | -------- | ---------- | ------------------- |
| R2 原默认 BM25  | 23/24    | 12/13      | 57519               |
| v2 默认 BM25    | 23/24    | 12/13      | 61215               |
| v2 放宽来源上限 | 24/24    | 13/13      | 63508               |
| v2 宿主补读     | 23/24    | 12/13      | 70295               |

对默认方案逐题移除新增 selection 字段后，14/14 的证据、排名和诊断与 R2 完全一致。每次新增 selection 为 264 字符，累计增加 3696（约 6.4%），用于追踪活动 ID、配置版本和来源快照；未观察到事实覆盖提升。

三种 v2 策略均无运行错误；不可答题仍返回非空结果，所以关键词命中不代表答案成立。放宽单篇上限在小样本中的提升不能外推，也未据此更换默认限制。不同时间点的延迟不作因果性能比较。

本快照绑定上述代码；后续索引失效/错误恢复修复见[修订开发记录](../development/2026-09-16-configuration-revision.md)。真实模型、其他语料和大型库仍需独立评测。
