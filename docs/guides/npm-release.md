# npm 安装与发布

包名 `@huanf/echo`，首版 `0.1.0`，MIT。本文说明安装、MCP 接入和维护者发布流程；可用版本以 npm registry 为准。

## 使用者安装

要求 Node.js >=24.15.0 <25（当前 CI 固定24.15.0）、npm 11；验证平台为 Windows x64 和 Linux x64。包含 better-sqlite3/sqlite-vec 原生依赖，不能据此承诺所有系统架构均可免编译安装。

```sh
npm install -g @huanf/echo@0.1.1
echo-mcp init
echo-mcp config show
```

在自己的知识库工作目录执行 init；不覆盖已有配置和 README。填写 config/sources.json、config/embedding/default.json，向 Echo 进程提供 key 环境变量，再运行 echo-mcp sync。无 key 可把 retrieval/balanced.json 的 mode 改为 bm25。sync 会向缺少 echo_id 的 Markdown 写入 UUID；使用 API 时会发送配置范围内的正文，查询也会发送问题。

若笔记根目录设为整个工作区，请按 config/README.md 排除配置/策略目录中的说明，或把笔记放入单独的 notes 子目录。

放在不同工作目录的主入口默认分别拥有自己的数据库、配置和策略；多份知识库可以共用一次程序安装。同目录中只换主入口文件名，默认仍共享数据库和配置；需要隔离时使用不同目录，或显式配置不同的数据库和各类文件位置。多个 collections 指向同一个主入口时共享该数据库。[完整配置契约](../design/configuration-profiles.md)。

## MCP 接入

全局安装后，宿主可运行：

```json
{
  "mcpServers": {
    "echo": {
      "command": "echo-mcp",
      "args": [
        "serve",
        "--config",
        "/absolute/path/to/knowledge/echo.config.json"
      ]
    }
  }
}
```

替换主入口为真实绝对路径；示例 JSON 不展开变量。宿主须继承含 npm 可执行目录的 PATH 及 key 环境变量。Windows 某些宿主不能直接启动 .cmd：可改用 Node 可执行文件绝对路径，args 第一项为全局包中的 dist/cli.js 绝对路径（全局包位置可通过 npm root -g 查看），其余仍为 serve/--config。具体界面与环境变量入口由宿主决定。

也可使用 npx；此方式首次会下载包及依赖，应固定版本：

```json
{
  "mcpServers": {
    "echo": {
      "command": "npx",
      "args": [
        "-y",
        "@huanf/echo@0.1.1",
        "serve",
        "--config",
        "/absolute/path/to/knowledge/echo.config.json"
      ]
    }
  }
}
```

命令启动成功不等于模型服务可用。用 echo_status 查看集合和索引状态；[Agent 使用流程](agent-usage.md)。程序升级后重启 MCP；普通配置切换下一请求生效，数据库/runtime 改动也需重启。

## 维护者验证与发布

1. 从已审查且 CI 通过的最新 main 准备发布。核对根 README 的安装说明与文档链接；确认包名权限、版本号、MIT 声明及第三方许可保留。
2. 执行 npm ci、npm run check、npm run smoke:package。后者实际打包并安装到仓库外的临时目录，验证 bin、原生依赖、初始化说明、同步、搜索、MCP 和原文新鲜度；不使用个人语料或模型 key。
3. 执行 npm pack --dry-run 检查清单。允许打包 dist、package.json、README、LICENSE；仓库历史 docs/evals、个人配置、笔记与生成索引不分发。
4. 用 npm whoami --registry=https://registry.npmjs.org 确认 huanf 账户，npm view @huanf/echo version 检查已有版本。公开版本不能原地覆盖。同步 package.json/package-lock.json 版本并重新验证；MCP 服务版本也需同步。
5. 在获得发布授权后执行 npm publish --access public，按提示完成账户验证。prepublishOnly 会执行完整检查与安装包验收；普通 push/PR CI 不发布，无 npm 凭据。
6. 从 registry 安装明确版本，复验 CLI/MCP，核对包版本与完整性；创建对应 Git 标签和 GitHub Release，记录实际发布提交。发布失败则记录状态，不宣称用户已经能安装。

本轮配置 publishConfig 指向公开 npm registry，prepack 验证 dist 为仓库内生成目录后清空并重新构建，避免历史产物混入。通过 npm pack 安装产物仍不等同于已完成 registry 发布验证。CI 不依赖个人笔记或模型 key，但依赖 npm/原生预编译包下载可用。

## 依据与边界

- [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)：files、bin、publishConfig 和 license。
- [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/)：产物与文件清单核验。
- [MIT 标准文本](https://choosealicense.com/licenses/mit/)：Echo 自有代码许可；第三方依赖及外部语料不自动改许可。

以上官方资料核对日期2026-09-27。安装结果以本轮和发布后的实际验收为准。
