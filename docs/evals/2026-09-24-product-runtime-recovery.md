# 三产品对照的运行恢复与模型批处理

日期：2026-09-24。状态：**运行故障已恢复，语料索引继续进行；尚无三产品全量效果结论。**

本记录仅覆盖[产品对照协议](2026-09-22-product-comparison-protocol.md)的运行基础，不修改 Echo 默认、评测题目、原文或检索参数。

## 修复与依据

- Docker Desktop 的本地运行目录残留不可访问的 socket。确认引擎停止后，将仅含 socket 的目录改名保留并重建空目录；没有重置 Docker 或删除镜像盘。恢复后 Server 29.0.1 正常响应。
- 实验将 Dify 数据库连接池缩小到5+5，导致原生文档导入失败。恢复固定 Dify 1.17.1 源码默认的30+10；对已知失败的原文档执行原生 retry。
- Celery 不接受日志级别 WARN，使用 WARNING 后 worker 实际开始消费索引任务。以上配置由[隔离环境生成器](../../evals/prepare-dify-comparison.mjs)负责。
- [模型网关](../../evals/product-embedding-gateway.mjs)将并发的单文本请求合并为既定的每批最多8条。新增[请求队列](../../evals/lib/product-embedding-queue.mjs)负责按输入去重、保持各调用者顺序、串行提交上游批次及隔离失败。模型、输入文本、向量规范化与既有缓存键均未改变。

网关的响应 token=0 是本地兼容字段，真实用量仍以原始API回执为准。批处理修复不作为检索质量提升证据。

## 验证

- 队列及向量缓存的6项隔离回归通过：[队列测试](../../tests/product-embedding-queue.test.ts)、[缓存测试](../../tests/product-vector-cache.test.ts)。
- 7条自造文本并发请求实际合为1次上游API调用，均返回1024维；回执保存在E盘实验目录的 embedding-gateway/cross-request-batch-probe-20260924.json。
- 原始失败回执、修复前配置及实际运行配置保留在E盘；个人正文、凭据、向量库不进入Git。

原生索引适配、证据定位、逐库审计与官方评分属于后续交付。当前提交不代表3507题比较已完成，也不据此创建或合并PR。
