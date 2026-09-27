# 固定切块策略

新工作区选择 markdown-structure-v1@1.0.1：目标约1000字符、常规最大1500、短块阈值200；保留标题、代码、列表、表格和引用结构。超长结构回退时按整行 overlap 约80字符；不是每对块都重叠，1500也不是所有单元的硬断点。

每个 .mjs 默认导出 id、version、chunk，id 必须等于文件名。修改规则或数字时新建 ID，不以外部参数覆盖同一份策略。例如 my-heading.mjs：

```js
export default {
  id: 'my-heading',
  version: '1',
  chunk(input) {
    return input.headingLines(800);
  },
};
```

input 含 sourceId、path、lines（完整原文行号与文本）、resources、headingLines helper。自定义返回 startLine/endLine/headingPath；可另提供成对 sectionStartLine/sectionEndLine。行号从1开始且两端包含，范围对应连续原文；frontmatter 不进入检索正文。Echo 从捕获原文生成 text，不能由策略伪造证据。

策略是可信本地程序，不是沙箱。使用自包含 ESM，可导入 Node 内置模块；第三方逻辑需预先打包。数据用 resources 声明相对策略目录的文件，通过 input.resources 读取捕获内容；不要运行时另读可变词典等资源。

选择：`echo-mcp config use --chunker my-heading`，随后按提示 sync。代码、版本、资源和 helper 都参与指纹；更换切块会建立对应 chunk 与依赖索引，可能需要新的 embedding 调用。更换召回参数无需重切。重复 init 保留已有文件。
