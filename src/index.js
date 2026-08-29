/**
 * Cloudflare Workers — Command Code → OpenAI/Anthropic 兼容代理
 * 状态默认使用 isolate 内存缓存；配置 CC_STATE KV 后可跨冷启动/实例稳定复用
 *
 * Credit: protocol & proxy logic adapted from
 *   https://github.com/MAXeaglet/commandcode-proxy (MIT, © MAXeaglet)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';


// ── 配置（Workers env） ───────────────────────────
function loadConfig(env = {}) {
  return {
    apiBase: env.CC_API_BASE || 'https://api.commandcode.ai',
    projectSlug: env.PROJECT_SLUG || 'cc-proxy',
    apiKey: env.CC_API_KEY || '',
    logLevel: env.LOG_LEVEL || 'info',
    useProviderModels: env.CC_USE_PROVIDER_MODELS !== 'false',
    modelRefreshIntervalMs: parseInt(env.MODEL_REFRESH_INTERVAL_MS || String(5 * 60 * 1000), 10),
    state: env.CC_STATE || null,
  };
}

/** @type {ReturnType<typeof loadConfig>} */
let CFG = loadConfig();


// ── 指纹生成（按 API Key 隔离；可由 KV 跨 isolate 持久化） ──────
// CPU 型号与核心数对应表（仅 Windows x64）
const FINGERPRINT_CPUS = [
  { model: '12th Gen Intel(R) Core(TM) i7-12650H', cores: 10 },
  { model: '12th Gen Intel(R) Core(TM) i5-12400F', cores: 6 },
  { model: '12th Gen Intel(R) Core(TM) i9-12900K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i7-13700K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i5-13600K', cores: 14 },
  { model: '13th Gen Intel(R) Core(TM) i9-13900K', cores: 24 },
  { model: 'Intel(R) Core(TM) Ultra 7 155H', cores: 16 },
  { model: 'Intel(R) Core(TM) Ultra 9 285H', cores: 16 },
  { model: 'Intel(R) Core(TM) i9-14900K', cores: 24 },
  { model: 'Intel(R) Core(TM) i7-14700K', cores: 20 },
  { model: 'AMD Ryzen 7 7800X3D', cores: 8 },
  { model: 'AMD Ryzen 9 7950X', cores: 16 },
  { model: 'AMD Ryzen 5 7600', cores: 6 },
  { model: 'AMD Ryzen 9 7900X', cores: 12 },
  { model: 'AMD Ryzen 7 5800X3D', cores: 8 },
];
const FINGERPRINT_MEMS = [8, 16, 24, 32, 48, 64];
const FINGERPRINT_TZS = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Toronto',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Hong_Kong',
  'Australia/Sydney', 'Pacific/Auckland',
];
const FINGERPRINT_MAC_COUNT_RANGE = [2, 3, 4, 5]; // 随机 2~5 个 MAC

function generateFingerprint() {
  const cpuEntry = FINGERPRINT_CPUS[Math.floor(Math.random() * FINGERPRINT_CPUS.length)];
  const memGiB = FINGERPRINT_MEMS[Math.floor(Math.random() * FINGERPRINT_MEMS.length)];
  const tz = FINGERPRINT_TZS[Math.floor(Math.random() * FINGERPRINT_TZS.length)];
  const macCount = FINGERPRINT_MAC_COUNT_RANGE[Math.floor(Math.random() * FINGERPRINT_MAC_COUNT_RANGE.length)];

  function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
  function randHex(n) { return randomBytes(n).toString('hex'); }

  const macHashes = [];
  for (let i = 0; i < macCount; i++) macHashes.push(sha256(randHex(32)));

  const machineIdHash = sha256(randHex(32));
  const osUserHash = sha256(randHex(16));
  const hostnameHash = sha256(randHex(16));
  const gitEmailHash = sha256(randHex(16));

  // thumbmark = 所有组件的联合哈希
  const thumbData = [machineIdHash, ...macHashes, osUserHash, hostnameHash, gitEmailHash, 'win32', '10.0.22631', cpuEntry.model, String(cpuEntry.cores), String(memGiB)].join('|');
  const thumbmark = sha256(thumbData);

  return {
    thumbmark,
    components: {
      machineIdHash,
      macHashes,
      osUserHash,
      hostnameHash,
      gitEmailHash,
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.22631',
      cpuModel: cpuEntry.model,
      cpuCount: cpuEntry.cores,
      memGiB,
      isContainer: false,
      timezone: tz,
      runtime: 'cli',
      collectorVersion: 1,
    },
  };
}

let CC_VERSION = '0.32.3';
const CC_VERSION_FALLBACK = '0.32.3';
const CC_VERSION_REFRESH_MS = 24 * 60 * 60 * 1000; // 24h — npm registry 刷新间隔

// ── 动态 CC 版本号（从 npm registry 拉取） ─────────────
async function refreshCCVersion() {
  try {
    const url = 'https://registry.npmjs.org/command-code/latest';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`npm responded with ${res.status}`);
    const pkg = await res.json();
    if (pkg.version && typeof pkg.version === 'string') {
      CC_VERSION = pkg.version;
      log('info', 'CC Version refreshed from npm', { version: CC_VERSION });
    }
  } catch (e) {
    log('warn', 'CC Version fetch failed, using current', { version: CC_VERSION, error: e.message });
  }
}
// Workers: no setInterval — lazy refresh on demand (see maybeRefreshCCVersion)
let ccVersionLastFetch = 0;
async function maybeRefreshCCVersion() {
  const now = Date.now();
  if (now - ccVersionLastFetch < CC_VERSION_REFRESH_MS && CC_VERSION !== CC_VERSION_FALLBACK) return;
  ccVersionLastFetch = now;
  await refreshCCVersion();
}


const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB — 请求体大小上限
const STREAM_IDLE_TIMEOUT_MS = 30000;   // 30s — 流式无新数据中断
const NONSTREAM_IDLE_TIMEOUT_MS = 90000; // 90s — 非流式超时更宽容
const SSE_KEEPALIVE_INTERVAL_MS = 15000; // 15s — 静默期才发 keepalive，避免刷屏
const DEFAULT_MAX_TOKENS = 64000;
const MAX_NONSTREAM_OUTPUT_TOKENS = 16384; // 非流式保护上限，长输出请使用 stream=true

// 连续超时计数：连续 3 次超时才提醒压缩上下文，任意成功请求后重置
let consecutiveTimeouts = 0;
const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3;

// ── 日志 ─────────────────────────────────────────────
function log(level, msg, data) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
}

/** Emit a structured usage line for wrangler tail / Logpush aggregation. */
function logUsage({
  path,
  model,
  stream = false,
  id,
  usage,
  elapsedMs,
  bytesReceived,
  finishReason,
  status = 'ok',
}) {
  const promptTokens = Number(usage?.inputTokens ?? usage?.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(usage?.outputTokens ?? usage?.completion_tokens ?? 0) || 0;
  const cachedTokens = Number(
    usage?.cachedInputTokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.cache_read_input_tokens
    ?? 0,
  ) || 0;
  log('info', 'usage', {
    path,
    model,
    stream: !!stream,
    id: id || undefined,
    status,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cached_tokens: cachedTokens,
    total_tokens: promptTokens + completionTokens,
    elapsed_ms: elapsedMs ?? undefined,
    bytes_received: bytesReceived ?? undefined,
    finish_reason: finishReason || undefined,
  });
}

// ── 会话管理 ───────────────────────────────────────
// 每个 API Key 独立一个 session，12h 过期 + 1h 随机抖动
// 同一 Key 在同一周期内复用，到期自动换新
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;    // 12h
const SESSION_JITTER_MS  = 60 * 60 * 1000;           // 1h 抖动范围

const sessionStore = new Map(); // apiKey → { sessionId, expiresAt }
const stateLoadStore = new Map(); // apiKey → Promise，避免并发冷启动重复生成状态
const sessionCreateStore = new Map(); // apiKey → Promise，避免并发请求轮换出多个 session
const keyStateStore = new Map(); // apiKey → persisted state (session + fingerprint + init throttle)

function stateKeyForApiKey(apiKey) {
  return `cc-state:${createHash('sha256').update(apiKey).digest('hex')}`;
}

function isValidPersistedState(state) {
  return !!state && typeof state === 'object'
    && state.fingerprint && typeof state.fingerprint === 'object'
    && typeof state.nextInitAt === 'number';
}

async function readPersistedState(apiKey) {
  if (!CFG.state) return null;
  try {
    const raw = await CFG.state.get(stateKeyForApiKey(apiKey));
    if (!raw) return null;
    const state = JSON.parse(raw);
    return isValidPersistedState(state) ? state : null;
  } catch (e) {
    log('warn', 'KV state read failed, using isolate memory fallback', { error: e.message });
    return null;
  }
}

async function persistState(apiKey, state) {
  if (!CFG.state) return;
  try {
    await CFG.state.put(stateKeyForApiKey(apiKey), JSON.stringify({
      sessionId: state.sessionId || null,
      sessionExpiresAt: Number(state.sessionExpiresAt) || 0,
      fingerprint: state.fingerprint,
      nextInitAt: Number(state.nextInitAt) || 0,
    }));
  } catch (e) {
    // KV 故障不应使代理请求失败；热 isolate 仍可继续工作。
    log('warn', 'KV state write failed, keeping isolate memory state', { error: e.message });
  }
}

async function loadOrCreateKeyState(apiKey) {
  const cached = keyStateStore.get(apiKey);
  if (cached) return cached;

  const pending = stateLoadStore.get(apiKey);
  if (pending) return pending;

  const load = (async () => {
    if (keyStateStore.size > 100) cleanupExpiredSessions();
    const persisted = await readPersistedState(apiKey);
    const state = persisted || {
      sessionId: null,
      sessionExpiresAt: 0,
      fingerprint: generateFingerprint(),
      nextInitAt: 0,
    };
    keyStateStore.set(apiKey, state);

    if (state.sessionId && Date.now() < state.sessionExpiresAt) {
      sessionStore.set(apiKey, { sessionId: state.sessionId, expiresAt: state.sessionExpiresAt });
    }

    if (!persisted) {
      log('info', 'Fingerprint generated for key', { keyPrefix: apiKey.slice(0, 8) });
      // 首次生成后先落 KV，保证后续冷启动恢复相同指纹。
      await persistState(apiKey, state);
    }
    return state;
  })();

  stateLoadStore.set(apiKey, load);
  try {
    return await load;
  } finally {
    stateLoadStore.delete(apiKey);
  }
}

async function ensureSession(apiKey) {
  const state = await loadOrCreateKeyState(apiKey);
  const now = Date.now();
  const entry = sessionStore.get(apiKey);
  if (entry && now < entry.expiresAt) return entry.sessionId;

  const pending = sessionCreateStore.get(apiKey);
  if (pending) return pending;

  const create = (async () => {
    const current = sessionStore.get(apiKey);
    if (current && Date.now() < current.expiresAt) return current.sessionId;

    // 过期或第一次：生成新 session
    const jitter = Math.floor(Math.random() * SESSION_JITTER_MS);
    const sessionId = randomUUID();
    const expiresAt = Date.now() + SESSION_DURATION_MS + jitter;
    const next = { sessionId, expiresAt };
    sessionStore.set(apiKey, next);
    state.sessionId = sessionId;
    state.sessionExpiresAt = expiresAt;
    // 首次/换期 session 先持久化，再发上游请求。
    await persistState(apiKey, state);
    log('info', 'Session created', { sessionId: sessionId.slice(0, 8), storeSize: sessionStore.size });
    return sessionId;
  })();

  sessionCreateStore.set(apiKey, create);
  try {
    return await create;
  } finally {
    sessionCreateStore.delete(apiKey);
  }
}

// Workers: lazy cleanup on access (no setInterval)
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [key, entry] of sessionStore) {
    if (now >= entry.expiresAt) {
      sessionStore.delete(key);
      const state = keyStateStore.get(key);
      if (state) {
        state.sessionId = null;
        state.sessionExpiresAt = 0;
      }
    }
  }
}

async function getSessionId(incomingHeaders, apiKey) {
  // 优先从客户端传来的 session 类 header 获取
  const candidates = [
    incomingHeaders['x-session-id'],
    incomingHeaders['x-claude-code-session-id'],
  ];
  for (const id of candidates) {
    if (id && typeof id === 'string' && id.length >= 8) return id;
  }
  // 按 API Key 分 session
  return ensureSession(apiKey);
}

// 每个请求独立 thread ID
function newThreadId() { return randomUUID(); }

// ── 每 Key 独立状态（fingerprint + 初始化节流） ──
// 每个 API Key 拥有自己的设备指纹、session 和初始化定时器
async function getOrCreateKeyState(apiKey) {
  return loadOrCreateKeyState(apiKey);
}

// ── 初始化预请求（fingerprint + lifecycle，首次 + 每 8h+2h 抖动） ────
const INIT_REFRESH_MS = 8 * 60 * 60 * 1000;    // 8h
const INIT_JITTER_MS  = 2 * 60 * 60 * 1000;    // 2h 抖动

async function ensureInitialized(apiKey, signal) {
  const state = await getOrCreateKeyState(apiKey);
  const now = Date.now();
  if (now < state.nextInitAt) return;

  try {
    // 并行发两个预请求
    const headers = {
      'Content-Type': 'application/json',
      'x-cli-environment': 'production',
      'Authorization': `Bearer ${apiKey}`,
      'x-command-code-version': CC_VERSION,
    };
    const fingerprint = state.fingerprint || {};

    await Promise.all([
      fetch(`${CFG.apiBase}/alpha/fingerprint/record`, {
        method: 'POST', headers, signal,
        body: JSON.stringify(fingerprint),
      }).then(r => {
        if (!r.ok) log('warn', 'Fingerprint record failed', { status: r.status });
        else log('info', 'Fingerprint recorded');
      }).catch(e => {
        if (e.name !== 'AbortError') log('warn', 'Fingerprint record error', { error: e.message });
      }),

      fetch(`${CFG.apiBase}/alpha/lifecycle-events`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({
          eventType: 'cli_session_exists',
          metadata: {
            sessionId: `sess_${randomBytes(8).toString('hex')}`,
            cliVersion: CC_VERSION,
            mode: 'interactive',
            os: `${fingerprint.components.platform}-${fingerprint.components.arch}`,
          },
        }),
      }).then(r => {
        if (!r.ok) log('warn', 'Lifecycle event failed', { status: r.status });
        else log('info', 'Lifecycle event sent');
      }).catch(e => {
        if (e.name !== 'AbortError') log('warn', 'Lifecycle event error', { error: e.message });
      }),
    ]);

    // 成功：8h + 2h 随机抖动
    const jitter = Math.floor(Math.random() * INIT_JITTER_MS);
    state.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter;
    await persistState(apiKey, state);
    log('info', 'Fingerprint/lifecycle next refresh', { nextIn: `${(INIT_REFRESH_MS + jitter) / 3600000}h` });
  } catch (e) {
    if (e.name !== 'AbortError') log('warn', 'Fingerprint/lifecycle refresh error, will retry next request', { error: e.message });
  }
}

// ── 模型列表 ───────────────────────────────────────
const MODELS = [
  // Anthropic
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  // OpenAI
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  // DeepSeek
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  // Kimi
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6' },
  { id: 'moonshotai/Kimi-K2.5', name: 'Kimi K2.5' },
  // GLM
  { id: 'zai-org/GLM-5.1', name: 'GLM 5.1' },
  { id: 'zai-org/GLM-5', name: 'GLM 5' },
  // MiniMax
  { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3' },
  { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7' },
  { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5' },
  // Qwen
  { id: 'Qwen/Qwen3.6-Max-Preview', name: 'Qwen 3.6 Max Preview' },
  { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus' },
  { id: 'Qwen/Qwen3.7-Max', name: 'Qwen 3.7 Max' },
  // Step
  { id: 'stepfun/Step-3.7-Flash', name: 'Step 3.7 Flash' },
  { id: 'stepfun/Step-3.5-Flash', name: 'Step 3.5 Flash' },
  // Xiaomi
  { id: 'xiaomi/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5' },
  // Gemini
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
];

// ── 工具函数 ───────────────────────────────────────

// 从 sessionId 构造一个假的工作目录路径，再按真实 CLI 规则生成 slug
// 结果形如 "d-users-dev-projects-web-app-a3f2" (和真实 CLI 的 slug 格式一致)
function fakeProjectSlug(sessionId) {
  const names = ['app', 'api', 'backend', 'bot', 'cli', 'core', 'data', 'frontend',
    'lib', 'plugin', 'proxy', 'server', 'service', 'tool', 'web', 'worker'];
  const name = names[parseInt(sessionId.slice(0, 4), 16) % names.length];
  const suffix = sessionId.slice(0, 4);
  // 模拟一个类似 C:\Users\dev\projects\{name}-{suffix} 的路径
  const path = `C:\\Users\\dev\\projects\\${name}-${suffix}`;
  return path
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function generateTraceparent() {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function getDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function getEnvironment() {
  // Fake CLI environment for Workers (no real OS process)
  return 'win32-x64, Node.js 22.0.0';
}

// ── CC 请求体构建 ─────────────────────────────────

function copyCacheControl(target, source) {
  if (source?.cache_control) target.cache_control = source.cache_control;
  return target;
}

function textContentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part?.type === 'text')
      .map(part => part.text ?? part.content ?? '')
      .join('\n');
  }
  return content == null ? '' : String(content);
}

function hasCacheControl(content, messageCacheControl) {
  return !!messageCacheControl
    || (Array.isArray(content) && content.some(part => part?.cache_control));
}

function toCachedTextBlocks(content, messageCacheControl) {
  const sourceBlocks = Array.isArray(content)
    ? content.filter(part => part?.type === 'text')
    : [{ type: 'text', text: textContentToString(content), cache_control: messageCacheControl }];

  return sourceBlocks.map(part => {
    const block = { type: 'text', text: part.text ?? part.content ?? '' };
    return copyCacheControl(block, part.cache_control ? part : { cache_control: messageCacheControl });
  });
}

function toAnthropicImageUrl(block) {
  const source = block?.source || {};
  let url = '';
  if (source.type === 'base64' && source.media_type && source.data) {
    url = 'data:' + source.media_type + ';base64,' + source.data;
  } else if (source.url) {
    url = source.url;
  }
  if (!url) return null;
  return copyCacheControl({ type: 'image_url', image_url: { url } }, block);
}

function buildCcRequest(openaiReq) {
  const { model, messages, max_tokens, temperature, tools, stream, reasoning_effort, tool_choice, parallel_tool_calls } = openaiReq;

  // 从 messages 中提取 system prompt；cache_control 存在时必须保留 block 结构。
  const systemMsgs = messages.filter(m => m.role === 'system');
  const systemHasCache = systemMsgs.some(msg => hasCacheControl(msg.content, msg.cache_control));
  const systemPrompt = systemHasCache
    ? systemMsgs.flatMap(msg => toCachedTextBlocks(msg.content, msg.cache_control))
    : systemMsgs.map(msg => textContentToString(msg.content)).filter(Boolean).join('\n');
  const chatMessages = messages.filter(m => m.role !== 'system');

  // Build tool_call_id → tool_name reverse lookup
  const toolNameMap = {};
  for (const msg of chatMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          toolNameMap[tc.id] = tc.function?.name || '';
        }
      }
    }
  }

  // 转换 messages 为 CC 格式，并保留 block/message 上的 cache_control。
  const ccMessages = chatMessages.map(msg => {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        return { role: 'user', content: [copyCacheControl({ type: 'text', text: msg.content }, msg)] };
      }
      // 多模态：转换 OpenAI image_url，同时保留各 block 的 cache_control。
      if (Array.isArray(msg.content)) {
        const parts = msg.content.map(part => {
          if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            // CC CLI 真实格式: { type: "image", image: "data:image/jpeg;base64,..." }
            return copyCacheControl({ type: 'image', image: url }, part.cache_control ? part : msg);
          }
          if (part.type === 'text') {
            return copyCacheControl({ type: 'text', text: part.text ?? part.content ?? '' }, part.cache_control ? part : msg);
          }
          return { ...part };
        }).filter(Boolean);
        return { role: 'user', content: parts };
      }
      return { role: 'user', content: [copyCacheControl({ type: 'text', text: String(msg.content) }, msg)] };
    }
    if (msg.role === 'assistant') {
      const parts = [];
      if (msg.content && typeof msg.content === 'string') {
        parts.push(copyCacheControl({ type: 'text', text: msg.content }, msg));
      } else if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push(copyCacheControl({ type: 'text', text: part.text ?? part.content ?? '' }, part.cache_control ? part : msg));
          }
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function?.name || '',
            input: (typeof tc.function?.arguments === 'string' ? tryParseJSON(tc.function.arguments) : (tc.function?.arguments || {})),
          });
        }
      }
      return { role: 'assistant', content: parts };
    }
    if (msg.role === 'tool') {
      const toolResult = {
        type: 'tool-result',
        toolCallId: msg.tool_call_id,
        toolName: toolNameMap[msg.tool_call_id] || msg.name || '',
        output: { type: 'text', value: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) },
      };
      return {
        role: 'tool',
        content: [copyCacheControl(toolResult, msg)],
      };
    }
    return msg;
  });

  const threadId = newThreadId();

  const body = {
    config: {
      workingDir: 'C:\\Users\\dev\\projects\\cc-proxy',
      date: getDateStr(),
      environment: getEnvironment(),
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: '',
    permissionMode: 'standard',
    params: {
      model: model || 'deepseek/deepseek-v4-flash',
      messages: ccMessages,
      // CC 上游始终以 NDJSON 流返回；非流式仅在代理侧缓冲，因此限制其输出规模。
      max_tokens: Math.min(
        max_tokens || (stream === true ? DEFAULT_MAX_TOKENS : MAX_NONSTREAM_OUTPUT_TOKENS),
        stream === true ? 200000 : MAX_NONSTREAM_OUTPUT_TOKENS,
      ),
      stream: true,  // CC API 总是 stream
    },
  };

  // 条件字段
  if (systemPrompt) {
    body.params.system = systemPrompt;
  }
  if (temperature !== undefined) {
    body.params.temperature = temperature;
  }
  if (reasoning_effort !== undefined) {
    body.params.reasoning_effort = reasoning_effort;
  }
  if (tools && tools.length > 0) {
    body.params.tools = tools.map(t => copyCacheControl({
      type: t.type || 'function',
      name: t.function?.name || t.name || '',
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
    }, t));
  }
  if (tool_choice !== undefined) {
    // OpenAI 格式 → CC (Anthropic 风格) 格式
    if (typeof tool_choice === 'string') {
      const map = { 'auto': 'auto', 'none': 'none', 'required': 'any' };
      body.params.tool_choice = { type: map[tool_choice] || 'auto' };
    } else if (tool_choice.type === 'function') {
      // OpenAI object → Anthropic object
      body.params.tool_choice = { type: 'tool', name: tool_choice.function?.name };
    } else {
      body.params.tool_choice = tool_choice;
    }
  }
  if (parallel_tool_calls !== undefined) {
    body.params.parallel_tool_calls = parallel_tool_calls;
  }

  return body;
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// ── CC NDJSON → OpenAI SSE 转换 ────────────────────

function createSseTranslator(model, completionId, created) {
  let chunkIndex = 0;
  let sentRole = false;
  let finishReason = null;
  let usage = null;
  let toolCallIndex = 0;

  return {
    lastCcEvent: '',
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    /** 解析一行 NDJSON，返回 OpenAI chunk 数组 */
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;

      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;

      const out = [];

      switch (event.type) {
        case 'text-start':
        case 'reasoning-start':
        case 'start':
        case 'start-step':
          // 忽略，无用户可见内容
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          const delta = chunkIndex === 0 ? { role: 'assistant', content: text } : { content: text };
          chunkIndex++;
          sentRole = true;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          const delta = chunkIndex === 0
            ? { role: 'assistant', reasoning_content: text }
            : { reasoning_content: text };
          chunkIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'tool-call': {
          const id = event.toolCallId || `call_${Date.now()}_${toolCallIndex}`;
          const name = event.toolName || '';
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          const tcEntry = { index: toolCallIndex, id, type: 'function', function: { name, arguments: args } };
          const delta = chunkIndex === 0
            ? { role: 'assistant', content: null, tool_calls: [tcEntry] }
            : { tool_calls: [tcEntry] };
          chunkIndex++;
          toolCallIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'finish-step': {
          if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
          if (event.usage) {
            usage = event.usage;
            this.inputTokens = event.usage.inputTokens ?? 0;
            this.outputTokens = event.usage.outputTokens ?? 0;
            this.cachedInputTokens = event.usage.cachedInputTokens ?? 0;
          }
          break;
        }

        case 'finish': {
          const fr = finishReason || mapFinishReason(event.finishReason || 'stop');
          const u = event.totalUsage || usage || {};
          normalizeUsage(u);
          this.inputTokens = u.inputTokens ?? 0;
          this.outputTokens = u.outputTokens ?? 0;
          this.cachedInputTokens = u.cachedInputTokens ?? 0;
          const openaiUsage = u ? {
            prompt_tokens: u.inputTokens ?? 0,
            completion_tokens: u.outputTokens ?? 0,
            total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: u.cachedInputTokens ?? 0 },
          } : undefined;
          out.push(makeChunk(completionId, created, model, {}, fr, openaiUsage));
          break;
        }

        case 'error': {
          const msg = event.error?.message || event.message || 'Unknown error';
          log('warn', 'CC stream error', { message: msg });
          // Don't emit a finish_reason chunk — let the natural stream termination
          // handle it. Otherwise a subsequent finish(tool_calls) would be ignored
          // by downstream agent loops that stop at the first finish_reason.
          break;
        }

        case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
          // Silent - no user-visible content
          break;
        default:
          log('warn', 'Unknown CC event type', { type: event.type });
          break;
      }

      return out.length > 0 ? out : null;
    },

    /** 获取 SSE 结束标记 */
    getDoneEvent() {
      return 'data: [DONE]\n\n';
    },
  };
}

function makeChunk(id, created, model, delta, finishReason, usage) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// normalize CC usage stats:
// - outputTokens=0 → zero everything (anti false billing)
function normalizeUsage(u) {
  if (!u) return;
  const ot = Number(u.outputTokens);
  if (!ot) {  // 0, null, undefined, NaN → zero input + cached (anti false billing)
    u.inputTokens = 0;
    u.cachedInputTokens = 0;
  }
}

function mapFinishReason(reason) {
  switch (reason) {
    case 'tool-calls': return 'tool_calls';
    case 'length': return 'length';
    case 'stop': return 'stop';
    default: return reason || 'stop';
  }
}

// ── 错误映射 ───────────────────────────────────────
const CC_STATUS_MAP = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 429, type: 'rate_limit_error' },       // payment required → rate limit
  403: { status: 401, type: 'authentication_error' },
  404: { status: 404, type: 'not_found' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' },
};

function mapCcError(ccStatus, ccBody) {
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };
  let message = `CC API error (${ccStatus})`;

  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody);
      message = parsed.error?.message || parsed.message || message;
    } catch {
      message = ccBody.slice(0, 200) || message;
    }
  }

  // CC 429 响应可能带 retry-after
  if (ccStatus === 429) {
    return {
      status: 429,
      body: {
        error: { message, type: 'rate_limit_error' },
        retry_after: 30,
      },
    };
  }

  return { status: mapped.status, body: { error: { message, type: mapped.type } } };
}


function getApiKey(headers) {
  // Try Authorization: Bearer header (OpenAI SDK style)
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const match = auth.slice(7).match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  // Fall back to x-api-key header (Anthropic SDK style)
  const xKey = headers['x-api-key'] || headers['X-Api-Key'] || '';
  if (xKey) {
    const match = xKey.match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  return null;
}

async function forwardToCC(body, apiKey, incomingHeaders = {}, signal) {
  const url = `${CFG.apiBase}/alpha/generate`;
  const traceparent = generateTraceparent();
  const sessionId = await getSessionId(incomingHeaders, apiKey);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-cli-environment': 'production',
      'x-command-code-version': CC_VERSION,
      'x-session-id': sessionId,
      'x-co-flag': 'false',
      'x-taste-learning': 'false',
      'x-project-slug': fakeProjectSlug(sessionId),
      'traceparent': traceparent,
    },
    body: JSON.stringify(body),
    signal,
  });

  return response;
}

// ── Anthropic /v1/messages 协议转换 ─────────────────

function mapAnthropicStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop': return 'end_turn';
    default: return 'end_turn';
  }
}

// Generate a Claude-format fake signature for thinking blocks.
// Anthropic validates thinking signatures cryptographically; this proxy cannot
// mint provider signatures, but Claude Code only performs a shallow format
// check before displaying the block.
function fakeThinkingSignature(thinkingText) {
  const seed = createHash('sha256')
    .update(thinkingText || 'dsh-proxy-thinking')
    .digest()
    .subarray(0, 32);
  const raw = Buffer.concat([Buffer.from([0x12, seed.length]), seed]);
  return raw.toString('base64');
}

function buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText) {
  const content = [];
  if (thinkingText) {
    content.push({
      type: 'thinking',
      thinking: thinkingText,
      signature: fakeThinkingSignature(thinkingText),
    });
  }
  if (fullText) content.push({ type: 'text', text: fullText });
  if (toolCalls) {
    for (const tc of toolCalls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }
  return {
    id: `msg_${randomUUID().slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapAnthropicStopReason(finishReason || 'stop'),
    stop_sequence: null,
    usage: (() => {
      normalizeUsage(usage || {});
      return {
        input_tokens: usage?.inputTokens ?? 0,
        output_tokens: usage?.outputTokens ?? 0,
        cache_creation_input_tokens: usage?.inputTokenDetails?.cacheWriteTokens ?? null,
        cache_read_input_tokens: usage?.cachedInputTokens ?? 0,
      };
    })(),
  };
}

function convertAnthropicToOpenAI(anthropicReq) {
  // 1. Extract system prompt (top-level, not in messages array).
  // Preserve block form whenever a cache marker is present.
  let systemContent = null;
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemContent = anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      systemContent = hasCacheControl(anthropicReq.system)
        ? toCachedTextBlocks(anthropicReq.system)
        : textContentToString(anthropicReq.system);
    }
  }

  // 2. Build tool name map + convert messages
  const toolNameFromId = {};
  const openaiMessages = [];

  if (systemContent) {
    openaiMessages.push({ role: 'system', content: systemContent });
  }

  const messages = anthropicReq.messages || [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      let textContent = '';
      const textBlocks = [];
      const toolCalls = [];
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
      for (const block of blocks) {
        if (block.type === 'text') {
          textContent += block.text || '';
          textBlocks.push(copyCacheControl({ type: 'text', text: block.text || '' }, block));
        } else if (block.type === 'tool_use') {
          toolNameFromId[block.id] = block.name;
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        }
      }
      const assistantMsg = copyCacheControl({
        role: 'assistant',
        content: hasCacheControl(msg.content, msg.cache_control) ? textBlocks : (textContent || null),
      }, msg);
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      openaiMessages.push(assistantMsg);
    } else if (msg.role === 'user') {
      let textContent = '';
      const contentBlocks = [];
      const toolResults = [];
      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text || '';
            contentBlocks.push(copyCacheControl({ type: 'text', text: block.text || '' }, block));
          } else if (block.type === 'image') {
            const imageUrl = toAnthropicImageUrl(block);
            if (imageUrl) contentBlocks.push(imageUrl);
          } else if (block.type === 'tool_result') {
            toolResults.push(block);
          }
        }
      }
      if (textContent || contentBlocks.length > 0) {
        const useBlocks = Array.isArray(msg.content)
          && (hasCacheControl(msg.content, msg.cache_control) || contentBlocks.some(block => block.type === 'image_url'));
        openaiMessages.push(copyCacheControl({
          role: 'user',
          content: useBlocks ? contentBlocks : textContent,
        }, msg));
      }
      for (const tr of toolResults) {
        const toolContent = typeof tr.content === 'string' ? tr.content
          : Array.isArray(tr.content) ? tr.content.map(c => c.text || '').join('')
          : String(tr.content || '');
        openaiMessages.push(copyCacheControl({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          name: toolNameFromId[tr.tool_use_id] || '',
          content: toolContent,
        }, tr));
      }
    }
  }

  // 3. Build OpenAI request
  const openaiReq = {
    model: anthropicReq.model || 'deepseek/deepseek-v4-flash',
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens || 64000,
    stream: anthropicReq.stream === true,
  };

  // 4. Map tools
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    openaiReq.tools = anthropicReq.tools.map(t => copyCacheControl({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }, t));
  }

  // 5. Map tool_choice
  if (anthropicReq.tool_choice) {
    const tc = anthropicReq.tool_choice;
    if (tc.type === 'auto' || tc.type === undefined) {
      openaiReq.tool_choice = 'auto';
    } else if (tc.type === 'any') {
      openaiReq.tool_choice = 'required';
    } else if (tc.type === 'tool') {
      openaiReq.tool_choice = { type: 'function', function: { name: tc.name } };
    } else if (tc.type === 'none') {
      openaiReq.tool_choice = 'none';
    }
  }

  // 6. Optional params
  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p;
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences;
  if (anthropicReq.metadata?.user_id) openaiReq.user = anthropicReq.metadata.user_id;

  // 7. Anthropic thinking → reasoning_effort（LiteLLM 标准映射）
  if (anthropicReq.thinking) {
    const t = anthropicReq.thinking;
    if (t.type === 'disabled' || t.type === 'none') {
      // 不发送 reasoning_effort
    } else if (t.type === 'adaptive') {
      openaiReq.reasoning_effort = t.effort ?? 'medium';
    } else if (t.budget_tokens !== undefined) {
      if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high';
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium';
      else if (t.budget_tokens >= 2000) openaiReq.reasoning_effort = 'low';
      else openaiReq.reasoning_effort = 'low'; // <2000 → low
    }
  }

  return openaiReq;
}

/**
 * Async generator that reads CC NDJSON response body and yields
 * Anthropic SSE events for streaming.
 */
async function* createAnthropicSseTranslator(response, model, messageId, ctx) {
  let nextBlockIndex = 0;
  let currentBlockIndex = -1;
  let currentBlockType = null;
  let blockStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let stopReason = null;
  let hasError = false;
  let currentThinkingText = ''; // accumulated thinking text for the open block

  // Close the current block (text or thinking) if one is active.
  // Thinking blocks receive a signature_delta before content_block_stop.
  function closeBlock() {
    if (blockStarted) {
      const idx = currentBlockIndex;
      const type = currentBlockType;
      let out = '';
      if (type === 'thinking') {
        out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: fakeThinkingSignature(currentThinkingText) } })}\n\n`;
        currentThinkingText = '';
      }
      blockStarted = false;
      currentBlockType = null;
      return out + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
    }
    return '';
  }
  const closeTextBlock = closeBlock;

  // Open a new block of the given type (closing any previous block first)
  function startBlock(type, contentBlock) {
    if (!blockStarted || currentBlockType !== type) {
      const close = closeBlock();
      currentBlockIndex = nextBlockIndex++;
      currentBlockType = type;
      blockStarted = true;
      return close + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: contentBlock })}\n\n`;
    }
    return '';
  }

  // Open a new text block (closing any previous block first)
  function startTextBlock() {
    return startBlock('text', { type: 'text', text: '' });
  }

  // Open a new thinking block (closing any previous block first)
  function startThinkingBlock() {
    return startBlock('thinking', { type: 'thinking', thinking: '' });
  }

  // Emit message_start (always the first event)
  yield `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  })}\n\n`;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), STREAM_IDLE_TIMEOUT_MS)
        ),
      ]);
      const { done, value } = result;
      if (done) break;
      ctx.bytesReceived += value.length;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let hadOutput = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === '[DONE]') continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }
        if (!event.type) continue;
        ctx.lastCcEvent = event.type;

        switch (event.type) {
          case 'start': case 'start-step': case 'text-start': case 'reasoning-start':
            // Signal events, no user-visible data
            break;

          case 'reasoning-delta': {
            // CC reasoning → Anthropic thinking block
            const text = event.text || '';
            if (!text) break;
            const startBlockEvent = startThinkingBlock();
            currentThinkingText += text;
            yield startBlockEvent + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: text } })}\n\n`;
            hadOutput = true;
            break;
          }

          case 'text-delta': {
            const text = event.text || '';
            const startBlock = startTextBlock();
            yield startBlock + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`;
            outputTokens += 1;
            hadOutput = true;
            break;
          }

          case 'tool-call': {
            // Close any pending text block
            const closeBlock = closeTextBlock();
            if (closeBlock) yield closeBlock;

            const id = event.toolCallId || `toolu_${randomUUID().slice(0, 12)}`;
            const name = event.toolName || '';
            const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});

            const tcIndex = nextBlockIndex++;
            yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: tcIndex, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`;
            yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: tcIndex, delta: { type: 'input_json_delta', partial_json: input } })}\n\n`;
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tcIndex })}\n\n`;
            outputTokens += 20;
            break;
          }

          case 'finish-step':
          case 'finish': {
            if (event.finishReason) stopReason = mapAnthropicStopReason(event.finishReason);
            const u = event.totalUsage || event.usage;
            if (u) {
              normalizeUsage(u);
              inputTokens = u.inputTokens ?? inputTokens;
              outputTokens = u.outputTokens ?? outputTokens;
              cachedInputTokens = u.cachedInputTokens ?? cachedInputTokens;
              cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? cacheWriteTokens;
              ctx.inputTokens = inputTokens;
              ctx.outputTokens = outputTokens;
              ctx.cachedInputTokens = cachedInputTokens;
            } else {
              inputTokens = 0;
              outputTokens = 0;
              cachedInputTokens = 0;
              cacheWriteTokens = 0;
              ctx.inputTokens = 0;
              ctx.outputTokens = 0;
              ctx.cachedInputTokens = 0;
            }
            break;
          }

          case 'error': {
            hasError = true;
            const msg = event.error?.message || event.message || 'Unknown CC error';
            yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: msg } })}\n\n`;
            break;
          }

          case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
            // Silent - no user-visible content
            break;
          default:
            log('warn', 'Unknown CC event type', { type: event.type });
            break;
        }
      }
    }

    // Finalize — close pending text block, emit message_delta + message_stop
    if (!hasError) {
      const closeBlock = closeTextBlock();
      if (closeBlock) yield closeBlock;

      // 输出 token 为 0 时记为错误，避免下游异常计费
      if (outputTokens === 0) {
        yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`;
      } else {
        yield `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn' },
          usage: { output_tokens: outputTokens, cache_read_input_tokens: cachedInputTokens, cache_creation_input_tokens: cacheWriteTokens || null, input_tokens: inputTokens },
        })}\n\n`;

        yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
      }
    }
  } finally {
    // 确保流中断时通知上游
    try { reader.cancel(); } catch {}
  }
}


// ── Workers helpers ──────────────────────────────────

function jsonResponse(status, data, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (data && data.retry_after !== undefined) {
    headers['Retry-After'] = String(data.retry_after);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function anthropicErrorResponse(status, type, message, retryAfter) {
  const body = { type: 'error', error: { type, message } };
  const headers = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) {
    body.retry_after = retryAfter;
    headers['Retry-After'] = String(retryAfter);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function withCors(res) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function headerObj(request) {
  const h = {};
  request.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  // also keep original keys used by getApiKey
  h['authorization'] = request.headers.get('authorization') || '';
  h['Authorization'] = h['authorization'];
  h['x-api-key'] = request.headers.get('x-api-key') || '';
  h['X-Api-Key'] = h['x-api-key'];
  h['x-session-id'] = request.headers.get('x-session-id') || undefined;
  h['x-claude-code-session-id'] = request.headers.get('x-claude-code-session-id') || undefined;
  return h;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_SIZE) throw new Error('Request body exceeds 10MB limit');
  return JSON.parse(text);
}

function requestedNonStreamTokens(body) {
  const value = body?.max_tokens ?? body?.max_completion_tokens;
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonStreamLimitMessage() {
  return `Non-streaming requests are limited to ${MAX_NONSTREAM_OUTPUT_TOKENS} output tokens; use stream=true for longer responses`;
}

function linkAbort(clientSignal, abortController) {
  if (!clientSignal) return;
  if (clientSignal.aborted) {
    abortController.abort();
    return;
  }
  clientSignal.addEventListener('abort', () => {
    try { abortController.abort(); } catch {}
  }, { once: true });
}

// ── OpenAI Chat Completions ──────────────────────────

async function handleChatCompletions(request) {
  let openaiReq;
  try {
    openaiReq = await readJson(request);
  } catch {
    return jsonResponse(400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
  }

  const headers = headerObj(request);
  const apiKey = getApiKey(headers) || (CFG.apiKey || null);
  if (!apiKey) {
    return jsonResponse(401, { error: { message: 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header', type: 'auth_error' } });
  }

  await maybeRefreshCCVersion();

  const stream = openaiReq.stream === true;
  const requestedTokens = requestedNonStreamTokens(openaiReq);
  if (!stream && requestedTokens !== null && requestedTokens > MAX_NONSTREAM_OUTPUT_TOKENS) {
    return jsonResponse(400, { error: { message: nonStreamLimitMessage(), type: 'invalid_request_error' } });
  }
  const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
  const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = nowUnix();
  const ccBody = buildCcRequest(openaiReq);

  const abortController = new AbortController();
  linkAbort(request.signal, abortController);

  const startTime = Date.now();
  let bytesReceived = 0;
  let lastCcEvent = '';
  let fullText = '';
  let reader = null;

  try {
    await ensureInitialized(apiKey, abortController.signal);
    const ccResponse = await forwardToCC(ccBody, apiKey, headers, abortController.signal);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error', { status: ccResponse.status });
      const mapped = mapCcError(ccResponse.status, errorText);
      return jsonResponse(mapped.status, mapped.body);
    }

    if (stream) {
      const translator = createSseTranslator(model, completionId, created);
      const decoder = new TextDecoder();
      reader = ccResponse.body.getReader();

      // Buffer until first visible chunk so we can still return JSON 429/502 like Node version
      let lineBuf = '';
      let preEvents = [];
      let gotVisible = false;
      let streamError = null;

      try {
        while (!gotVisible) {
          const result = await Promise.race([
            reader.read(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), STREAM_IDLE_TIMEOUT_MS)
            ),
          ]);
          const { done, value } = result;
          if (done) break;
          bytesReceived += value.length;
          lineBuf += decoder.decode(value, { stream: true });
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop() || '';
          for (const line of lines) {
            const events = translator.parseLine(line);
            if (events) {
              preEvents.push(...events);
              gotVisible = true;
            }
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
          }
        }
      } catch (e) {
        streamError = e;
      }

      if (streamError) {
        try { reader.cancel(); } catch {}
        try { abortController.abort(); } catch {}
        if (streamError.message === 'STREAM_IDLE_TIMEOUT') {
          consecutiveTimeouts++;
          const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
            ? 'Response timeout - try reducing context length (summarize earlier messages)'
            : 'Response timeout - request timed out';
          return jsonResponse(429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
        }
        return jsonResponse(502, { error: { message: `Upstream error: ${streamError.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
      }

      // Stream ended during pre-buffer with no visible output
      if (!gotVisible) {
        if (lineBuf.trim()) {
          const events = translator.parseLine(lineBuf);
          if (events) { preEvents.push(...events); gotVisible = true; }
          lineBuf = '';
        }
        if (translator.outputTokens === 0 && preEvents.length === 0) {
          try { abortController.abort(); } catch {}
          return jsonResponse(429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
        }
      }

      const body = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const push = (s) => controller.enqueue(enc.encode(s));
          try {
            for (const evt of preEvents) push(evt);
            let lastKeepaliveAt = Date.now();

            // continue reading
            while (true) {
              if (abortController.signal.aborted) break;
              const result = await Promise.race([
                reader.read(),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), STREAM_IDLE_TIMEOUT_MS)
                ),
              ]);
              const { done, value } = result;
              if (done) break;
              bytesReceived += value.length;
              lineBuf += decoder.decode(value, { stream: true });
              const lines = lineBuf.split('\n');
              lineBuf = lines.pop() || '';
              let hadOutput = false;
              for (const line of lines) {
                const events = translator.parseLine(line);
                if (events) {
                  for (const evt of events) push(evt);
                  hadOutput = true;
                }
                if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
              }
              // 仅在静默超过间隔时发 SSE comment，防止客户端超时；不再每个 silent chunk 都刷
              if (!hadOutput && Date.now() - lastKeepaliveAt >= SSE_KEEPALIVE_INTERVAL_MS) {
                push(': keepalive\n\n');
                lastKeepaliveAt = Date.now();
              }
            }

            if (lineBuf.trim()) {
              const events = translator.parseLine(lineBuf);
              if (events) for (const evt of events) push(evt);
            }

            if (translator.outputTokens === 0) {
              try { abortController.abort(); } catch {}
              logUsage({
                path: '/v1/chat/completions',
                model,
                stream: true,
                id: completionId,
                usage: {
                  inputTokens: translator.inputTokens,
                  outputTokens: translator.outputTokens,
                  cachedInputTokens: translator.cachedInputTokens,
                },
                elapsedMs: Date.now() - startTime,
                bytesReceived,
                status: 'empty_output',
              });
              push(`data: ${JSON.stringify({ error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })}\n\n`);
            } else {
              consecutiveTimeouts = 0;
              logUsage({
                path: '/v1/chat/completions',
                model,
                stream: true,
                id: completionId,
                usage: {
                  inputTokens: translator.inputTokens,
                  outputTokens: translator.outputTokens,
                  cachedInputTokens: translator.cachedInputTokens,
                },
                elapsedMs: Date.now() - startTime,
                bytesReceived,
                status: 'ok',
              });
              push(translator.getDoneEvent());
            }
          } catch (e) {
            if (abortController.signal.aborted) {
              // client gone
            } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
              log('warn', 'Stream idle timeout', {
                path: '/v1/chat/completions', model, streaming: true,
                timeoutMs: STREAM_IDLE_TIMEOUT_MS, elapsedMs: Date.now() - startTime,
                id: completionId, bytesReceived, lastCcEvent: lastCcEvent || '(none)',
              });
              try { abortController.abort(); } catch {}
              consecutiveTimeouts++;
              const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
                ? 'Response timeout - try reducing context length (summarize earlier messages)'
                : 'Response timeout - request timed out';
              push(`data: ${JSON.stringify({ error: { message: timeoutMsg, type: 'rate_limit_error' }, retry_after: 5 })}\n\n`);
            } else {
              log('error', 'Stream error', { message: e.message });
              try { abortController.abort(); } catch {}
              push(`data: ${JSON.stringify({ error: { message: e.message, type: 'proxy_error' } })}\n\n`);
            }
          } finally {
            try { reader.cancel(); } catch {}
            try { controller.close(); } catch {}
          }
        },
        cancel() {
          try { abortController.abort(); } catch {}
          try { reader?.cancel(); } catch {}
        },
      });

      return new Response(body, { status: 200, headers: sseHeaders() });
    }

    // ── non-stream ──
    let reasoningContent = '';
    let finishReason = 'stop';
    let usage = null;
    let toolCalls = null;
    reader = ccResponse.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    const processLines = () => {
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
        try {
          const event = JSON.parse(trimmed);
          switch (event.type) {
            case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
            case 'reasoning-delta': lastCcEvent = event.type; reasoningContent += event.text || ''; break;
            case 'tool-call':
              lastCcEvent = event.type;
              toolCalls = toolCalls || [];
              toolCalls.push({
                id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                type: 'function',
                function: {
                  name: event.toolName || '',
                  arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                },
              });
              break;
            case 'finish':
              lastCcEvent = event.type;
              finishReason = mapFinishReason(event.finishReason || 'stop');
              if (event.totalUsage) usage = event.totalUsage;
              break;
            case 'error':
              lastCcEvent = event.type;
              log('warn', 'CC stream error (non-stream)', { message: event.error?.message || event.message });
              break;
            case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
              break;
            default:
              log('warn', 'Unknown CC event type', { type: event.type });
              break;
          }
        } catch {}
      }
    };

    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), NONSTREAM_IDLE_TIMEOUT_MS)
        ),
      ]);
      const { done, value } = result;
      if (done) break;
      bytesReceived += value.length;
      buf += decoder.decode(value, { stream: true });
      processLines();
    }
    processLines();

    if ((usage?.outputTokens ?? 0) === 0) {
      try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
      return jsonResponse(429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
    }

    consecutiveTimeouts = 0;
    if (!usage) usage = {};
    normalizeUsage(usage);
    logUsage({
      path: '/v1/chat/completions',
      model,
      stream: false,
      id: completionId,
      usage,
      elapsedMs: Date.now() - startTime,
      bytesReceived,
      finishReason,
      status: 'ok',
    });
    return jsonResponse(200, {
      id: completionId,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: Object.assign(
          { role: 'assistant', content: fullText || null },
          toolCalls ? { tool_calls: toolCalls } : {},
          reasoningContent ? { reasoning_content: reasoningContent } : {},
        ),
        finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
      },
    });
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled', { path: '/v1/chat/completions', model, completionId });
      return jsonResponse(499, { error: { message: 'Client disconnected', type: 'cancelled' } });
    }
    if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/chat/completions', model, streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS, elapsedMs: Date.now() - startTime,
        id: completionId, bytesReceived, lastCcEvent: lastCcEvent || '(none)',
      });
      try { reader?.cancel(); } catch {}
      try { abortController.abort(); } catch {}
      consecutiveTimeouts++;
      const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
        ? 'Response timeout - try reducing context length (summarize earlier messages)'
        : 'Response timeout - request timed out';
      return jsonResponse(429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
    }
    log('error', 'Upstream error', { message: e.message });
    try { abortController.abort(); } catch {}
    return jsonResponse(502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
  }
}

// ── Anthropic Messages ───────────────────────────────

async function handleMessages(request) {
  let anthropicReq;
  try {
    anthropicReq = await readJson(request);
  } catch {
    return anthropicErrorResponse(400, 'invalid_request_error', 'Invalid JSON body');
  }

  const headers = headerObj(request);
  const apiKey = getApiKey(headers) || (CFG.apiKey || null);
  if (!apiKey) {
    return jsonResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header' } });
  }

  await maybeRefreshCCVersion();

  const stream = anthropicReq.stream === true;
  const requestedTokens = requestedNonStreamTokens(anthropicReq);
  if (!stream && requestedTokens !== null && requestedTokens > MAX_NONSTREAM_OUTPUT_TOKENS) {
    return anthropicErrorResponse(400, 'invalid_request_error', nonStreamLimitMessage());
  }
  const model = anthropicReq.model || 'claude-sonnet-4-6';
  const openaiReq = convertAnthropicToOpenAI(anthropicReq);
  const ccBody = buildCcRequest(openaiReq);

  const abortController = new AbortController();
  linkAbort(request.signal, abortController);

  const startTime = Date.now();
  let messageId = '';
  let reader = null;
  let bytesReceived = 0;
  let lastCcEvent = '';
  let fullText = '';

  try {
    await ensureInitialized(apiKey, abortController.signal);
    const ccResponse = await forwardToCC(ccBody, apiKey, headers, abortController.signal);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error (Anthropic)', { status: ccResponse.status });
      const mapped = mapCcError(ccResponse.status, errorText);
      return anthropicErrorResponse(mapped.status, mapped.body.error.type, mapped.body.error.message);
    }

    if (stream) {
      messageId = 'msg_' + randomUUID().slice(0, 12);
      const ctx = { bytesReceived: 0, lastCcEvent: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

      // Pre-buffer until first visible content
      const generator = createAnthropicSseTranslator(ccResponse, model, messageId, ctx);
      const pre = [];
      let gotVisible = false;
      let genError = null;
      let genDone = false;
      let gen = generator[Symbol.asyncIterator]();

      try {
        while (!gotVisible) {
          const step = await Promise.race([
            gen.next(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), STREAM_IDLE_TIMEOUT_MS)
            ),
          ]);
          if (step.done) { genDone = true; break; }
          const event = step.value;
          pre.push(event);
          if (event.includes('"text_delta"') || event.includes('"thinking_delta"') || event.includes('"tool_use"')) gotVisible = true;
        }
      } catch (e) {
        genError = e;
      }

      if (genError) {
        try { abortController.abort(); } catch {}
        if (genError.message === 'STREAM_IDLE_TIMEOUT') {
          consecutiveTimeouts++;
          const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
            ? 'Response timeout - try reducing context length (summarize earlier messages)'
            : 'Response timeout - request timed out';
          return anthropicErrorResponse(429, 'rate_limit_error', timeoutMsg, 5);
        }
        return anthropicErrorResponse(502, 'proxy_error', `Upstream error: ${genError.message}`, 10);
      }

      if (!gotVisible && ctx.outputTokens === 0) {
        // finished without content
        const hasErrorEvent = pre.some(e => e.includes('"type":"error"') || e.includes('"type": "error"'));
        if (!hasErrorEvent) {
          try { abortController.abort(); } catch {}
          return anthropicErrorResponse(429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
        }
      }

      const body = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const push = (s) => controller.enqueue(enc.encode(s));
          try {
            for (const ev of pre) push(ev);
            if (!genDone) {
              while (true) {
                if (abortController.signal.aborted) break;
                const step = await gen.next();
                if (step.done) break;
                push(step.value);
              }
            }
            consecutiveTimeouts = 0;
            logUsage({
              path: '/v1/messages',
              model,
              stream: true,
              id: messageId,
              usage: {
                inputTokens: ctx.inputTokens,
                outputTokens: ctx.outputTokens,
                cachedInputTokens: ctx.cachedInputTokens,
              },
              elapsedMs: Date.now() - startTime,
              bytesReceived: ctx.bytesReceived,
              status: (ctx.outputTokens ?? 0) === 0 ? 'empty_output' : 'ok',
            });
          } catch (e) {
            if (abortController.signal.aborted) {
              // ignore
            } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
              log('warn', 'Stream idle timeout', {
                path: '/v1/messages', model, streaming: true,
                timeoutMs: STREAM_IDLE_TIMEOUT_MS, elapsedMs: Date.now() - startTime, id: messageId,
              });
              try { abortController.abort(); } catch {}
              consecutiveTimeouts++;
              const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
                ? 'Response timeout - try reducing context length (summarize earlier messages)'
                : 'Response timeout - request timed out';
              push(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: timeoutMsg }, retry_after: 5 })}\n\n`);
            } else {
              log('error', 'Anthropic stream error', { message: e.message });
              try { abortController.abort(); } catch {}
              push(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: e.message } })}\n\n`);
            }
          } finally {
            try { controller.close(); } catch {}
          }
        },
        cancel() {
          try { abortController.abort(); } catch {}
        },
      });

      return new Response(body, { status: 200, headers: sseHeaders() });
    }

    // non-stream Anthropic
    messageId = 'msg_' + randomUUID().slice(0, 12);
    let finishReason = 'stop';
    let usage = null;
    let toolCalls = null;
    let thinkingText = ''; // CC reasoning → Anthropic thinking block
    reader = ccResponse.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    const processLines = () => {
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === '[DONE]') continue;
        try {
          const event = JSON.parse(trimmed);
          switch (event.type) {
            case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
            case 'reasoning-delta': lastCcEvent = event.type; thinkingText += event.text || ''; break;
            case 'tool-call':
              lastCcEvent = event.type;
              (toolCalls = toolCalls || []).push({
                id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                type: 'function',
                function: {
                  name: event.toolName || '',
                  arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                },
              });
              break;
            case 'finish':
              lastCcEvent = event.type;
              finishReason = mapFinishReason(event.finishReason || 'stop');
              if (event.totalUsage) usage = event.totalUsage;
              break;
            case 'error':
              lastCcEvent = event.type;
              log('warn', 'CC error (Anthropic non-stream)', { message: event.error?.message || event.message });
              break;
            case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
              break;
            default:
              log('warn', 'Unknown CC event type', { type: event.type });
              break;
          }
        } catch {}
      }
    };

    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), NONSTREAM_IDLE_TIMEOUT_MS)
        ),
      ]);
      const { done, value } = result;
      if (done) break;
      bytesReceived += value.length;
      buf += decoder.decode(value, { stream: true });
      processLines();
    }
    processLines();

    if ((usage?.outputTokens ?? 0) === 0) {
      try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
      return anthropicErrorResponse(429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
    }

    consecutiveTimeouts = 0;
    if (!usage) usage = {};
    normalizeUsage(usage);
    logUsage({
      path: '/v1/messages',
      model,
      stream: false,
      id: messageId,
      usage,
      elapsedMs: Date.now() - startTime,
      bytesReceived,
      finishReason,
      status: 'ok',
    });
    return jsonResponse(200, buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText));
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled', { path: '/v1/messages', model, messageId });
      return anthropicErrorResponse(499, 'cancelled', 'Client disconnected');
    }
    if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/messages', model, streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS, elapsedMs: Date.now() - startTime, id: messageId,
      });
      try { reader?.cancel(); } catch {}
      try { abortController.abort(); } catch {}
      consecutiveTimeouts++;
      const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
        ? 'Response timeout - try reducing context length (summarize earlier messages)'
        : 'Response timeout - request timed out';
      return anthropicErrorResponse(429, 'rate_limit_error', timeoutMsg, 5);
    }
    log('error', 'Upstream error', { message: e.message });
    try { abortController.abort(); } catch {}
    return anthropicErrorResponse(502, 'proxy_error', `Upstream error: ${e.message}`, 10);
  }
}

// ── 动态模型列表 ────────────────────────────────────

let dynamicModels = null;
let modelsLastFetch = 0;

async function fetchModels(apiKey) {
  const now = Date.now();
  if (dynamicModels && (now - modelsLastFetch) < CFG.modelRefreshIntervalMs) {
    return dynamicModels;
  }

  try {
    if (!apiKey || !CFG.useProviderModels) throw new Error('Provider models disabled');

    const response = await fetch(`${CFG.apiBase}/provider/v1/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'x-cli-environment': 'production',
        'x-command-code-version': CC_VERSION,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.data)) {
        dynamicModels = data.data.map(m => ({
          id: m.id,
          name: m.id,
        }));
        modelsLastFetch = now;
        log('info', 'Fetched models from Provider API', { count: dynamicModels.length });
        return dynamicModels;
      }
    }
    log('warn', 'Provider models fetch failed, using hardcoded list', { status: response.status });
  } catch (e) {
    log('warn', 'Provider models fetch error, using hardcoded list', { error: e.message });
  }

  return MODELS;
}

async function handleModels(request) {
  const headers = headerObj(request);
  const apiKey = getApiKey(headers) || CFG.apiKey || null;
  await maybeRefreshCCVersion();
  const models = await fetchModels(apiKey);
  const now = nowUnix();
  return jsonResponse(200, {
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: now,
      owned_by: 'command-code',
    })),
  });
}

// ── Worker entry ─────────────────────────────────────

export default {
  async fetch(request, env) {
    CFG = loadConfig(env || {});

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    let res;
    try {
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        res = await handleChatCompletions(request);
      } else if (url.pathname === '/v1/messages' && request.method === 'POST') {
        res = await handleMessages(request);
      } else if (url.pathname === '/v1/models' && request.method === 'GET') {
        res = await handleModels(request);
      } else if (url.pathname === '/health' || url.pathname === '/') {
        res = new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      } else {
        res = jsonResponse(404, { error: { message: 'Not found', type: 'not_found' } });
      }
    } catch (e) {
      log('error', 'Unhandled', { message: e.message });
      res = jsonResponse(500, { error: { message: e.message, type: 'internal_error' } });
    }
    return withCors(res);
  },
};
