# 固定分词策略

默认 icu-zh@1 在本地使用 ICU 词分割，并扩展汉字双字词、技术标识符全名/组成词及停用词处理。没有本地模型下载，不调用 embedding API。

每个 .mjs 默认导出 id、version、tokenize；id 必须等于文件名。可完全自定义返回词项，也可使用 helper，例如 domain-words.mjs：

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

words.json 是字符串数组，例如 ["幂等键", "HTTPServer"]。资源路径相对策略文件，执行时使用已捕获的 context.resources。策略须为可信、自包含 ESM；第三方算法可预先打包，不能依赖未打包的相对模块。

Echo 将返回词项统一 NFKC、小写及十六进制编码，保存到 SQLite；MiniSearch 与 SQLite 词法引擎复用同一词项，索引和查询使用同一策略快照。单次最多100000词，每词最多10000字符；空词项丢弃。原文和 embedding 输入不做此词项编码。

使用 `echo-mcp config use --tokenizer domain-words` 切换，然后按提示 sync。规则或词典改变需要重建对应词项；在 chunk 与模型未变时可复用向量，不因换分词而重新 embedding。改变算法请新建策略 ID，资源内容和版本也参与指纹。重复 init 保留已有文件。
