# Embedding 配置

每份 JSON 对应一个模型调用配置，文件名必须等于 id。主入口 active.embedding 选择其 ID；实际 model 名不受配置 ID 命名规则限制。

初始化的 default.json 只提供空模板，需补齐服务与模型。以下是结构示例，URL、模型和维度须换成提供方支持的实际值：

```json
{
  "id": "default",
  "provider": "http",
  "base_url": "https://api.example.com/v1",
  "model": "your-embedding-model",
  "dimensions": 1024,
  "api_key_env": "ECHO_EMBEDDING_API_KEY",
  "timeout_ms": 30000,
  "batch_size": 8,
  "document_prefix": "",
  "query_prefix": "",
  "send_dimensions": true
}
```

接口为 OpenAI 兼容的 POST /embeddings：base_url **不包含末尾 /embeddings**，Echo 自动追加。URL 不可包含用户名、密码、查询串或 fragment。dimensions 是期望返回的维度（1–8192），不是任意模型都支持的降维请求；不接受 dimensions 字段的服务设 send_dimensions=false，仍需填写实际返回维度用于验证。

| 参数                           | 默认与作用                                         |
| ------------------------------ | -------------------------------------------------- |
| provider                       | http                                               |
| base_url / model / dimensions  | 必填的服务、模型与输出维度；无预选付费提供方       |
| api_key_env                    | ECHO_EMBEDDING_API_KEY；保存环境变量名，不保存密钥 |
| timeout_ms                     | 30000；1–600000 毫秒，每批请求超时                 |
| batch_size                     | 8；1–128 条，由提供方容量决定                      |
| document_prefix / query_prefix | 空字符串；按模型要求设置，每项最多2000字符         |
| send_dimensions                | true；控制是否发送维度字段                         |

PowerShell 中设置 key：

```powershell
$env:ECHO_EMBEDDING_API_KEY = '<你的 key>'
```

MCP 宿主也必须把该环境变量传给 Echo 子进程；另一个终端设置的变量不会自动进入已经运行的宿主。不要把密钥写入此目录或 Git。

sync 按需发送正文建立向量；dense/hybrid 搜索发送问题及 variants。请求可能计费，失败不自动重试。纯 bm25 不调用模型。字段/key 存在不代表服务可访问。

新模型另建 JSON 并用 `echo-mcp config use --embedding <ID>` 选择，再按提示 sync。端点、模型、维度、前缀、send_dimensions 影响向量身份；key、timeout_ms、batch_size 不改变向量身份。更换模型不会要求重新切块，已存在且有效的对应向量可复用。
