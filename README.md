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
- 低 CPU 占用：单个空闲看门狗、增量行解析、流式增量合并
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

## 性能与 CPU 限制

Cloudflare Workers 的 CPU 时间只统计真正的计算，**不包括等待网络的时间**。但流式代理的
计算是随着上游 token 持续累积的：一次长回答可能有上千个上游数据块，每块都要解析、转换、
序列化。一旦累计计算超过计划上限，Cloudflare 会返回 **Error 1102**（`Worker exceeded
resource limits`），在 Dashboard 的 **Metrics → Errors → Invocation Statuses** 里显示为
`Exceeded CPU Time Limits`，Logpush/analytics 里的 invocation outcome 是 `exceededCpu`。

| 计划 | 单次请求 CPU 上限 |
|---|---|
| Free | 10 ms |
| Paid | 默认 30 s，最高可调到 5 min |

Paid 计划想放宽上限，在 `wrangler.toml` 里加：

~~~toml
[limits]
cpu_ms = 300000   # 最大 300000（5 分钟），默认 30000
~~~

**因此：需要长回答/大上下文时请使用 Paid 计划**，Free 计划的 10 ms 对任何流式代理都偏紧。
另外注意 Error 1102 也可能是**内存**超限（每 isolate 128 MB），非流式请求会把整段结果缓冲
在内存里，长输出请用 `stream: true`。

> 另一个容易忽略的上限：单次请求的日志配额是 **256 KB**。逐事件打日志的写法会先把这个
> 配额用光，之后的日志（包括报错）全部丢失，所以本实现只对未知事件类型打一次日志。

当前实现已针对该上限做了以下处理（可用 `npm run bench` 自行复测）：

1. **不再每次读取都新建定时器。** 旧实现用 `Promise.race([reader.read(), setTimeout(...)])`
   做空闲超时，但定时器从不清理：一次流式请求会泄漏成百上千个定时器，它们在 30s/90s 后
   集中触发，既消耗 CPU 又产生无人处理的 rejection。现在整个响应只有 1 个看门狗定时器。
2. **增量行解析。** 不再对整块缓冲区反复 `split('\n')`；只扫描新到达的字节，
   避免单行很大时（工具调用参数）出现 O(n²) 扫描。
3. **流式增量合并。** 同一次上游读取里的多个 `text-delta` 合并成一个 SSE chunk。
   以 6000 个 delta 为例，下游 SSE 帧数从 6603 降到约 100（取决于上游 flush 粒度）。
4. **SSE 外壳预拼接。** 热路径只对正文做 `JSON.stringify`，不再每个 delta 构造对象图。
5. **未知事件只记一次日志。** 避免某个新事件类型让日志量与 CPU 一起爆掉。

本地基准（`npm run bench`，6000 个上游事件，Node 22）：

| 场景 | 优化前 | 优化后 |
|---|---|---|
| OpenAI 流式（4KB 块） | 162 ms | 50 ms |
| OpenAI 流式（150B 块，接近逐 token） | 240 ms | 142 ms |
| Anthropic 流式（4KB 块） | 166 ms | 54 ms |
| Anthropic 流式（150B 块） | 228 ms | 128 ms |
| 泄漏的定时器 | 96 ~ 2203 个 | 0 |

> 数值随上游 flush 粒度、模型输出长度变化；重点是"不再随事件数线性堆积定时器"。
> 复测方式：`EVENTS=6000 FLUSH=150 npm run bench`（`FLUSH` 越小越接近逐 token 刷）。

### 空闲超时可配置

~~~toml
[vars]
CC_STREAM_IDLE_TIMEOUT_MS = "30000"      # 流式：多久没有新数据就中断（默认 30s）
CC_NONSTREAM_IDLE_TIMEOUT_MS = "90000"   # 非流式：默认 90s
~~~

超时只在**等待上游**时计时：客户端读得慢（背压）不会被误判成超时。
超时后流式请求会在 SSE 中返回一个 `rate_limit_error` 事件，非流式返回 `429`。

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
npm test          # 协议/超时/定时器泄漏回归测试
npm run bench     # 本地 CPU 基准（可加 EVENTS / FLUSH 环境变量）
npx wrangler deploy --dry-run  # 仅校验部署配置
~~~

## 故障排查

### GitHub Actions 提示未配置 Token

确认 Secret 名称严格为 <code>CF_API_TOKEN</code>，并且配置在当前仓库的 Actions Secrets 中，而不是 Variables。

### 返回 401

检查请求是否包含 <code>Authorization: Bearer user_...</code> 或 <code>x-api-key: user_...</code>。如果依赖 Worker 兜底 Key，检查是否已执行 <code>npx wrangler secret put CC_API_KEY</code>。

### 返回非流式长度限制

将请求改为 <code>stream: true</code>。如果客户端必须使用非流式，将 <code>max_tokens</code> 调整到 <code>16384</code> 或更低。

### 仍然出现 `exceeded CPU time limit`

按顺序检查：

1. 是否在 Free 计划（10ms CPU）。长回答基本必然超限，需要升级到 Paid。
2. 是否用了非流式（`stream: false`）跑长回答：非流式需要把整段结果缓冲在内存里，
   代理限制了 16384 输出 token。长输出请用 `stream: true`。
3. 上下文是否极大（几十万 token）：`JSON.parse` 请求体本身就是可观的计算量，
   尽量压缩历史消息。
4. 用 `npm run tail` 看日志里是否有大量 `Unknown CC event type`——已做去重，
   若仍大量出现说明上游有新事件类型，可按需在解析里显式忽略。

### Session 或指纹发生变化

确认 <code>wrangler.toml</code> 已绑定 <code>CC_STATE</code> KV，并且部署日志中的 bindings 列表包含 <code>env.CC_STATE</code>。

## Credits

协议实现和代理逻辑参考 [MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy)，并移植为 Cloudflare Workers 部署形态。

- 原作者：[@MAXeaglet](https://github.com/MAXeaglet)
- 原项目许可证：MIT

## License

MIT，版权声明见 [LICENSE](LICENSE)。
