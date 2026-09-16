# PR #3 / #4 的 P2 修复

日期：2026-09-16。状态：代码与回归已实施，最终验收以本修复 PR 当前提交的 Windows/Linux CI 为准。

本次只修复已确认的三条审查问题，不实施待集中调整的配置/策略分离，也不改变第五阶段真实模型验收缺口。基线为已合入阶段 4 的 main（ae4f7cc）。

## 问题、职责与修复

| 原反馈                                                                                        | 修复与模块职责                                                                                                                                                                                             | 行为依据                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [示例数据库越出项目](https://github.com/HuanHuanHuanFFF/Echo/pull/3#discussion_r4017128848)   | [配置示例](../../examples/echo.config.example.json)使用 .echo/index.sqlite，供复制到项目根目录；[loadConfig](../../src/config.ts)继续按配置文件目录解析路径。直接在 examples/ 运行的其他示例保持各自路径。 | [foundation.test.ts](../../tests/foundation.test.ts)复制同一示例到两个同级目录，依次同步，再从各自配置检索原文，验证数据库和来源不会相互覆盖。                                                      |
| [UUID 写回改变权限](https://github.com/HuanHuanHuanFFF/Echo/pull/3#discussion_r4017128840)    | [identity.ts](../../src/identity.ts)在 POSIX 临时文件写完后、替换原文件前显式恢复原 mode 权限位；失败仍清理临时文件并保留原文件。Windows 保持现有路径。                                                    | [import.test.ts](../../tests/import.test.ts)用独立子进程设置 umask=0077，覆盖原 mode 0666/0640/0600；验证 UUID 首次写入及重复导入后的权限、原文和身份。Windows 跳过 POSIX 专项，Linux CI 实际执行。 |
| [缩写开头的标识符漏词](https://github.com/HuanHuanHuanFFF/Echo/pull/4#discussion_r4017095061) | [lexical.ts](../../src/lexical.ts)先拆 HTTP+Server 等缩写/单词边界，再做既有小写/数字与大写边界拆分；保留完整标识符。算法指纹升级为 identifiers-2。                                                        | [retrieval.test.ts](../../tests/retrieval.test.ts)实际同步并检索 HTTPServer、URLParser、parseHTTPResponse 的全名和组成词；旧版本索引必须提示 sync，原文未变也会重建，重复 sync 恢复 unchanged。     |

Linux 新建文件的 mode 会受 umask 影响，不能仅依靠 writeFile 的 mode 选项；依据 [Linux open(2)](https://man7.org/linux/man-pages/man2/open.2.html) 与 [Node chmod](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromiseschmodpath-mode)，核对日期 2026-09-16。本修复保证 POSIX mode 位，不新增 owner、ACL、扩展属性或硬链接保留承诺。

## 升级与边界

- 已复制旧配置的用户须自行将 database 改为项目内 .echo/index.sqlite，再显式 sync；修改仓库示例不会重写现有配置。不会自动删除或迁移父目录中的旧数据库。
- 分词版本改变后，旧索引查询明确要求 sync。继续使用原配置执行同步即可；数据库 schema 不变，原 Markdown 的 UUID 不变。
- 当前同步指纹仍组合切块、分词与 embedding。此次升级若使用 hybrid/dense 配置同步，会重新生成向量并调用配置的 embedding API；本修复不把尚未实现的“只更新 FTS”描述成现有能力，也不以切到 bm25 同步规避，因为后者会清除已有向量。
- 原规则会丢失已设置但受 umask 屏蔽的权限；本修复不能推断并恢复此前已经丢失的权限。
- 使用自编样本、临时数据库；普通回归不需要个人笔记或模型 key，不是语义检索效果评测。

## 验证

示例隔离、缩写召回和旧索引识别三条新增回归均在修复前实际失败、修复后通过。权限专项需在 Linux 执行，Windows 的通过结果不代替该证据。

本地 Windows 的 npm run check 通过：格式、类型、52 项测试通过、1 项 POSIX 专项跳过、构建通过；本次 3 份文档的 33 个本地引用及 git diff --check 通过。Linux 专项尚待远程 CI。

首次完整检查曾在未修改的 MCP HTTP 回归出现 fetch bad port，随后定向复跑及完整检查通过。只读核查本机动态端口范围为 1024–15000，包含 fetch 禁用端口，固定端口 6000 可复现相同错误；原失败未记录具体端口，故仅将随机分配撞上禁用端口列为可能原因。本次没有修改或跳过该测试。

两位独立只读审查者复核代码 d102e7b 及本次文档，均未发现三项范围内阻断缺陷；各自复跑相关测试为 43 通过、1 项 Windows 跳过。一位另用隔离样本验证 hybrid 升级中 embedding 失败保留原索引/元数据/原文，重试同步成功。两者均将 Linux 权限实测列为最终 CI 门槛。远程 CI 以修复 PR 的当前提交为准。历史阶段验收与评测快照保持原日期和原提交，不重写为本次结果。
