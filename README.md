# Echo

本地 Markdown 证据检索 MCP：TypeScript + 嵌入式 SQLite，支持本地 BM25、API embedding、RRF 和 Agent 子问题查询。
Agent 负责拆问题、补读与回答；Echo 返回原文证据和定位。

**前四阶段已合并并通过 Windows/Linux CI。第五阶段工具已实现，真实 API 默认方案评测尚待配置及调用额度。**

## 先跑一个无 key 的样本

要求 Node.js 24.15.0（24 LTS）、npm 11；已验证 Windows x64 / Linux x64。

```sh
npm ci
npm run build
node dist/cli.js sync --config examples/echo.bm25.example.json
node examples/mcp-client.mjs
```

最后一步启动真实 stdio MCP 客户端并搜索两项样本证据。生成索引位于被 Git 忽略的 .echo/。

## 配置自己的笔记与 API

复制 [配置示例](examples/echo.config.example.json) 为 echo.config.json，填写：

- collections：每个知识库的 id 与本地 root。
- embedding：服务 base_url、model、dimensions，以及存放 key 的环境变量名。
- database：SQLite 文件路径。相对路径均以配置文件目录为基准；复制到项目根目录的示例使用 .echo/index.sqlite。

API 接口为 base_url/embeddings，发送标准 input 数组。key 不写入配置或索引；
默认环境变量名为 ECHO_EMBEDDING_API_KEY。PowerShell 示例：

```powershell
$env:ECHO_EMBEDDING_API_KEY = '<你的 key>'
node dist/cli.js sync --config echo.config.json
node dist/cli.js search --config echo.config.json --query '索引更新失败怎样恢复'
```

sync 会向缺少 echo_id 的 Markdown 写入 UUID v4。已有身份保持不变；
正文、路径、规则或模型改变后重新 sync。同步失败保留旧索引，已写回的 ID 会被重试复用。
未配置 API 时可明确设置 retrieval.mode 为 bm25；hybrid 查询的模型故障会报告部分失败，不冒充正常混合检索。

## MCP 接入与 Agent 使用

将以下 stdio 命令注册到支持 MCP 的宿主，并把 key 环境变量传给该子进程：

```text
node /absolute/path/to/echo/dist/cli.js serve --config /absolute/path/to/echo/echo.config.json
```

通用配置示例（具体配置入口由宿主决定）：

```json
{
  "mcpServers": {
    "echo": {
      "command": "node",
      "args": [
        "D:/CodingProject/echo/dist/cli.js",
        "serve",
        "--config",
        "D:/CodingProject/echo/echo.config.json"
      ]
    }
  }
}
```

- echo_search：单 query，或带 query_id 的多个独立问题及同意图 variants。
- echo_status：索引、配置与在途状态；不会发起计费健康检查。
- 用返回的绝对 path 和 1-based 行范围，通过宿主文件工具补读；Echo 不提供专用读取或链接导航工具。
- matched_query_ids 表示召回关联；有命中不代表答案完整。

[完整 MCP 契约](docs/development/phase-04-agent-mcp.md)。

## 默认与自定义方案

默认：标题感知 max_chars=1000，hybrid，每路候选 60，RRF k=60、权重 1/1，
topk=8、每篇最多 2、最低余弦相似度 0.3、完整结果 JSON 预算 12000 字符。
这些 hybrid 数值仍是待真实模型评测的起点。

配置支持部分覆盖；单次搜索可传 overrides 和 filters。
topk 与每篇上限同时生效，数量不足时不放宽约束填满。

完整自定义切块通过 chunker.module 加载可信本地模块：
[段落示例](examples/paragraph-chunker.mjs)、[结构父标题候选](examples/structural-heading-chunker.mjs)
及其[组合配置](examples/echo.structural-heading.example.json)。
自定义结果仍需提供连续原文行范围；原文内容由 Echo 生成并验证。

[配置契约与合法范围](docs/design/configuration.md)。

## 评测与开发

```sh
npm run check
npm run eval -- --lexical-only
npm run eval -- --lexical-only --config examples/echo.structural-heading.example.json
```

真实 API 评测必须显式指定配置与已获授权的调用上限：

```sh
npm run eval -- --config echo.config.json --max-api-calls 40
```

40 是命令示例，不表示已授权本任务付费调用。评测只使用 evals/corpus 的固定自编样本，
不读取配置中的个人 collections；输出到 .echo/evals，默认不覆盖已有报告。
API 模式先预热相同 query embedding，再比较 dense/hybrid/来源限制/子问题与补读。
记录调用尝试数、服务报告 token（缺失为 null）、语料/代码哈希、逐题事实覆盖与累计上下文预算。

- [第五阶段状态与缺口](docs/development/phase-05-evaluation-delivery.md)
- [本地评测快照](docs/evals/2026-09-15-echo-local-evaluation-r2.md)
- [全部文档](docs/README.md)

## 常见问题与限制

- 报重复/无效 UUID：修正冲突后重试；整次索引更新不会部分提交。
- 报模型/分词配置不同：重新 sync，不能直接混用不同配置的向量。
- 改名/修改后位置旧：确认 sync 已成功；搜索后再次编辑的时窗不提供额外一致性协议。
- 数据库不存在或旧 schema：先 sync 创建或迁移；搜索只读，不隐式重建。
- API 超时/不可用：检查地址、model、dimensions、key 环境变量；服务不接受 dimensions 时设置 send_dimensions=false。
- 自定义模块依赖变化：提升版本并重新同步。
- 扫描跳过隐藏目录、node_modules 和符号链接；单文件上限 10 MiB。
- 默认切块按整行，单行可以超过软尺寸；向量采用范围内精确扫描，大规模性能尚未验证。
- 小样本事实覆盖不等于全库质量、生成答案正确率或线上性能。当前真实语义效果仍未验收。

补读场景：`npm run eval -- --lexical-only --scenario long-context`。每次评测使用空输出目录；已有失败记录也不能覆盖。`report.json` 是所有必需产物完成后的发布标记，缺少它表示本次未完整交付。

## 升级提示（2026-09-16）

分词规则已补齐 HTTPServer 等缩写边界，旧索引需显式 sync。当前 hybrid/dense 同步会重新调用 embedding；
旧示例中 database=../.echo/index.sqlite 的用户请先改为项目内 .echo/index.sqlite。
已有配置和父目录中的数据库不会自动改动，详见 [P2 修复与升级说明](docs/development/2026-09-16-pr-review-fixes.md)。
