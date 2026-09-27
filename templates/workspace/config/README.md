# Echo 工作区配置

本目录由 `echo-mcp init` 首次初始化时创建；已有文件保留。所有下述路径相对主入口 `echo.config.json` 所在目录解析，与启动命令的目录无关（未传 `--config` 时，主入口取当前目录）。

## 文件职责

| 文件或目录                                | 配置内容                                             |
| ----------------------------------------- | ---------------------------------------------------- |
| 主入口 echo.config.json                   | 数据库路径、配置目录位置、active 中四类配置 ID       |
| [embedding/](embedding/README.md)         | 服务 URL、模型、维度、key 环境变量及全部模型调用选项 |
| [retrieval/](retrieval/README.md)         | 检索模式、候选量、RRF、数量与预算                    |
| [../chunkers/](../chunkers/README.md)     | 固定切块策略                                         |
| [../tokenizers/](../tokenizers/README.md) | 固定分词策略及声明资源                               |
| sources.json                              | 笔记集合、扫描范围和文件大小上限                     |
| runtime.json                              | 搜索超时、并发和 SQLite 等待时间                     |
| logging.json                              | 日志级别、位置、轮转大小与保留数量                   |

位于不同工作目录的主入口默认分别使用各自目录中的 `.echo/index.sqlite`；同目录仅更换主入口文件名，默认仍共享数据库和配置。每个 sources.json 可以包含多个集合，它们进入同一个所选数据库。主动指向相同数据库或配置目录会共享资源。API key 的环境变量独立于目录隔离。

## 从配置到检索

先在 sources.json 填写笔记目录，例如：

```json
{
  "collections": [
    {
      "id": "notes",
      "root": "notes",
      "include": ["**/*.md"],
      "exclude": ["private/**"],
      "max_file_bytes": 10485760
    }
  ]
}
```

建议将笔记放在独立 notes 子目录。若 collection.root 设为工作区本身（"."），请在 exclude 中加入 "config/**"、"chunkers/**"、"tokenizers/**"（使用自定义目录时按实际位置调整），避免把这些生成说明当成笔记检索；同时保留自己需要的隐藏项/node_modules 排除规则。

只扫描 Markdown，不跟随符号链接。include 省略表示全部 Markdown，空数组不匹配任何文件。exclude 省略时排除隐藏项和 node_modules；显式填写（含空数组）会替代默认排除规则。默认文件上限 10 MiB，可配置到 1 GiB；包含补写 UUID 后的 UTF-8 字节。

默认 hybrid 需要配置 embedding；无 key 时将 retrieval/balanced.json 的 mode 改成 bm25。执行：

```sh
echo-mcp config list
echo-mcp config show
echo-mcp sync
echo-mcp search --query "需要查找的问题"
echo-mcp status --check-sources
```

不在主入口目录执行时，每条命令加 `--config <主入口绝对路径>`。
sync 会给缺少 echo_id 的笔记补写 UUID v4，API 模式会发送正文以生成向量。数据库事务失败保留旧索引，但已经写入笔记的 UUID 不回滚。修改、移动或删除笔记后需再次 sync；status 检查只读、不同步、不计费。

## 切换与生效

```sh
echo-mcp config use --chunker markdown-structure-v1 --tokenizer icu-zh --embedding default --retrieval balanced
```

配置 ID 与对应文件名一致，使用小写字母开头，后续可含小写字母、数字、连字符，最长64字符。四类选择可一次切换；先校验后原子更新主入口。MCP 下一请求生效，在途请求保留原快照；切换不自动建索引，缺失或过期时显式 sync。数据库路径及 runtime 改动需要重启。

runtime 默认 search_timeout_ms=120000、max_concurrent_searches=2、sqlite_busy_timeout_ms=5000。模型超时在 embedding 中设置。
logging 默认 level=warn、file=.echo/logs/echo.jsonl、max_file_bytes=1048576、retain=3；级别支持 off/error/warn/info/debug。日志记录事件、计数和耗时，不记录问题、正文或密钥。

生成的说明反映安装版本，重复 init 不覆盖配置或说明。不要把数据库、日志、密钥提交到 Git。
