# 全量公开评测执行冻结

日期：2026-09-19。状态：用户已授权全量执行；本文保留执行前冻结条件，下方追加数据与运行修正；完整结果另报。接续[选集记录](../project/2026-09-19-default-validation-and-deferred-ideas.md)，替代其建议/小样本优先的执行状态；不改变产品默认。

## 范围

- QASPER v0.3 dev：281论文、1005问题，三版P0 heading/RRF30、P1结构/RRF30、P2结构/RRF10。
- FreshStack oct-2024：LangChain 203题/49514条，Godot 99题/25482条，固定官方检索单元，两档RRF30/10。
- C-MTEB DuRetrieval dev：2000题/100001条，固定官方检索单元，两档RRF30/10。
- 共3307父问题、最多7619次检索条件执行；不是独立新问题数或真实API次数。不新增MMR/rerank、额外基线、Agent生成/多轮问题改写。官方问题直搜，不用答案或nugget改写输入；固定子问题对照留单独批次，避免让本轮算法与输入同时变化。
- 官方检索分数与产品预算结果分开，不合并三个数据集的总体准确率。现有个人100/200题、标签、索引不动，不计入本轮。

## 固定配置

qwen3.7-text-embedding / 1024维；原DashScope兼容endpoint、空查询/文档前缀、batch8、请求超时30秒。分词保持ICU zh-CN；hybrid权重0.5/1、候选60/60、标题权重2、最低余弦0.3。除两档RRF与QASPER切块外不变。

QASPER：完整论文生成结构化Markdown，使用生产切块、索引/检索和打包规则，topk10/单篇3/16000 UTF-16字符JSON预算。原任务给定目标论文，只在该论文检索；因此单篇3是实际约束，不冒称全库检索或top10均可返回。正文原段落不任意硬换行，保留可复核的原段落到Markdown范围映射。

FreshStack/Du：原始检索单元不重新切块，调用Echo生产候选检索/RRF；官方排名指标从候选排序取指定K，不施加产品正文预算或按原文件聚合的每篇3上限。另按产品限制打包可作为成本诊断，但不能与官方排名混算。这是检索层适配，不是Markdown导入/定位端到端验收。

公开语料embedding正文保留完整输入；qwen3.7官方说明支持长输入。FreshStack历史榜单使用2048token最大输入，故本轮长输入Qwen系统与历史榜单只作配置披露后的参考，不声称严格同输入对榜或架构独立胜出。出现API长度错误先查证，不静默截断、跳过或替换模型。

## 评分前的数据规则

QASPER每个标注者的一组证据独立看待，不能将多个标注者的证据并成必须全部覆盖。原文匹配只进行空白规范化，多个相同段落保留替代范围；不根据检索结果选匹配规则。

- 至少存在一个非空、纯文本、全部可映射的可答证据组：进入纯文本证据主评测，按预定多标注者最佳完整组规则计分。
- 所有标注者无答案：单列无答案诊断，仍运行查询，不混入召回分母。
- 只有图表、空证据或无法完整映射的标注：单列不适用/标注映射缺口，仍交代全部题目去向。
- 部分标注者冲突、部分证据可映射：保留审计字段，不将部分有效证据组悄悄当成完整标注。
- 主指标为预算内原文证据覆盖/完整证据组比例；官方paragraph Evidence F1另列，不能把命中文档当证据命中，不能把检索得分当答案F1。

FreshStack用官方query-to-nugget/qrels和alpha-nDCG@10、Coverage@20、Recall@50；Du用官方qrels与nDCG@10，并补Hit/MRR/Recall。复用官方评测实现或逐样本与其核对；任何规则不兼容明确披露，不以自写同名指标冒充官方结果。

## 可复跑、费用与恢复

数据和模型返回位于E:/幻/Documents/八股-Echo测试/public-benchmarks-2026-09-19；固定下载URL/提交、SHA256、转换结果。凭据只读现有环境变量，不进入日志或Git；私有笔记不参与本轮。

所有真实embedding调用保存用途、输入指纹、尝试数、服务tokens与成功向量；相同模型/用途/输入复用真实缓存，P1/P2共用结构索引和查询向量。每次失败也记账；有限重试，无无限自动追加；按准备后的确切文本数和重试次数限制执行，用户已授权按全量测试要求调用费用。只读回放禁止网络，完成后核对索引未变。

脚本先通过隔离适配回归，运行前冻结配置与有效分母。结果全量完成后两位Luna/max独立复核；Windows/Linux必要CI保持，文档/脚本持续commit/push，不创建PR或合并，不据新测试分数直接改默认。

## 执行中的可复核修正

- QASPER实读1005题：800至少一组完整可映射纯文本证据、145不适用/映射缺口、60全标注无答。75题有可答/无答冲突，另有148题同时存在valid/invalid证据组；这些审计分类不是官方标签类别。
- 官方默认全1005 Evidence F1使用原始字符串精确匹配及原列表长度分母，annotation逐题取max；strict800允许预定空白规范化映射。另列官方text_evidence_only诊断。当前3015条响应已与固定官方evaluator逐题核对一致，无Answer F1。
- 新综合1.0.1仅修复长列表空行/overlap导致的重复范围；隔离红绿回归通过，281篇旧切块去重后的有序内容与新结果逐项相等：7407→7404，仅删3个完全重复块，真实向量输入集合不变。生产默认仍heading/RRF30；这不是一次新的切块参数实验。E盘qasper/chunk-fix-audit.json绑定版本与内容指纹。
- UUID映射固定于[公开ID映射](../../evals/fixtures/qasper-v0.3-source-ids.json)，复跑保留源ID与切块身份。
- FreshStack重复外部ID遵循官方last-row覆盖：LangChain 49514原始行/49505有效ID，Godot 25482/25477。85/302个长问题超过MCP公共schema限制，固定片段适配走生产retrieveQuery保留原问题；明确不属于MCP端到端验收。
- 公开排名同时保存RRF原分与实际rank，向官方scorer导出唯一递减rank_score，固定Echo已产生的顺序，避免不同评分库二次打破同分。官方源码固定提交：QASPER afd0fb96bf78ce8cd8157639c6f6a6995e4f9089；FreshStack f1c4ec96477f5100f10c83798d33b3101db727fa。库pyndeval0.0.6、pytrec-eval-terrier0.5.10（Python3.12），源码与依赖另存reference清单。
- QASPER向量1801次HTTP成功。FreshStack首次4并发发生459次429并保留记录；[官方错误码](https://help.aliyun.com/zh/model-studio/error-code)将insufficient_quota解释为TPS/TPM限流。经检查同一批次退避后可成功，调整为2并发、至少1秒启动间隔及按输入规模平滑、429冷却；每输入最多12次累计尝试，历史失败不重置，属于调用调度修正，不改变检索输入或参数。

## 独立复跑入口

在新的外部目录准备 Node 24.15、Python 3.12；`ROOT`表示该目录。先从仓库构建，将 `dist/`、`package.json`、`package-lock.json`复制到 `ROOT/runtime/`，在该runtime目录执行 `npm ci --omit=dev`。所有数据、向量和API回执留在ROOT，不放Git。

1. `node evals/download-public-benchmarks.mjs ROOT`；向 `ROOT/tooling` 安装 `pyarrow==25.0.1`，再运行 `python evals/convert-public-benchmarks.py ROOT`。
2. `node evals/prepare-public-benchmarks.mjs ROOT ROOT/runtime/dist`；运行 `capture-public-vectors.mjs ROOT register` 冻结用途/输入。初次只调用 `register`；已有捕获时不要重置注册计划。
3. 设置 `CHROMA_OPENAI_API_KEY` 环境变量。依次运行 `node evals/capture-public-vectors.mjs ROOT capture qasper`，再将scope依次替换为langchain、godot、du。只有这一步调用真实API；成功向量缓存持久化，恢复沿用累计尝试，不重置费用记录。
4. QASPER运行器依次执行 `configure`、`index`、`run`；固定单元运行器 `node evals/run-public-fixed.mjs ROOT SCOPE PHASE` 对每scope依次执行 `index`、`vectors`、`run`。已存在结果拒绝覆盖。离线运行器只读取缓存，缺向量直接报错。
5. `node evals/download-public-scorers.mjs ROOT` 下载固定版本官方代码。向 `ROOT/scoring-tools` 安装Python3.12依赖：pyndeval0.0.6、pytrec-eval-terrier0.5.10、numpy2.5.3、scipy1.18.1、scikit-learn1.9.1、joblib1.5.3、threadpoolctl3.6.0、narwhals2.26.0。
6. `python evals/score-public-benchmarks.py ROOT SCOPE`；QASPER另运行 `analyze-public-qasper.py`、`run-public-qasper-baselines.py`；`node evals/audit-public-vectors.mjs ROOT SCOPE`核对真实回执。所有scope完成后才运行audit的 `all`。
7. `node evals/collect-public-receipts.mjs ROOT qasper` 或验收后 `final` 生成仓库侧小型指纹清单。语料、完整题目/响应、API返回、数据库仍留外部；换目录复跑的路径与时间字段会改变，按ID、证据范围、评分及输入向量指纹复核，不要求整份结果字节一致。

实际执行的FreshStack官方模块是独立 `metrics.py`（配套pyndeval/pytrec_eval）；下载的loader/evaluation仅作协议核对资料，不宣称已运行官方完整包。QASPER无模型启发式基线按用户后续“分析并对比公开基线”授权复跑，不增加模型或修改冻结检索条件。

`embedding-plan.json`保留初次注册/输入配置快照，不能用其中旧并发、尝试上限或usage作为最终事实。实际策略按 `capture-policy-history.jsonl` 及原始attempts账本核对：恢复LangChain为2并发/至少1秒启动间隔；后续Godot沿用，Du短文本为4并发/至少200ms，均按估算输入token平滑至每秒12000并设429冷却。实际脚本按启动时SHA归档；LangChain已从6749849精确恢复，哈希与启动记录一致。模型/输入/检索参数不随调度改变。

- 2026-09-20：LangChain 203×2串行全量完成。Godot/Du允许4个只读worker并行回放，每个query/RRF条件仍独立调用同一生产retrieveQuery和真实缓存；不复用检索lane、不调整输入/候选/阈值。LangChain8题×2条件真实probe除计时外逐字段相同，绑定原串行receipt、配置、query、DB与run哈希，已两位独立复核；并行耗时含资源竞争，不冒称单请求提速。原串行运行器保留。Godot/Du完成后另用1个worker抽查8题×2档与4-worker结果一致。

## 用户暂停（2026-09-20）

用户要求尽快停止，明天再做。QASPER1005×3、LangChain203×2、Godot99×2均已完成及两位独立复核；Du已缓存12489/102001个去重输入，尚未检索2000题。已阻止新API请求、让在途响应落盘并确认捕获进程退出、inflight=0、锁释放。E盘STATE.json和PAUSE-REQUEST.json保存断点。vectors.sqlite保留user_pause_capture触发器防止误启动；仅在用户明确继续后移除再续跑，不清空缓存或重置尝试数。Godot/Du probe指纹补齐、Du全部评分和总分析仍待完成。
