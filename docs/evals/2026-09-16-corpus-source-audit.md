# 外部笔记语料来源初筛

日期：2026-09-16。状态：来源/固定提交/Markdown清单初筛已开始，尚未选定B/C/D资料，未导入正式语料或调用embedding。
执行依据：[默认方案评测决定](../project/2026-09-16-evaluation-revision.md)和[协议](2026-09-16-personal-knowledge-protocol.md)。

## 当前候选

| 来源                                                                                                                      | 固定提交 | .md文件数 | Markdown总大小 | 仓库元数据许可 |
| ------------------------------------------------------------------------------------------------------------------------- | -------- | --------: | -------------: | -------------- |
| [simonw/til](https://github.com/simonw/til/tree/908013b1abaa4f6c0a7d439086cfbfb57d990bf8)                                 | 908013b  |       580 |       2.26 MiB | Apache-2.0     |
| [lyz-code/blue-book](https://github.com/lyz-code/blue-book/tree/6221f26036ce31033747cebef9646c89808502c5)                 | 6221f26  |      1122 |      10.40 MiB | CC0-1.0        |
| [oldwinter/knowledge-garden](https://github.com/oldwinter/knowledge-garden/tree/2ad252e3820b775040d726298ea9b05821e86783) | 2ad252e  |       961 |       2.46 MiB | MIT            |
| [dunwu/blog](https://github.com/dunwu/blog/tree/d8d945e015e6eaee94ea745447917287f1281a84)                                 | d8d945e  |       607 |       9.96 MiB | CC-BY-SA-4.0   |

以上是固定Git树中所有.md文件的清单统计，包含README、模板或站点说明等未筛选项；不是最终可用笔记数。归档/提交日期、树SHA及目录规模见[审计清单](2026-09-16-corpus-source-audit.json)。远程pushed_at与默认分支提交日期不必相同，因此正文快照绑定commit。

## 下一步与边界

- 只下载Markdown和必要许可说明到E盘作内容/结构抽样，不克隆大体积历史或执行仓库代码。
- 逐项确认语言、内容类型、引用/转载关系、适用许可、空壳或导航文件比例；仓库元数据的许可标签不能替代逐项审阅。
- 冻结抽样规则、文件列表和哈希后再选定语料；保留真实笔记结构，不预先统一改写。
- 结合现有私有库选择3–4个独立真实来源及约500–800篇资料；当前四个公开候选不等于四个都纳入。
- D库的查询、标签和检索成绩继续与开发隔离，当前没有生成D题目或使用其效果调参。

本轮只保存了公开来源信息；逐文件完整树清单保存在本地evidence/corpus-audit-2026-09-16T08-20-28-388Z/。
