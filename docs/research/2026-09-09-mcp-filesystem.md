# 官方 MCP Filesystem：补读接口研究

访问日期：2026-09-09。对象：[官方仓库](https://github.com/modelcontextprotocol/servers/tree/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem)中的 `src/filesystem`，提交 `d73f99efbfd40c3aa1b61e88728b3d49fb52608f`。本地参考：`references/mcp-servers`，浅克隆、稀疏检出该模块。证据来自 README、工具注册、实现及测试源码；未安装依赖、启动服务或运行测试。

## 结论与适用边界

这是通用文件操作 MCP，可借鉴工具说明、批读和目录边界；它不是 Markdown 检索器，也没有“命中片段→任意范围补读”的完整接口。Echo 不宜直接照搬其读取契约。

## Agent 实际能做什么

| 能力 | 本次版本的实际行为 |
| --- | --- |
| 定位文件 | `search_files(path, pattern, excludePatterns)` 按相对路径做 glob 匹配，返回完整路径；不搜索正文、没有相关性排序 |
| 单文件读取 | `read_text_file(path, head?, tail?)` 读取全文、前 N 行或后 N 行；没有起始行、任意行区间或字节偏移 |
| 输出定位 | 输出是字符串，`structuredContent` 也只含字符串 `content`；不附行号、章节范围、稳定文档 ID 或来源版本 |
| 多文件读取 | `read_multiple_files(paths)` 并发读取全文，按路径拼接；单文件失败成为对应错误文本，其余结果继续返回 |

证据：[单读注册与处理器，index.ts:191–247](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/index.ts#L191-L247)、[批读，index.ts:319–355](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/index.ts#L319-L355)、[路径搜索，lib.ts:442–482](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/lib.ts#L442-L482)。

若 Agent 想补全第 86–98 行的片段，这个模块只能让它读更大的头部、尾部或全文，再自行寻找位置；没有父章节、邻接片段和可直接复用的 `read_more` 参数。

## 指示、预算与一致性

工具说明明确单读和批读的适用场景、`head/tail` 用法及允许目录，并声明 `readOnlyHint`。这种说明放在工具契约里的方式值得采用，不必把操作说明写进每篇笔记。

但 `structuredContent` 的存在并不意味着结果已经适合程序继续调用：该实现把批读成功和失败拼成一段文本，Agent 仍要自行拆解。Echo 可返回逐项结果，让每项来源、范围、错误及补读参数都有明确字段。

不过，读取接口没有字节／token 上限、截断标识、继续读取游标；批读只规定至少一个路径，没有总量预算。实现中的 1 KB 缓冲区用于分批读磁盘，不是输出预算。`head/tail` 参数也未限定正整数上限。Echo 应自行设计预算及实际返回范围，不能把“支持前几行”当作预算已经解决。[读取实现，lib.ts:363–440](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/lib.ts#L363-L440)

读取按调用时的当前路径取文件，没有预期版本参数，也不返回版本。独立的 `get_file_info` 可读取修改时间，但不与正文读取形成一致性约束；不能由此声称旧搜索定位仍然有效。[文件信息与全文读取，lib.ts:188–203](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/lib.ts#L188-L203)

## 原文与路径细节

README 指定 UTF-8；工具说明却泛称支持多种编码，实际普通读取默认 UTF-8。头读使用流式解码器，尾读拼接字节后解码；尾读还把 CRLF 规范成 LF。它没有 Markdown 解析和原始位置映射，Echo 的行号与元数据过滤规则仍需自定。[README:71–78](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/README.md#L71-L78)

路径校验同时检查请求路径与 `realpath` 是否位于允许目录，拒绝 POSIX 主机误用 Windows 盘符路径；Roots 使用 `fileURLToPath` 解码并确认目录存在。有效 Roots 可替换允许目录，但当前实现收到零个有效 Roots 时只记录日志、保留旧配置。Echo 应借鉴规范化与真实路径检查，明确自己的根目录策略。[路径校验，lib.ts:140–183](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/lib.ts#L140-L183)、[Roots 解析](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/roots-utils.ts#L13-L74)、[Roots 更新](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/index.ts#L724-L734)。

## 测试证据及 Echo 建议

静态阅读确认头／尾读取有中文字符跨缓冲区边界的结果断言；部分名称描述“返回首尾行”的测试实际只断言句柄关闭，不能据测试名扩大保证。[尾读测试](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/__tests__/lib.test.ts#L743-L779)、[头读测试](https://github.com/modelcontextprotocol/servers/blob/d73f99efbfd40c3aa1b61e88728b3d49fb52608f/src/filesystem/__tests__/lib.test.ts#L818-L849)。本次没有运行这些测试。

Echo 最小借鉴范围：清晰的只读工具说明、部分失败可用的批读、路径规范化、UTF-8 边界测试。另行补齐 `echo_id + source_version + start_line/end_line`、实际返回范围、截断状态及下一段入口；父章节补读可复用范围读取，不必再引入通用文件写入工具。以上为研究建议，不是已确认接口或效果验证。
