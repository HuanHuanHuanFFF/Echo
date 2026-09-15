# Echo

面向本地 Markdown 的轻量证据检索 MCP，TypeScript + 嵌入式 SQLite。
Agent 拆问题、补读原文件并生成答案；Echo 负责索引与证据。
embedding 默认由用户配置 API 服务与 key；BM25 分词在本地运行。

## 开发入口

要求 Node.js **24.15.0（24 LTS）**、npm 11、Windows x64 或 Linux x64。

```sh
npm ci
npm run dev -- --help
npm run check
npm run build
node dist/cli.js serve
```

`serve` 以 stdio 运行，标准输出仅承载 MCP。用支持 MCP 的宿主启动
`node /absolute/path/to/echo/dist/cli.js serve`。
MCP 当前提供 `echo_status` 连通性工具；CLI 已支持导入与同步，真实检索随后续阶段交付。

- 格式：`npm run format` / `npm run format:check`
- 类型：`npm run typecheck`
- 测试：`npm test`（仅 tests/，临时数据库）
- 构建：`npm run build`
- [配置与切块契约](docs/design/configuration.md)
- [阶段验收](docs/development/phase-01-foundation.md)
- [项目文档](docs/README.md)

个人笔记、凭据和数据库不提交；`echo.config.json`、`.echo/` 已忽略。

## 显式同步（阶段 2）

先复制 [配置示例](examples/echo.config.example.json) 为 echo.config.json，将 collection.root 改为自己的 Markdown 目录。
路径相对配置文件位置解析。sync 会向缺少身份的文件写入 UUID v4；首次尝试请用笔记副本。

```sh
node dist/cli.js sync --config echo.config.json
node dist/cli.js status --config echo.config.json
```

当前同步覆盖原文、身份与 chunks；阶段 3 接入本地 BM25 与 API embedding。
[自定义切块示例](examples/paragraph-chunker.mjs)通过 chunker.module 加载，详情见[阶段 2 契约](docs/development/phase-02-import-sync.md)。

## 本地样本搜索

```sh
node dist/cli.js sync --config examples/echo.bm25.example.json
node dist/cli.js search --config examples/echo.bm25.example.json --query "事务失败怎么恢复"
```

这个样本使用本地 BM25，不需要 key。实际 hybrid 使用配置示例中的 API 地址、模型、维度和 key 环境变量，完成同步后搜索。
搜索支持 --overrides 与 --filters 的 JSON 参数；完整范围与预算说明见[阶段 3](docs/development/phase-03-hybrid-retrieval.md)。
