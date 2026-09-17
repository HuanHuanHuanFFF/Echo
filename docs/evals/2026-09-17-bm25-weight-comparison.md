# 新综合＋固定拆分＋每篇3：BM25权重0.5与0.25

日期：2026-09-17。状态：两组检索运行完成，独立复核进行中。
依据用户“同意先保留3，测一下别的”，仅比较BM25权重；承接[每篇3/4对照](2026-09-17-source-limit-comparison.md)。产品默认仍每篇3、BM25权重0.5。

## 固定条件

同一冻结开发100题（95可答+5无答案），33父题/68固定子问题保留。两组各执行100题，唯一变量bm25_weight=0.5/0.25。

| 项目         | 两组共同值                                                      |
| ------------ | --------------------------------------------------------------- |
| chunk        | markdown-structure-v1，原策略指纹及原索引                       |
| 语料         | A150/B22/C165篇，混合并集337篇                                  |
| 模式         | hybrid，保留固定拆分，无rerank                                  |
| 返回         | topk10，max_chunks_per_source=3                                 |
| 权重         | dense_weight=1，title_weight=2                                  |
| 候选与融合   | BM25 60 / dense 60，RRF k60，min_dense_similarity0.3            |
| 预算         | 每父题请求+完整业务JSON≤12000 UTF-16字符                        |
| 模型         | qwen3.7-text-embedding，1024维，原DashScope兼容API的真实响应    |
| 模型调用配置 | batch8、timeout30000ms、send_dimensions=true、文档/查询前缀为空 |
| 分词         | icu-zh、zh-CN，无自定义词典                                     |
| 运行时       | E盘b454686，Node/ICU、原文与代码哈希冻结                        |

## 真实向量重放

复用上一轮135份真实响应，来源为E盘structure-source-limit-2026-09-17-v1，交付清单SHA为747c30c2dd6b8a6773007427a4222869a7bb3a6423d74ae732615246cbb78910。
先验证文件SHA、query key、模型、1024维向量与vector SHA，再导入不可变快照。查询不在当前run白名单或缓存缺失时立即失败，不允许联网补齐；本轮网络请求和字符上限均为0。
这是重新执行SQLite检索、RRF和结果拼装，复用的是实际模型向量，不是旧检索答案或模拟向量。

两组270次逻辑查询均应使用已冻结响应；新API请求/输入/token均为0。原响应中历史服务用量保留为来源证据，不能重复计入本轮费用。
纯重放不需要真实key；旧运行时的非空key检查使用进程内占位值，fetch被离线策略阻断，不写用户凭据、不外发占位值。

本轮初步统计：权重0.5完整89/95、0.25完整87/95，事实数均217/226；新增API为0。完整本地检查137项通过、1项原有跳过，格式/类型/构建通过；详细分库和逐题结论随结果复核补齐。

## 执行与验收

复用[实验驱动](../../evals/run-source-limit-comparison.mjs)，增加显式 --experiment bm25-weight；默认入口仍为上轮source-limit。
[响应复用模块](../../evals/lib/frozen-query-fetch.mjs)新增有指纹的seed与offlineOnly，不改检索产品实现。
新增隔离回归验证只改BM25且每篇保持3、损坏seed拒绝、缓存不可变、缺失时零联网。既有来源配额对照回归保留。

```powershell
node evals/run-source-limit-comparison.mjs --experiment bm25-weight --lab "E:/幻/Documents/八股-Echo测试/2026-09-16" --run-id <新的run-id> --phase prepare
node evals/run-source-limit-comparison.mjs --experiment bm25-weight --lab "E:/幻/Documents/八股-Echo测试/2026-09-16" --run-id <新的run-id> --phase run
node evals/run-source-limit-comparison.mjs --experiment bm25-weight --lab "E:/幻/Documents/八股-Echo测试/2026-09-16" --run-id <新的run-id> --phase summarize
```

原始题目、响应、向量和索引仅保留E盘；公开指标/逐题得失ID/指纹进入Git。
继续单变量与commit/push节奏，不创建PR、不合并、不自动改默认、不运行最终200题。
