# 单轮召回评测实现

日期：2026-09-16。状态：PR #10 已合并，提交 b454686 的Windows/Linux CI全通过；E盘独立安装99项通过/1项平台跳过。
承接[正式评测决定](../project/2026-09-16-evaluation-revision.md)，以用户最新单轮范围为准。

## 模块与职责

- [retrieval-evaluation.ts](../../src/retrieval-evaluation.ts)：冻结语料/标签校验、只读索引检查、直接引擎调用、父子题覆盖、请求额度、落盘与运行绑定。
- [retrieval-eval-cli.ts](../../src/retrieval-eval-cli.ts)：snapshot/run命令；入口npm run eval:retrieval。
- [契约](../design/retrieval-evaluation.md)：输入标签、预算、运行结果和失败语义。
- [隔离回归](../../tests/retrieval-evaluation.test.ts)：仅使用临时Markdown/数据库与本地协议fixture，不需要个人资料或真实key。

本轮不更改Echo检索排序和默认参数。现有固定样本npm run eval继续保留；
新脚本接收任意已同步的v2配置和冻结题集，无Agent逐题查询、回答生成或宿主补读。

## 已完成闭环

完整 npm run check 通过：99项通过、1项平台跳过，含格式、类型、构建检查；其中14项针对性回归覆盖：
原文引用/来源身份、预算与配置上限同时生效、固定子问题同次召回与各自覆盖、
错误标签/变化语料/旧索引拒绝、输出覆盖保护、异源同词不计分、跨块事实覆盖、
真实HTTP边界的请求额度与失败用量、子问题ID归一化、快照不写笔记目录、非法UTF-8原文与题集拒绝、合法BOM保留。

预算放宽与子问题ID归一化均先重现失败，再修复并复验。
本地HTTP固定向量只验证调用与限额，不作为语义效果证据。

两位独立复核均重现了宽松UTF-8解码导致不同字节获得同一文本哈希的问题；
已改为原文/题集严格解码和直接字节哈希，运行文件也按字节绑定。
红→绿回归、两位独立重放、合法BOM及字节一致性复核均通过。

## 仍待完成

候选语料已完成正文日期筛选和BM25准备，见[语料快照](../evals/2026-09-16-corpus-preparation.md)；正式开发100/最终200题标注及复核；
真实语料向量索引、两套chunk执行与统计对照。跨方案统计工具见[后续记录](2026-09-16-paired-evaluation-statistics.md)，仍待完整验收。
当前实现不是300题评测已完成的证明，亦不包含动态Agent上下文能力评估。

## 安装验收补充

[PR #10](https://github.com/HuanHuanHuanFFF/Echo/pull/10)已于2026-09-16合并为c7afe1d。E盘echo-runtime-b454686独立npm ci/check通过，源码归档SHA256为e13d1b480dc2e4a2c5c9473fb9608779acdc987d52928ee117b0a109caf272e6。当前echo.ps1与eval-retrieval.ps1指向该版本。C库166篇快照、一次请求含两个固定子题的CLI冒烟通过，2项事实覆盖、0次API；两意图排除在正式题库之外。此工程冒烟不能作为语义效果证据。
