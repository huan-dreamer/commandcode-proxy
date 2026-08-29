# commandcode-workers

运行在 Cloudflare Workers 上的 Command Code API 兼容代理，提供 OpenAI Chat Completions 和 Anthropic Messages 两种接口。

## 项目特性

- OpenAI 兼容：<code>/v1/chat/completions</code>
- Anthropic 兼容：<code>/v1/messages</code>
- 模型列表：<code>/v1/models</code>
- 流式 SSE 和非流式 JSON 响应
- Tool calling、Anthropic <code>tool_use</code>、多模态图片
- Reasoning / thinking 内容转换
- <code>cache_control</code> 透传
- 按 API Key 隔离的 session 和设备指纹
- 可选 Cloudflare KV，跨 Worker 冷启动和 isolate 复用状态
- GitHub Actions 自动部署

## 工作原理

客户端向 Worker 发送 OpenAI 或 Anthropic 格式的请求，Worker 将请求转换为 Command Code 格式并转发到上游，再将上游 NDJSON 流转换为对应的 SSE 或 JSON 响应。

上游请求始终使用流式模式。对于客户端的非流式请求，Worker 会在收到完整上游结果后再组装 JSON。

## 目录结构

~~~text
src/index.js                 Worker 入口、协议转换和上游代理
wrangler.toml                Wrangler 配置
.github/workflows/deploy.yml GitHub Actions 部署流程
~~~

## 快速开始

### 本地开发

~~~bash
npm install
npx wrangler login
npm run dev
~~~

默认地址：<code>http://127.0.0.1:8787</code>。

如需配置本地兜底 API Key，创建 <code>.dev.vars</code>：

~~~text
CC_API_KEY=user_xxxxxxxxx
~~~

<code>.dev.vars</code> 已加入 <code>.gitignore</code>，不要提交真实 Key。

### 直接部署

~~~bash
npm run deploy
~~~

首次部署前需要完成 <code>npx wrangler login</code>，并确认 <code>wrangler.toml</code> 中的 Worker 名称符合预期。

## GitHub Actions 部署

工作流文件为 <code>.github/workflows/deploy.yml</code>，支持以下触发方式：

- 推送到 <code>master</code> 分支，并修改 Worker 或部署相关文件
- 在 GitHub Actions 页面手动执行 <code>workflow_dispatch</code>

### 必需 Secret：<code>CF_API_TOKEN</code>

GitHub Actions 只需要配置一个 Secret：<code>CF_API_TOKEN</code>。该 Token 用于 <code>cloudflare/wrangler-action</code> 部署 Worker，不是运行时传给上游 API 的 Key。

配置步骤：

1. 在 Cloudflare 创建 API Token（Custom token）。
2. 为目标账户授予 <strong>Workers Scripts: Edit</strong> 权限。
3. 打开 GitHub 仓库的 <strong>Settings → Secrets and variables → Actions</strong>。
4. 创建 Repository secret：

~~~text
Name:  CF_API_TOKEN
Value: <Cloudflare API Token>
~~~

不需要额外配置 <code>CF_ACCOUNT_ID</code>。请勿将 Token 写入 <code>wrangler.toml</code>、<code>.dev.vars</code>、工作流文件或代码。

部署流程会先执行：

~~~bash
npm ci
npx wrangler deploy --dry-run
~~~

校验通过后再执行正式部署。

## 配置说明

### <code>wrangler.toml</code> 运行时变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| <code>CC_API_BASE</code> | <code>https://api.commandcode.ai</code> | Command Code 上游 API 地址 |
| <code>PROJECT_SLUG</code> | <code>cc-proxy</code> | 项目标识；实际请求 slug 会结合 session 生成 |
| <code>CC_USE_PROVIDER_MODELS</code> | <code>true</code> | 是否从 Provider API 获取模型列表 |

### Worker Secret：<code>CC_API_KEY</code>

<code>CC_API_KEY</code> 是可选的 Worker 运行时兜底 Key：

~~~bash
npx wrangler secret put CC_API_KEY
~~~

正常情况下建议客户端通过请求头传入 Key：

~~~http
Authorization: Bearer user_xxxxxxxxx
~~~

或：

~~~http
x-api-key: user_xxxxxxxxx
~~~

请求头中的 Key 优先于 <code>CC_API_KEY</code>。Key 需要包含 <code>user_</code> 前缀。

### 默认 KV：<code>CC_STATE</code>

Session 和设备指纹通过默认绑定的 KV 持久化，避免 Worker 冷启动、实例回收或请求切换 isolate 后状态丢失。

首次 GitHub Actions 部署时，Wrangler 会根据 <code>wrangler.toml</code> 中没有填写 <code>id</code> 的 draft binding 自动创建 KV namespace 并完成绑定：

~~~toml
[[kv_namespaces]]
binding = "CC_STATE"
~~~

自动创建需要 <code>CF_API_TOKEN</code> 具备 Workers 部署权限和 KV namespace 创建/编辑权限。

如果需要绑定已有 namespace，可以改为填写已有 ID：

~~~toml
[[kv_namespaces]]
binding = "CC_STATE"
id = "KV_NAMESPACE_ID"
~~~

KV 中保存每个 API Key 的以下状态：

~~~text
sessionId
sessionExpiresAt
fingerprint
nextInitAt
~~~

API Key 不会作为 KV key 明文保存，实际 KV key 为：

~~~text
cc-state:<SHA-256(apiKey)>
~~~

本地开发或移除 KV 绑定时，Worker 会自动使用内存 fallback。KV 读写异常也不会阻断正常代理请求。

## API 使用

### OpenAI Chat Completions

~~~bash
curl https://<worker-domain>/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
~~~

### Anthropic Messages

~~~bash
curl https://<worker-domain>/v1/messages \
  -H "x-api-key: user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 2048,
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
~~~

### 接口列表

| 方法 | 路径 | 返回格式 | 说明 |
|---|---|---|---|
| <code>POST</code> | <code>/v1/chat/completions</code> | OpenAI JSON / SSE | Chat Completions |
| <code>POST</code> | <code>/v1/messages</code> | Anthropic JSON / SSE | Messages |
| <code>GET</code> | <code>/v1/models</code> | OpenAI JSON | 模型列表 |
| <code>GET</code> | <code>/health</code> | <code>OK</code> | 健康检查 |
| <code>GET</code> | <code>/</code> | <code>OK</code> | 健康检查 |

## 流式与非流式请求

生产环境优先使用：

~~~json
{
  "stream": true
}
~~~

原因：

- 流式请求可以更早返回首个增量内容。
- 长输出不会等到完整内容生成后才开始响应。
- 可以降低触达 Cloudflare Workers 执行时长限制的风险。

非流式请求需要完整缓冲响应，代理限制最大输出为 <code>16384 tokens</code>。当非流式请求显式设置更大的 <code>max_tokens</code> 时，会返回 <code>400 invalid_request_error</code>，并提示改用 <code>stream: true</code>。

流式请求仍受上游连接稳定性和 <code>30s</code> 无数据空闲超时影响；非流式请求的无数据空闲超时为 <code>90s</code>。

## 常用命令

~~~bash
npm run dev       # 本地开发
npm run deploy    # 部署 Worker
npm run tail      # 查看线上日志
npx wrangler deploy --dry-run  # 仅校验部署配置
~~~

## 故障排查

### GitHub Actions 提示未配置 Token

确认 Secret 名称严格为 <code>CF_API_TOKEN</code>，并且配置在当前仓库的 Actions Secrets 中，而不是 Variables。

### 返回 401

检查请求是否包含 <code>Authorization: Bearer user_...</code> 或 <code>x-api-key: user_...</code>。如果依赖 Worker 兜底 Key，检查是否已执行 <code>npx wrangler secret put CC_API_KEY</code>。

### 返回非流式长度限制

将请求改为 <code>stream: true</code>。如果客户端必须使用非流式，将 <code>max_tokens</code> 调整到 <code>16384</code> 或更低。

### Session 或指纹发生变化

确认 <code>wrangler.toml</code> 已绑定 <code>CC_STATE</code> KV，并且部署日志中的 bindings 列表包含 <code>env.CC_STATE</code>。

## Credits

协议实现和代理逻辑参考 [MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy)，并移植为 Cloudflare Workers 部署形态。

- 原作者：[@MAXeaglet](https://github.com/MAXeaglet)
- 原项目许可证：MIT

## License

MIT，版权声明见 [LICENSE](LICENSE)。
