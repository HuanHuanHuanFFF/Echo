# 召回配置

每份 JSON 的 id 与文件名一致，通过 `echo-mcp config use --retrieval <ID>` 选择。新工作区仅提供 balanced；可复制为新 ID 保存其他组合。优先级：内置默认 → 当前 JSON → 单次 overrides；省略字段保留当前配置，不自动重置。召回参数不参与索引表身份，但切换到需要向量的模式时可能需要先 sync。

下表由安装版本的实际配置 schema 生成，不代表用户当前修改后的配置；用 `echo-mcp config show` 查看生效值。

<!-- RETRIEVAL_PARAMETERS -->

两路权重合并后不能同时为0；权重不是占比或概率。MiniSearch 参数只影响 minisearch，SQLite FTS5 的 k1/b 固定。候选量是每个问题表达式融合前的数量，不是最终返回量。纯 bm25/dense 模式仅使用相应一路。

topk、max_chunks_per_source 和 max_context_chars 对所有子问题共同生效。max_results 是配置专属的返回块数上限，默认 20（1–100）；topk 默认 10，超过上限时报错，不凑满数量。max_results 小于 10 时也需调小配置 topk。

预算为完整业务 JSON 的 UTF-16 长度，含元数据和转义，不是 token，不含请求、MCP 外层或补读。先固定选中的块，保留全部定位，剩余正文空间均分并回收短块余量；超限从头按字符裁剪，不丢块，完整正文放得下时不裁剪。元数据也放不下时报 CONTEXT_BUDGET，应增大预算或降低 topk。100000 是字符预算参数校验上限，没有独立配置字符硬上限。

start_line/end_line 定位完整块，不保证 text 覆盖全部范围。检查 text_truncated 和 preview_range；预览位置为 1-based 行/UTF-16 列，终点不包含，空预览起终点相同。截断时用宿主工具补读完整范围，注意预览外的否定句或版本限定。文件已变动时核对 source_version、显式 sync/重新检索。Echo 不自动补读或判断充分性。

MCP 单次覆盖示例：

```json
{
  "query": "事务失败后如何恢复",
  "overrides": { "topk": 6, "max_chunks_per_source": 2 }
}
```

只修改显式字段，其他参数继续使用当前配置。除 max_results 外的表中字段可单次覆盖；常规查询无需 overrides。diagnostics=true 增加配置、候选与排名，仍计入相同预算。先看 returned/empty_reason、limits 和 text_truncated；limits 中 budget 表示预览裁剪，元数据放不下会报错。当前没有翻页游标。
