# Markdown 切块：开源与商业方案调查

日期：2026-09-17。状态：Luna/max 子线程完成官方文档／源码调查，主线程核对关键默认值、Echo既有能力和采用边界。仅研究，未安装或运行第三方方案、未更改策略或索引、未调用embedding。
承接[开发语料结构统计](../evals/2026-09-17-corpus-shape.md)。以下建议未获实施确认，不替代现有固定策略或评测计划。

## 结论

最值得借鉴的是：**先识别并装入完整结构单元，单元本身超长时才回退拆分**。这直接对应Echo在课程与学习记录中切开101个代码块、其中82个自身不超过1000字符的现象；结构统计尚未证明它们就是失分原因。
开源框架和商业服务没有一个可直接照搬的“最佳大小”。组件默认、文档推荐和检索返回策略必须分开。

## 参数对照

这些值来自下文指定组件；不是整个平台所有路径共用的默认。字符与token不可直接横向比较。

| 方案／组件                                             | 尺寸默认                      | overlap默认／方式                                      | 关键边界                                              |
| ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| LangChain MarkdownHeaderTextSplitter                   | 不负责长度上限                | 不负责overlap                                          | 先按标题生成文档；可组合下一级切分器                  |
| LangChain TextSplitter／RecursiveCharacterTextSplitter | 4000字符，默认len计数         | 200字符目标                                            | 可换长度函数；具体重叠取决于可回退的分割单元          |
| LlamaIndex MarkdownNodeParser                          | 不负责长度上限                | 无                                                     | 标题分节；与SentenceSplitter是不同组件                |
| LlamaIndex SentenceSplitter                            | 1024 tokens                   | 200 tokens                                             | 优先段落和句子；不要误用通用常量中的20作为本组件默认  |
| LlamaIndex HierarchicalNodeParser                      | 2048／512／128 tokens三层     | 20 tokens                                              | 父子节点关系属于另一个流程                            |
| RAGFlow TokenChunker                                   | 512 tokens                    | 0；非零时需按具体路径核对百分比与字符截取              | 不同ingestion组件有不同超长回退；不能视为全产品硬上限 |
| Unstructured basic／by_title                           | 硬上限500字符；软上限默认相同 | 0；非零默认用于超长元素拆分，overlap_all才扩展到普通块 | 完整元素优先，单元素超长再拆                          |
| Azure Text Split字符模式                               | 5000字符，范围300–50000       | pageOverlapLength按所选字符／token单位配置             | 尽量保句子；不是Markdown结构解析器                    |
| Bedrock默认切块                                        | 约300 tokens，保句子边界      | 默认策略的具体重叠未据文档确定                         | 固定大小、层级、语义是不同策略                        |
| Google Vertex AI Search／现Agent Search布局切块        | 500 tokens，范围100–500       | 所查LayoutBasedChunkingConfig没有overlap字段           | 布局格式支持列表未列Markdown；可选祖先标题，默认false |

Azure切块指南的512 tokens＋25%重叠（也给出2000字符＋500字符起点）是**建议或示例**，不覆盖Text Split字符模式的5000默认值。
本表不将不同库对token的计数视为Qwen模型精确token数，也不把默认值当成效果基准。

## 开源方案：机制与限制

### LangChain

MarkdownHeaderTextSplitter维护标题栈，默认strip_headers=true，标题进入metadata；反引号和波浪线围栏内不解析标题。它本身没有尺寸与overlap，因此“按标题解析”和“随后按长度切分”是两个动作。
后接RecursiveCharacterTextSplitter时，重叠仅在同一输入文档内形成；先分成独立标题文档后，不会自动跨章节重叠。递归Markdown分隔符不等于完整围栏状态保护，不能保证再次切分时长代码块不被拆。
ParentDocumentRetriever则是独立检索器：child参与匹配，再取parent；不能把它算作普通Markdown splitter功能。

依据：[官方Markdown组合用法](https://docs.langchain.com/oss/python/integrations/splitters/markdown_header_metadata_splitter)、[固定版标题解析](https://github.com/langchain-ai/langchain/blob/5c1f28271295bb13034f4cf8964f74c117357d40/libs/text-splitters/langchain_text_splitters/markdown.py)、[默认4000/200与合并](https://github.com/langchain-ai/langchain/blob/5c1f28271295bb13034f4cf8964f74c117357d40/libs/text-splitters/langchain_text_splitters/base.py#L64)、[递归分隔](https://github.com/langchain-ai/langchain/blob/5c1f28271295bb13034f4cf8964f74c117357d40/libs/text-splitters/langchain_text_splitters/character.py)。

### LlamaIndex

MarkdownNodeParser维护标题section与header_path，所查源码只用反引号围栏切换代码状态；没有波浪线围栏的对应判断，也没有专门保护列表或表格的拆分层。
它会重构标题文本，不能直接将输出当作Echo原始Markdown证据。SentenceSplitter与层级解析器各有独立的长度和重叠默认；AutoMergingRetriever按命中的child情况选择parent，是另一种上下文返回方式。

依据：[固定版Markdown解析](https://github.com/run-llama/llama_index/blob/fd4a517ad6490f0c8464a13fdf133760b696434a/llama-index-core/llama_index/core/node_parser/file/markdown.py)、[SentenceSplitter的200重叠](https://github.com/run-llama/llama_index/blob/fd4a517ad6490f0c8464a13fdf133760b696434a/llama-index-core/llama_index/core/node_parser/text/sentence.py#L22)、[通用1024与20常量](https://github.com/run-llama/llama_index/blob/fd4a517ad6490f0c8464a13fdf133760b696434a/llama-index-core/llama_index/core/constants.py#L10)、[层级默认值](https://github.com/run-llama/llama_index/blob/fd4a517ad6490f0c8464a13fdf133760b696434a/llama-index-core/llama_index/core/node_parser/relational/hierarchical.py#L116)。

### RAGFlow

MarkdownElementExtractor使用围栏范围保护，识别反引号和波浪线，表格扫描避开代码里的竖线；默认路径可形成标题、代码、列表、引用和文本单元。表格提取／渲染会改变输出形式，不能直接移植到Echo原文范围模型。
TokenChunker的512/0来自指定组件，而不是RAGFlow所有解析入口。部分路径把超长输入单元单列，其他路径会继续按句子或token前缀拆分；同样不能只凭“token cap”名称断言所有结果都有同一个硬上限。非零重叠存在百分比归一化及字符尾部截取，不能当作精确token overlap。

依据：[固定版Markdown元素提取](https://github.com/infiniflow/ragflow/blob/df016eb5ea5197d86ea5f59f206c3102b0dfcecd/deepdoc/parser/markdown_parser.py#L195)、[TokenChunker默认与路径](https://github.com/infiniflow/ragflow/blob/df016eb5ea5197d86ea5f59f206c3102b0dfcecd/rag/flow/chunker/token_chunker.py#L54)、[TitleChunker](https://github.com/infiniflow/ragflow/blob/df016eb5ea5197d86ea5f59f206c3102b0dfcecd/rag/flow/chunker/title_chunker/common.py)、[组件用法](https://github.com/infiniflow/ragflow/blob/df016eb5ea5197d86ea5f59f206c3102b0dfcecd/docs/guides/agent/ingestion_pipeline/configure_chunker_component.md)。

### Unstructured

先partition成文档元素，再合并完整元素。一个元素本身超过硬上限时才单独拆分；软上限用于控制何时停止继续装入，避免只为凑长度切碎可完整容纳的元素。
by_title使用标题边界，也提供合并小section的选项，不能将其所有配置概括为永不跨section。overlap默认0，非零默认只作用于超长元素拆分；普通完整单元是否重叠由overlap_all另控。
Markdown默认经tables、fenced_code扩展转为HTML再解析。表格可单列、拆分或重复表头，原元素metadata也不等于精确原Markdown行号。Echo可以参考装箱原则，不直接使用其重建文本。

依据：[官方软硬上限、重叠与小节合并](https://docs.unstructured.io/open-source/core-functionality/chunking)、[固定版Markdown入口](https://github.com/Unstructured-IO/unstructured/blob/3376cc96a49521669f3b64028799db16ca76136f/unstructured/partition/md.py#L26)、[500字符默认与元素装箱](https://github.com/Unstructured-IO/unstructured/blob/3376cc96a49521669f3b64028799db16ca76136f/unstructured/chunking/base.py#L33)、[标题策略](https://github.com/Unstructured-IO/unstructured/blob/3376cc96a49521669f3b64028799db16ca76136f/unstructured/chunking/title.py)。

## 商业方案：公开契约能证明到哪里

### Azure AI Search

Markdown indexer、Text Split skill、Document Layout是不同入口。Markdown按标题层级生成section文档，列表／代码／表格可作为普通content；公开说明不足以证明长代码围栏绝不拆。
Text Split支持字符或特定tokenizer单位、句子边界和偏移量输出，不能据此推断它理解所有Markdown块。布局解析＋索引投影又是单独的服务流程。

依据：[Markdown indexer](https://learn.microsoft.com/en-us/azure/search/search-how-to-index-azure-blob-markdown)、[Text Split参数](https://learn.microsoft.com/en-us/azure/search/cognitive-search-skill-textsplit)、[推荐起点](https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents)、[布局流程](https://learn.microsoft.com/en-us/azure/search/search-how-to-semantic-chunking)。

### Amazon Bedrock Knowledge Bases

默认约300 tokens并保留句子边界。固定大小API的maxTokens范围1–8192，overlapPercentage范围1–99；这是显式固定配置的字段范围，不代表默认策略的重叠比例。
层级策略设置两层大小与绝对overlapTokens；命中child后替换为parent，因此最终返回数量可能更少。对已解析内容，官方说明会尊重页／section边界，调大上限不会自动跨边界合并。
未公开的Markdown围栏、表格重建及超长代码回退细节标为未知，不从“支持文档”推断。

依据：[切块机制](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-chunking.html)、[默认配置说明](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-data-source-customize-ingestion.html)、[固定大小字段](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent_FixedSizeChunkingConfiguration.html)、[层级字段](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent_HierarchicalChunkingConfiguration.html)。

### Google Vertex AI Search／Agent Search

布局切块的chunkSize默认500 tokens，范围100–500；includeAncestorHeadings默认false。所查接口没有overlap字段；搜索接口另可附带邻接chunk，这与索引时重叠不同。
官方布局解析列表包含HTML、PDF、DOCX、PPTX、XLSX/XLSM等，TXT走digital parser；列表未列Markdown。因此只能借鉴布局单元和邻接上下文机制，不宣称这些保护直接适用于Markdown。

依据：[当前解析与格式支持说明](https://docs.cloud.google.com/generative-ai-app-builder/docs/parse-chunk-documents)、[LayoutBasedChunkingConfig字段](https://docs.cloud.google.com/generative-ai-app-builder/docs/reference/rest/v1alpha/projects.locations.collections.dataStores#LayoutBasedChunkingConfig)、[搜索chunk输出](https://docs.cloud.google.com/generative-ai-app-builder/docs/reference/rest/v1alpha/ContentSearchSpec)。

## 补充：已有QMD固定参考的实际边界

主线程只读核对了既有04e4dbd8245c527a88f1a8f0bda547aef9ca81fb版本，非最新发布版验收。
该版将900 tokens近似为3600字符、135 tokens重叠近似为540字符；findBestCutoff优先跳过围栏内候选，但若窗口没有有效候选，仍返回目标位置，后续直接slice。因此“优先避开围栏”不能写成“绝不会切开长代码块”。Markdown在auto与regex路径的测试结果相同，AST函数边界支持不能泛化为Markdown围栏内代码的语法解析。

依据：[参数](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/store.ts#L112)、[无候选回退](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/store.ts#L261)、[切分及重叠](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/src/store.ts#L366)、[Markdown路径测试](https://github.com/tobi/qmd/blob/04e4dbd8245c527a88f1a8f0bda547aef9ca81fb/test/ast-chunking.test.ts#L113)。本轮未运行这些测试。

## Echo采用建议：只保留三个层次

1. **优先验证完整结构单元装箱。** 在新策略ID内保持原1000字符软目标、原重叠设置和同一召回配置，仅改变切点选择：段落／代码块能单独放下时整体搬到下一块；单元本身超长才按原始行回退。超长单行仍有保留整行的例外，不宣称绝对硬上限。先看合成边界样本和已有被截断案例，再做少量固定开发题；不要同轮改成1500并加overlap。
2. **重叠按实际原文范围计量。** 先区分正常结构边界与超长单元内部拆分。不要因框架默认200或云服务推荐25%就给所有小章节制造重叠；同时记录实际重复字符、占用返回块数与覆盖变化。
3. **父子检索留作较大改动。** 自动返回parent会改变预算、去重、来源上限和子问题覆盖。Echo已提供section原文范围并由Agent宿主补读；只有当前流程确有不足时再单独决定是否加入自动扩展，不新增专用读取工具或远程读取。

Echo已经在[profile-sync](../../src/profile-sync.ts#L269)把文件名、headingPath和正文拼成embedding输入，BM25标题字段也使用文件名与headingPath。不能把“加标题前缀”再次列为缺失能力。
所有证据正文仍必须由原文连续行范围截取；补围栏、重复表头、HTML重建或重新串接文本不能伪装成原文。解析器可用于寻找边界，不能直接接管证据正文。
当前召回默认topk10、每篇3、BM25/向量0.5/1、RRF60、候选60/60、最低余弦0.3、预算12000；新默认组合没有独立最终成绩。

## 版本与验证口径

官方网页访问于2026-09-17。主线程为关键开源源码固定提交并通过GitHub官方API核对默认值／围栏代码：

| 仓库                         | 固定提交                                 | 提交时间UTC         |
| ---------------------------- | ---------------------------------------- | ------------------- |
| langchain-ai/langchain       | 5c1f28271295bb13034f4cf8964f74c117357d40 | 2026-09-16 16:50:09 |
| run-llama/llama_index        | fd4a517ad6490f0c8464a13fdf133760b696434a | 2026-09-15 23:21:14 |
| infiniflow/ragflow           | df016eb5ea5197d86ea5f59f206c3102b0dfcecd | 2026-09-17 09:24:26 |
| Unstructured-IO/unstructured | 3376cc96a49521669f3b64028799db16ca76136f | 2026-09-15 00:40:10 |

这些是源码快照，不等于已发布软件包版本。本轮没有部署商业服务、运行第三方测试或比较召回效果。
文档只改变调研认识，不自动修改已确认产品边界、默认策略或已冻结评测；所有采用项仍是候选。
