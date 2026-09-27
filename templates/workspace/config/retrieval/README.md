# 召回配置

每份 JSON 的 id 与文件名一致，通过 `echo-mcp config use --retrieval <ID>` 选择。新工作区仅提供 balanced；可复制为新 ID 保存其他组合。优先级：内置默认 → 当前 JSON → 单次 overrides；省略字段保留当前配置，不自动重置。召回参数不参与索引表身份，但切换到需要向量的模式时可能需要先 sync。

下表由安装版本的实际配置 schema 生成，不代表用户当前修改后的配置；用 `echo-mcp config show` 查看生效值。

<!-- RETRIEVAL_PARAMETERS -->

两路权重合并后不能同时为0；权重不是占比或概率。MiniSearch 参数只影响 minisearch，SQLite FTS5 的 k1/b 固定。候选量是每个问题表达式融合前的数量，不是最终返回量。纯 bm25/dense 模式仅使用相应一路。

topk、max_chunks_per_source 和 max_context_chars 对一次请求中的所有子问题共同生效。预算为完整业务响应 JSON 的 UTF-16 长度，包括元数据；不是 token 数，不含请求与 MCP 外层包装。片段整体装入，不截断正文，不足时返回实际数量。100000 是参数校验上限，目前没有另一项管理员可配置硬上限。

MCP 单次覆盖示例：

```json
{
  "query": "事务失败后如何恢复",
  "overrides": { "topk": 6, "max_chunks_per_source": 2 }
}
```

只修改显式字段，其他参数继续使用当前配置。所有表中字段均可单次覆盖；常规查询无需传 overrides。diagnostics=true 会附加实际配置、候选与排名，诊断元数据也计入相同预算。先看每个子问题 returned/empty_reason 和整体 limits，再决定是否调整数量、预算或问题表达。当前没有翻页游标。
