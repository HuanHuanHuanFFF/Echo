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
当前阶段 1 仅提供 `echo_status` 连通性工具，真实检索随后续阶段交付。

- 格式：`npm run format` / `npm run format:check`
- 类型：`npm run typecheck`
- 测试：`npm test`（仅 tests/，临时数据库）
- 构建：`npm run build`
- [配置与切块契约](docs/design/configuration.md)
- [阶段验收](docs/development/phase-01-foundation.md)
- [项目文档](docs/README.md)

个人笔记、凭据和数据库不提交；`echo.config.json`、`.echo/` 已忽略。
