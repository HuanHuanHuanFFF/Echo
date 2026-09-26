# 配置目录、策略与索引契约（v2）

2026-09-26更新：[最终默认与精简初始化](../project/2026-09-26-final-default-profile.md)采用新综合、balanced、每篇6；新初始化不再附带 heading-1000/500 和纯 BM25 配置文件，自定义与旧配置兼容保留。

2026-09-21更新：[MiniSearch默认采用](../project/2026-09-21-minisearch-default.md)已获用户确认，取消匹配词乘数，新增可配置k/b/d；只替代词法引擎默认范围。同日预算修订将完整响应JSON默认上调至20000，已有显式值优先；其余已确认参数保持。

日期：2026-09-16。状态：实现与隔离回归已具备，最终验证见[修订开发记录](../development/2026-09-16-configuration-revision.md)。本文落实[用户确认决定](../project/2026-09-16-configuration-decisions.md)，替代[旧配置契约](configuration.md)的配置组织与索引选择部分；证据定位、RRF、数量和预算规则延续。

2026-09-20：[默认冻结记录](../project/2026-09-20-default-freeze.md)确认新综合＋BM25 0.5＋RRF10，替代旧初始化heading/RRF30默认。新init完整保存召回参数并安装新综合，重复init保留已有文件；不批量改写旧安装或冻结评测。

## 初始化与选择

先构建，再在自己的工作目录执行：

```sh
node /absolute/path/to/echo/dist/cli.js init
node /absolute/path/to/echo/dist/cli.js config list
node /absolute/path/to/echo/dist/cli.js config show
node /absolute/path/to/echo/dist/cli.js config use --retrieval balanced
node /absolute/path/to/echo/dist/cli.js sync
```

所有命令都支持 --config /absolute/path/echo.config.json。仓库中可直接运行的无 key 样本是 [examples/profiles/example.json](../../examples/profiles/example.json)。init 保留已有文件，不调用模型、不导入笔记；无 key 时可将 balanced 的 mode 设为 bm25，或自行新建并选择纯词法配置；填好 sources 和需要的 embedding 设置后再显式 sync。

```text
echo.config.json
chunkers/markdown-structure-v1.mjs
tokenizers/icu-zh.mjs
config/embedding/default.json
config/retrieval/balanced.json
config/sources.json
config/runtime.json
config/logging.json
```

主入口示例：

```json
{
  "version": 2,
  "database": ".echo/index.sqlite",
  "active": {
    "chunker": "markdown-structure-v1",
    "tokenizer": "icu-zh",
    "embedding": "default",
    "retrieval": "balanced"
  }
}
```

directories 可分别覆盖 chunkers/tokenizers/embedding/retrieval 的目录；sources/runtime/logging 可覆盖对应文件位置。所有配置位置、笔记根目录、数据库和日志路径统一相对主入口目录解析。配置 ID 使用小写字母开头及小写字母、数字、连字符，最长 64 字符；API 的实际 model 名不受配置 ID 命名规则限制。

config use 可以同时选择多个 ID。全部解析通过才原子替换主入口；失败保留旧选择。它不构建索引、不调用模型，结果同时显示选择与索引 readiness。正常运行的 MCP 从下一请求加载新组合；在途请求保留原快照。修改数据库路径或运行参数需重启，返回 RESTART_REQUIRED，不混用进程设置。

手动修改多个文件时，应写好策略/资源及配置，再切换主入口；加载时复读校验所读文件。若读取期间变化或文件无效，则本次请求明确失败，不半加载或暗中回退。并发配置命令使用主入口旁的 .lock；进程异常退出留下锁时，应确认原配置命令已退出后删除该锁再重试。

## 固定切块与分词接口

每份 .mjs 的默认导出 id 必须与文件名一致，并提供 version。复制策略并修改数字时，同时更换 ID/文件名；v2 不接受 chunker.options 或外部切块参数覆盖。同 ID 文件被修改也会改变指纹，不会直接混用旧索引。

策略是可信的本地程序，使用自包含 ESM；可使用 Node 内置模块。相对/第三方 import 不自动打包：需要将逻辑内联到策略，或把数据声明为 resources。声明资源按策略文件目录解析并按内容捕获；算法读取 context.resources，不在执行期间另读可变资源。代码、version、资源及内置 helper 实现/ICU 参与指纹。源码开发运行和构建产物的 helper 字节不同可能生成不同指纹；同一索引应使用同一种运行入口，升级运行代码后按提示同步。

切块模块完整替换规则：

```js
export default {
  id: 'heading-500',
  version: '1',
  chunk(input) {
    return input.headingLines(500);
  },
};
```

input 提供 sourceId、path、带完整原文件行号的 lines，以及只读 resources。headingLines(maxChars) 是兼容标题切块 helper；也可完全自行返回 startLine/endLine/headingPath 和成对的 sectionStartLine/sectionEndLine。行号 1-based、两端包含；范围必须是未过滤的连续原文。Echo 从捕获的原文生成证据，不接受插件自造正文。原 frontmatter 整体不进入切块。

新默认markdown-structure-v1@1.0.1的规则以[冻结记录](../project/2026-09-20-default-freeze.md)为准。仓库 examples 中的 heading-1000与heading-500（不再由 init 自动安装）分别固定 1000/500 字符软上限，ATX 标题、整行聚合、不重叠，围栏代码中的伪标题不分章节；超长单行允许超过软上限，表格/代码块可按行分段。

分词模块返回原始词项字符串，Echo 统一 NFKC、小写和十六进制编码后持久化到SQLite词项表，供MiniSearch或显式SQLite引擎复用：

```js
export default {
  id: 'domain-words',
  version: '1',
  resources: { dictionary: 'words.json' },
  tokenize(text, context) {
    return context.icu(text, {
      locale: 'zh-CN',
      dictionary: JSON.parse(context.resources.dictionary),
    });
  },
};
```

也可完全自定义 tokenize。context.icu 使用当前本地 ICU 词分割、汉字双字词、技术标识符全名/组成词和既有停用词规则。索引与查询使用同一份快照。原文与 embedding 输入不经过词项编码。单次策略输出须是最多 100000 个字符串，每词最多 10000 字符；空词项丢弃。

## 模型与召回文件

模型 JSON 必须包含与文件名一致的 id。其他字段均属于该 embedding 调用配置：

| 字段                           | 行为                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| provider                       | http                                                         |
| base_url / model / dimensions  | 实际服务、模型、维度；init 模板需由用户补齐                  |
| api_key_env                    | key 的环境变量名，默认 ECHO_EMBEDDING_API_KEY；不保存 key 值 |
| timeout_ms / batch_size        | 默认 30000 / 8                                               |
| document_prefix / query_prefix | 默认空字符串                                                 |
| send_dimensions                | 默认 true，不支持该字段的服务可设 false                      |

不自动重试计费请求。API key、超时和 batch_size 不影响向量身份；服务端点、模型、维度、前缀、维度字段和向量变换规则影响身份。空模板可以保存，实际 dense/hybrid 同步必须配置模型；已有向量完整时，同步不因 key 缺失而重新请求模型。

召回 JSON 也包含 id，支持多套配置。字段/范围沿用 [retrievalSchema](../../src/config.ts)：mode、lexical_engine、minisearch_k/b/d、topk、max_chunks_per_source、两路 candidates、rrf_k、title_weight、两路 weight、min_dense_similarity、max_context_chars。优先级：内置默认 → 选中的召回配置 → 单次 overrides。默认 hybrid、topk=10、每篇上限=3、候选=60/60、RRF k=10、BM25/向量权重=0.5/1、标题权重=2、最低余弦=0.3、完整 JSON 预算=20000 字符。topk 和单篇上限同时约束，不凑满数量。召回配置不参与表身份。

2026-09-18 用户确认：RRF k改为30，完整返回JSON预算改为16000；支持单次overrides。省略字段时继承新默认，已有显式值继续优先；旧冻结评测不回写，当前新综合联合验证见[联合对照](../evals/2026-09-18-rrf-budget-joint.md)。这替代此前仅把30/16000列为候选、默认仍60/12000的状态，仅涉及这两项。

2026-09-17 用户确认：topk 8→10、每篇上限 2→3、BM25 权重 1→0.5，替代本节与旧格式契约中的这三项默认值。实现归属 [retrievalSchema](../../src/config.ts)；初始化未指定字段时继承它，样例配置同步更新，单次 overrides 继续优先。已有显式配置、E盘冻结评测安装与历史报告不自动修改。这是默认行为调整，该组合的真实效果尚未验收。

验证（2026-09-17）：npm run check 通过格式、类型、110项隔离测试（1项原有跳过）和构建；既有 [配置覆盖测试](../../tests/foundation.test.ts)、[MCP运行测试](../../tests/profile-runtime.test.ts)通过。直接检查构建产物确认10/3/0.5默认值、单次覆盖、已有显式配置优先级及三份使用样例。未运行真实模型评测。

[PR #16的原始说明草稿](../development/2026-09-17-pr16-default-limits-description.md)保留该次默认值调整的实现、验证与当时的评测边界；其“尚未完成真实模型效果评测”仅描述2026-09-17的状态，不覆盖后续评测。

## 扫描、运行与日志

sources JSON 形如：

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

只扫描 Markdown 和真实目录/文件，不跟随符号链接。include 未指定表示全部 Markdown；指定空数组表示无匹配。glob 使用 Node path.matchesGlob，路径统一为 /。exclude 未指定时沿用隐藏项/node_modules 默认排除；显式提供 exclude（包括空数组）后以其规则为准。max_file_bytes 包含补写 UUID 后的完整 UTF-8 文件；超过上限在写入前令本次同步失败，保留旧索引；被过滤的笔记不会补写 UUID，成功同步会从所选索引移除其旧记录并使不兼容组合失效。

runtime 文件包含 search_timeout_ms=120000、max_concurrent_searches=2、sqlite_busy_timeout_ms=5000。模型自己的请求超时与批量参数仍放在 embedding 文件。

logging 文件包含 level（off/error/warn/info/debug）、可选 file、max_file_bytes（默认 1 MiB）、retain（默认 3 个轮转文件）。日志只记录事件、计数和耗时，不记录 query、正文、API key 或请求体。MCP stdout 仅输出协议。日志写入失败不使已完成查询失败；检查日志目录权限以排查日志缺失。

## 索引与同步

[profile-store.ts](../../src/profile-store.ts)登记完整身份并校验安全表名；[profile-sync.ts](../../src/profile-sync.ts)统一事务发布：

| 数据           | 身份                                    | 复用                     |
| -------------- | --------------------------------------- | ------------------------ |
| sources/chunks | chunk ID、规则指纹                      | 模型/分词/召回变化不重切 |
| FTS            | chunk 身份、tokenizer ID/指纹           | 换模型不重建词项         |
| vectors        | chunk 身份、embedding ID、维度/模型指纹 | 换分词不调用 embedding   |

表名可读部分含相应 ID，并附完整哈希；登记表保存完整身份，碰撞/不一致会报错。不同组合的数据保留，sync 只填所选组合的缺失数据。共享 chunk 变动时，依赖的旧 FTS/向量持续失效，直到各自显式同步完成；仅恢复相同内容哈希不能让缺行索引重新可用。内容/路径/范围变化成功同步后，其他组合以其来源快照识别为失效；查询明确要求同步，不把新路径配旧片段。失败回滚索引、状态和新建索引表；已补写的 UUID 仍按既有规则保留供重试。

## 旧配置与数据

旧格式继续用于兼容已有脚本和历史评测。执行 config migrate 会备份原配置，将内置数字参数或可自包含的自定义模块参数固化到新策略文件，并拆分其他配置。已有文件不会被覆盖；不支持的模块 import 在替换主入口前报错，需先整理成自包含模块。迁移只写配置，随后显式 sync。

已验证等价的旧内置切块及未变来源可复制到新表；匹配模型指纹的向量一起复用，不重新调用 API。其他情况显式同步重建。旧表保留，迁移后旧格式不再查询/写入同一数据库，防止两套同步状态混用；回退旧程序应使用迁移前数据库副本。config migrate 不自动复制数据库，用户在实际迁移前可自行备份数据库。

## Agent 调用

就绪时直接调用 echo_search({query})，不要求先列配置或 status。selection 给出本请求四类 ID、配置 revision 和来源快照；返回原文、路径、行号、来源版本和子问题归属，补读仍由宿主文件工具完成。

code/next 区分 CONFIG_RELOAD、RESTART_REQUIRED、SOURCE_LIMIT、INDEX_REQUIRED、INDEX_STALE、MODEL_CONFIG、MODEL_KEY_MISSING、MODEL_UNAVAILABLE、BUSY、TIMEOUT、CANCELLED 和 CONTEXT_BUDGET。正常无命中是 queries 中的 empty；模型部分失败保留仍可用证据。echo_status 展示活动组合、ready、原因与上次同步，不进行付费健康检查。

真实模型效果仍需用户提供 API 配置和调用额度；本轮确定性模型回归只证明配置、复用和调用流程。

## 实现依据

Node 24.15 已提供稳定的 [path.matchesGlob](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern)。策略快照使用 [data URL ESM](https://nodejs.org/download/release/latest-v24.x/docs/api/esm.html#data-imports)，避免在途请求重新解析已变更的入口文件；它不支持相对 import，因此策略须自包含（有第三方依赖时可预先打包成单文件），数据通过声明资源传入。数据库使用 [SQLite 显式表约束](https://sqlite.org/lang_createtable.html)和现有事务边界。以上资料核对日期 2026-09-16，实际跨平台行为以本轮 CI 为准。
