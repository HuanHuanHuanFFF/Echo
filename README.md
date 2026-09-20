# Echo

本地 Markdown 证据检索 MCP：TypeScript + 嵌入式 SQLite，支持本地 BM25、API embedding、RRF 和 Agent 子问题查询。
Agent 负责拆问题、补读与回答；Echo 返回原文证据和定位。

**前四阶段已合并并通过 Windows/Linux CI。个人笔记与公开数据的真实 API 评测已有结果；默认采用与剩余产品验收分别记录。** 当前默认统一见[冻结记录](docs/project/2026-09-20-default-freeze.md)，效果与限制见[公开评测总结](docs/evals/2026-09-20-public-full-results.md)。

## 先跑一个无 key 的样本

要求 Node.js 24.15.0（24 LTS）、npm 11；已验证 Windows x64 / Linux x64。

```sh
npm ci
npm run build
node dist/cli.js sync --config examples/profiles/example.json
node dist/cli.js search --config examples/profiles/example.json --query '事务失败怎样恢复'
```

样本使用本地分词与 BM25，不需要模型 key。生成索引位于被 Git 忽略的 .echo/。

## 配置自己的笔记与 API

在自己的工作目录初始化：

```sh
node /absolute/path/to/echo/dist/cli.js init
node /absolute/path/to/echo/dist/cli.js config list
node /absolute/path/to/echo/dist/cli.js config show
```

主入口 echo.config.json 按 ID 选择 chunker、tokenizer、embedding、retrieval。切块/分词是各自目录中的固定 .mjs 策略；模型与召回各用一个 JSON 文件，可保存多份。笔记范围、运行参数与日志也分别保存。

- config/sources.json：填写 collections 的 id/root，可设 include/exclude/max_file_bytes。
- config/embedding/default.json：填写 base_url、model、dimensions；其余模型调用参数也放在此文件，API key 仍通过 api_key_env 引用环境变量。
- config use：一次切换一项或多项配置；已有 MCP 下一请求生效，在途请求保留原配置。数据库路径或运行参数变化需重启。升级 Echo 程序本身后也应启动新版本服务。

```powershell
$env:ECHO_EMBEDDING_API_KEY = '<你的 key>'
node /absolute/path/to/echo/dist/cli.js sync
node /absolute/path/to/echo/dist/cli.js config use --chunker heading-500 --retrieval balanced
```

没有模型时可显式选择 --retrieval bm25 后同步。切换不会隐式构建索引，config show 会显示是否需要 sync。sync 会给缺少 echo_id 的笔记补写 UUID v4；已有身份不变，失败保留旧索引。

[完整 v2 配置、策略接口与迁移说明](docs/design/configuration-profiles.md)。旧配置可执行 config migrate；迁移前可先备份数据库。参数会固化进新的固定策略，不被静默丢弃。

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

默认：标题感知 max_chars=1000，hybrid，每路候选 60，RRF k=30、BM25/向量权重 0.5/1，
topk=10、每篇最多 3、最低余弦相似度 0.3、完整结果 JSON 预算 16000 字符。
以上是当前新工作区的实际默认。近期新综合切块属于评测候选，最终采用状态统一见[默认冻结记录](docs/project/2026-09-20-default-freeze.md)；历史成绩仍对应各自冻结条件。新init会完整写出召回参数，已有配置不自动改写。

召回配置支持部分覆盖；单次搜索可传 overrides 和 filters。切块策略的规则固定，改变数字应另建策略 ID。
topk 与每篇上限同时生效，数量不足时不放宽约束填满。

例如一次 echo_search 可传 `{"query":"事务失败怎样恢复","overrides":{"topk":6,"max_chunks_per_source":2,"bm25_weight":1}}`。
覆盖只作用于本次调用；已有配置显式填写的数值仍优先于内置默认，升级不会重写配置文件。

完整自定义切块通过 chunkers/ 下的同名 ID 模块加载；tokenizers/ 同样可提供完整分词实现。来源、chunk、FTS 与不同模型向量按依赖隔离；更换分词不会重切或重新 embedding，已存在且有效的组合直接复用。

[当前配置契约](docs/design/configuration-profiles.md)；[旧格式与历史自定义示例](docs/design/configuration.md)。

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

## 历史版本升级提示（P2 修复）

分词规则已补齐 HTTPServer 等缩写边界，旧索引需显式 sync。旧格式 hybrid/dense 同步会重新调用 embedding；v2 按各索引依赖复用已有数据。
旧示例中 database=../.echo/index.sqlite 的用户请先改为项目内 .echo/index.sqlite。
已有配置和父目录中的数据库不会自动改动，详见 [P2 修复与升级说明](docs/development/2026-09-16-pr-review-fixes.md)。

## 自有语料的单轮召回评测

已同步的 v2 索引可用 `npm run eval:retrieval -- --help` 查看入口。
先用 `snapshot` 冻结文件清单，再用 `run` 执行有原文证据标签的独立问题；固定子问题放在同一请求中。
脚本校验语料、索引和引用，记录父子题覆盖、延迟、上下文用量与 API 调用；不会逐题运行 Agent。

[脚本接口与题集格式](docs/design/retrieval-evaluation.md) · [实现验证与边界](docs/development/2026-09-16-single-turn-evaluation.md)。
