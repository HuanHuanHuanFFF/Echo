# 补读评测脚本恢复与目录参数

日期：2026-09-27。状态：按用户要求修复并重新提 PR；不自动合并。
基线：回退后的 main `a5ac1bc`。本轮恢复原 PR #23 的脚本、固定补读规则和历史报告；替代其脚本内固定本机目录及依赖当前工作目录的入口约定，评分规则与产品检索默认保持。

## 原因与修复

PR #23 的旧绿色检查基于 `2e1173a`。PR #22 新增发布路径检查后，三个补读脚本内六处固定目录使合入 main 的 [CI #189](https://github.com/HuanHuanHuanFFF/Echo/actions/runs/36254399758) 失败，随后由 PR #24 撤回。

[共享入口](../../evals/lib/supplement-cli.mjs)现在要求三个脚本显式传入全部目录：

| 参数                | 含义                                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| `--comparison-root` | 原 Echo/产品对照的冻结输入目录，含 `corpus-v1`、`freeze.json` 等              |
| `--qmd-root`        | QMD 安装、文件副本与首次查询记录目录，含 `app`、`private-data`、`runs-mcp` 等 |
| `--experiment-root` | 独立补读产物目录，存放 verification、各条件记录、summary、audit 和 seal 文件  |

相对路径以调用者的工作目录解析；含空格的路径须作为一个参数传入。没有本机默认值或自动目录搜索。输入目录保持只读，输出请使用独立目录；新脚本版本使用新的输出目录，避免混用既有验证记录。缺参数、未知参数、非法 action/condition 会在访问语料前报用法并退出。`--help` 不读取语料、不创建输出或启动 QMD。

```text
node evals/run-supplement-private.mjs verify --comparison-root COMPARISON --qmd-root QMD --experiment-root OUTPUT
node evals/run-supplement-private.mjs run echo --comparison-root COMPARISON --qmd-root QMD --experiment-root OUTPUT
node evals/run-supplement-private.mjs run rrf --comparison-root COMPARISON --qmd-root QMD --experiment-root OUTPUT
node evals/run-supplement-private.mjs run rerank --comparison-root COMPARISON --qmd-root QMD --experiment-root OUTPUT
node evals/run-supplement-private.mjs summarize --comparison-root COMPARISON --qmd-root QMD --experiment-root OUTPUT
node evals/audit-supplement-private.mjs --comparison-root COMPARISON --qmd-root QMD --experiment-root OUTPUT
node evals/seal-supplement-private.mjs --comparison-root COMPARISON --qmd-root QMD --experiment-root OUTPUT --published-summary NEW_SUMMARY_JSON --published-report NEW_REPORT_MD
```

`COMPARISON`、`QMD`、`OUTPUT` 均为待替换的目录示例。seal 另外必填 `--published-summary` 与 `--published-report`，指向本次待发布的聚合和报告文件；相对路径同样以调用者 cwd 解析。seal 在写出封存文件前读取两份材料，要求选定聚合与本次 summary 字节一致，并将二者 SHA 写入回执。新运行可以选择新的发布文件，不能覆盖或借用历史报告来满足校验。

## 冻结与历史结果边界

这些脚本服务于原固定实验，既有语料 SHA、200题/条件、汇总断言和拒绝覆盖保护均保留；目录参数化不把它们变成通用 benchmark，也不自动重定位冻结 JSON 内部保存的绝对路径。

verification 新增 `cli_sha256`，audit 和 seal 验证共享入口及 runner 的指纹。修改 runner/helper 后，旧 verification 不能被新版入口直接认作当前执行结果；应使用当时归档的执行源码审计旧产物，或使用新输出目录重新执行。不得手改旧 SHA 使检查通过。原私有产物未移动，未在本轮运行真实补读或模型。

[原报告](../evals/2026-09-26-echo-qmd-supplement-results.md)、[聚合 JSON](../evals/2026-09-26-echo-qmd-supplement-summary.json)、[冻结策略](../evals/2026-09-26-supplement-policy.md)及补读预算算法保持原 PR 字节内容。报告描述的是 2026-09-26 的固定历史实验，不能解读为新 CLI 或最新 Echo 响应版本重测。报告中的原始 worktree 产物位置指当时的私有执行工作区。

## 验证

[入口回归](../../tests/supplement-cli.test.ts)覆盖必填/非法参数、含空格目录、外部 cwd 的真实 CLI 帮助/失败路径，以及 runner/helper 指纹失配时拒绝写出产物、选定发布聚合不匹配时拒绝封存，以及新版本自洽产物的成功封存（合成结构样本，不代表真实评测）；[预算回归](../../tests/supplement-budget.test.ts)保持原有补读边界。测试只使用隔离目录，无个人笔记、QMD 模型或 API 请求。

本地 `npm run check` 通过：411份发布文件路径检查、格式、类型、构建、280项测试通过/1项既有跳过，以及CLI/MCP独立安装布局冒烟；Python公开计分校验6项通过。两位Astra/high独立复审通过，分别复跑14项入口/预算回归。远程结果以新PR当前提交的双平台CI为准；发布路径检查保留。

审查中发现原 seal 仍固定绑定历史发布聚合，新 runner 的 verification 指纹变化会使新执行无法完成封存。已改为显式选择本次发布文件，保持字节匹配及源码身份校验；历史报告与聚合不改写。
