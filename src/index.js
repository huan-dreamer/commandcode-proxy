/**
 * Cloudflare Workers — Command Code → OpenAI/Anthropic 兼容代理
 * 状态默认使用 isolate 内存缓存；配置 CC_STATE KV 后可跨冷启动/实例稳定复用
 *
 * Credit: protocol & proxy logic adapted from
 *   https://github.com/MAXeaglet/commandcode-proxy (MIT, © MAXeaglet)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';


const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB — 请求体大小上限
const STREAM_IDLE_TIMEOUT_MS = 30000;   // 30s — 流式无新数据中断（默认值）
const NONSTREAM_IDLE_TIMEOUT_MS = 90000; // 90s — 非流式超时更宽容（默认值）
const SSE_KEEPALIVE_INTERVAL_MS = 15000; // 15s — 静默期才发 keepalive，避免刷屏
const DEFAULT_MAX_TOKENS = 64000;
const MAX_NONSTREAM_OUTPUT_TOKENS = 16384; // 非流式保护上限，长输出请使用 stream=true


// ── 配置（Workers env） ───────────────────────────
function loadConfig(env = {}) {
  return {
    apiBase: env.CC_API_BASE || 'https://api.commandcode.ai',
    projectSlug: env.PROJECT_SLUG || 'cc-proxy',
    apiKey: env.CC_API_KEY || '',
    logLevel: env.LOG_LEVEL || 'info',
    useProviderModels: env.CC_USE_PROVIDER_MODELS !== 'false',
    // off | always：上游报 "JSON Schema reference expansion is too large" 时可设为 always
    schemaSlimming: env.CC_SCHEMA_SLIM === 'always' ? 'always' : 'off',
    modelRefreshIntervalMs: parseInt(env.MODEL_REFRESH_INTERVAL_MS || String(5 * 60 * 1000), 10),
    // 空闲超时可按部署调整：上游较慢时可放宽，想更快失败时可收紧。
    streamIdleTimeoutMs: parseInt(env.CC_STREAM_IDLE_TIMEOUT_MS || String(STREAM_IDLE_TIMEOUT_MS), 10),
    nonstreamIdleTimeoutMs: parseInt(env.CC_NONSTREAM_IDLE_TIMEOUT_MS || String(NONSTREAM_IDLE_TIMEOUT_MS), 10),
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
      ccVersionResolved = true;
      log('info', 'CC Version refreshed from npm', { version: CC_VERSION });
    }
  } catch (e) {
    log('warn', 'CC Version fetch failed, using current', { version: CC_VERSION, error: e.message });
  }
}
// Workers: no setInterval — lazy refresh on demand (see maybeRefreshCCVersion)
let ccVersionLastFetch = 0;
let ccVersionResolved = false;
// 首次失败后的重试间隔。原先用「版本号仍是兜底值」判断，会在 registry 不可达时
// 变成每个请求都重试一次（白白多一个子请求），这里改成显式的短退避。
const CC_VERSION_RETRY_MS = 10 * 60 * 1000;

async function maybeRefreshCCVersion() {
  const now = Date.now();
  const window = ccVersionResolved ? CC_VERSION_REFRESH_MS : CC_VERSION_RETRY_MS;
  if (now - ccVersionLastFetch < window) return;
  ccVersionLastFetch = now;
  await refreshCCVersion();
}



// 连续超时计数：连续 3 次超时才提醒压缩上下文，任意成功请求后重置
let consecutiveTimeouts = 0;
const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3;

// ── 日志 ─────────────────────────────────────────────
function log(level, msg, data) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
}

// ── 流式解析工具（CPU 敏感路径） ─────────────────────
// 原实现在每次 reader.read() 前都新建一个 setTimeout 做竞速，而且从不清理。
// 一个流式请求会泄漏大量定时器（真实的上游往往每 token 一次 flush，很容易上千个），
// 它们在 30s/90s 后集中触发：既白烧 CPU，又产生无人处理的 rejection。
// Workers 的 "Exceeded timeout / CPU time limit" 常见成因就在这里。
//
// 现在改为"单个看门狗"：整个响应只保留 1 个定时器，仅在真正静默时才触发。
// 静默超时后取消 reader，挂起的 read() 会以 done 结束，由调用方按超时处理。
function createIdleWatcher(timeoutMs, onIdle) {
  let timer = null;
  let last = Date.now();
  let closed = false;   // 本次响应已结束
  let paused = false;   // 正在等客户端拉取，而不是等上游
  let fired = false;

  function check() {
    timer = null;
    if (closed) return;
    // 等客户端时不算空闲：客户端慢 ≠ 上游卡住。
    // 定时器不销毁重建，只是退化成低频轮询（每个超时周期一次），避免每个 pull 都新建定时器。
    if (paused) {
      timer = setTimeout(check, timeoutMs);
      return;
    }
    const idle = Date.now() - last;
    if (idle >= timeoutMs) {
      fired = true;
      closed = true;
      if (onIdle) onIdle();
      return;
    }
    timer = setTimeout(check, timeoutMs - idle);
  }
  timer = setTimeout(check, timeoutMs);

  return {
    /** 开始等上游数据（或收到数据）时调用 */
    resume() {
      if (closed) return;
      paused = false;
      last = Date.now();
      if (timer === null) timer = setTimeout(check, timeoutMs);
    },
    /** 把数据交给客户端、等待它继续拉取时调用 */
    pause() {
      paused = true;
    },
    /** 收到数据时调用，重置静默计时 */
    touch() {
      if (!closed) last = Date.now();
    },
    stop() {
      closed = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    },
    get timedOut() { return fired; },
  };
}

/**
 * 静默关闭 reader。
 * 注意：cancel() 返回 Promise，`try { reader.cancel() } catch {}` 抓不到它的 rejection。
 * abort 之后它会以 AbortError 拒绝，变成 unhandledRejection（Workers 也会把它记成错误日志）。
 */
function cancelReader(reader) {
  if (!reader) return;
  try {
    const p = reader.cancel();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // 同步抛错（流已关闭等）同样忽略
  }
}

/** 读一块数据并重置看门狗；不产生额外的 Promise */
async function readStream(reader, watcher) {
  const result = await reader.read();
  watcher.touch();
  return result;
}

// 增量行缓冲：只扫描新到达的字节，不再对整块缓冲区反复 split()/indexOf()，
// 避免大 NDJSON 行（工具调用参数等）导致的 O(n²) 扫描。
class LineBuffer {
  constructor() {
    this.buf = '';
    this.scanned = 0; // 已确认没有换行的前缀长度，避免重复扫描
  }

  /** 追加文本，返回本次凑齐的所有完整行 */
  push(text) {
    this.buf += text;
    const lines = [];
    let start = 0;
    let idx = this.buf.indexOf('\n', this.scanned);
    while (idx !== -1) {
      lines.push(this.buf.slice(start, idx));
      start = idx + 1;
      idx = this.buf.indexOf('\n', start);
    }
    if (start > 0) {
      this.buf = this.buf.slice(start);
      this.scanned = 0;
    } else {
      this.scanned = this.buf.length;
    }
    return lines;
  }

  /** 流结束时取出残余（可能是未以 \n 结尾的最后一行） */
  drain() {
    const rest = this.buf;
    this.buf = '';
    this.scanned = 0;
    return rest ? [rest] : [];
  }
}

// 常见且无用户可见内容的 CC 事件，直接跳过，不做任何分配。
const CC_SILENT_EVENTS = new Set([
  'start', 'start-step', 'text-start', 'text-end',
  'reasoning-start', 'reasoning-end', 'provider-metadata',
  'tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-error',
]);

// 未知事件类型只记录一次：若某事件每个 chunk 都出现，逐条 log() 会同时打满
// CPU 与日志配额（wrangler 上 invocation_logs 是开启的）。
const seenUnknownEvents = new Set();
function logUnknownEvent(type) {
  if (seenUnknownEvents.has(type) || seenUnknownEvents.size >= 64) return;
  seenUnknownEvents.add(type);
  log('warn', 'Unknown CC event type', { type });
}

// undici/Workers 的 fetch 失败只给一句 "fetch failed"，真正的原因藏在 cause 里。
// 不把它挖出来，用户只能看到无信息量的报错（比如把 TLS 证书问题误判成网络不通）。
const TLS_FAILURE_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function describeFetchError(e) {
  if (!e) return 'unknown error';
  const cause = e.cause;
  const code = (cause && (cause.code || cause.name)) || '';
  if (cause && TLS_FAILURE_CODES.has(code)) {
    return `${e.message} (${code}: 上游 TLS 证书校验失败，通常是本机根证书库缺少该链的锚点`
      + '，而不是网络不通。本地运行可用 `npm run serve`（会自动合并系统根证书），'
      + '或设置 NODE_EXTRA_CA_CERTS=<系统根证书路径>）';
  }
  if (cause) {
    const detail = [code, cause.message].filter(Boolean).join(' ');
    return detail ? `${e.message}: ${detail}` : e.message;
  }
  return e.message;
}

/** 解析一行上游 NDJSON；非常规行（空行、[DONE]、SSE 注释）返回 null */
function parseCcLine(line) {
  const first = line.charCodeAt(0);
  if (first !== 123 /* { */) {
    if (first === 58 /* : */) return null;
    let end = line.length - 1;
    while (end >= 0 && (line.charCodeAt(end) === 32 || line.charCodeAt(end) === 13 || line.charCodeAt(end) === 9)) end--;
    if (end < 0) return null;
    if (line.charCodeAt(0) === 58) return null;
    if (end === 5 && line.startsWith('[DONE]')) return null;
  }
  try {
    const event = JSON.parse(line);
    return (event && typeof event === 'object' && event.type) ? event : null;
  } catch {
    return null;
  }
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

// ── 工具 schema 瘦身 ────────────────────────────────
// 上游会展开 tools[].input_schema 里的 JSON Schema。客户端（尤其 MCP 工具）常生成
// 深嵌套 + 大量 anyOf 重复分支的 schema，展开后体积爆炸，上游直接拒绝：
//   tools[46]...anyOf[3]...anyOf[1].type JSON Schema reference expansion is too large
// 这里提供可选的裁剪：限制嵌套深度 / anyOf 分支数 / 描述长度，丢掉 $ref 与 $defs
// （无法安全内联，且正是递归膨胀的来源）。
const SLIM_MAX_DEPTH = 8;
const SLIM_MAX_BRANCHES = 8;
const SLIM_MAX_DESCRIPTION = 400;
const SLIM_MAX_TOOL_BYTES = 8 * 1024;
const SLIM_DROP_KEYS = new Set(['$defs', 'definitions', '$schema', '$comment', 'examples', 'title', '$id']);

function slimSchema(node, depth = 0) {
  if (node === null || typeof node !== 'object') return node;
  if (depth >= SLIM_MAX_DEPTH) {
    // 超出深度只保留类型，避免下游继续展开
    return typeof node.type === 'string' ? { type: node.type } : {};
  }
  if (Array.isArray(node)) {
    return node.slice(0, SLIM_MAX_BRANCHES).map((n) => slimSchema(n, depth + 1));
  }
  // $ref 可能递归：替换成"任意值"，打断膨胀链
  if (typeof node.$ref === 'string') return {};

  const out = {};
  for (const key in node) {
    if (SLIM_DROP_KEYS.has(key)) continue;
    const value = node[key];
    if (key === 'description' && typeof value === 'string') {
      out[key] = value.length > SLIM_MAX_DESCRIPTION
        ? value.slice(0, SLIM_MAX_DESCRIPTION) + '…'
        : value;
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      out[key] = value.slice(0, SLIM_MAX_BRANCHES).map((n) => slimSchema(n, depth + 1));
      continue;
    }
    out[key] = slimSchema(value, depth + 1);
  }
  return out;
}

/** 返回裁剪后的 tools 以及体积统计；未开启时只做直通 */
function slimTools(tools) {
  let before = 0;
  let after = 0;
  let changed = 0;
  const out = tools.map((tool) => {
    const schema = tool.input_schema;
    if (!schema || typeof schema !== 'object') return tool;
    const beforeJson = JSON.stringify(schema);
    before += beforeJson.length;
    let slimmed = slimSchema(schema);
    let afterJson = JSON.stringify(slimmed);
    if (afterJson.length > SLIM_MAX_TOOL_BYTES) {
      slimmed = { type: 'object', properties: {} };
      afterJson = JSON.stringify(slimmed);
    }
    after += afterJson.length;
    if (afterJson.length < beforeJson.length) {
      changed++;
      return { ...tool, input_schema: slimmed };
    }
    return tool;
  });
  return { tools: out, changed, before, after };
}

let slimLogged = false;
function logSlimSummary(result) {
  if (slimLogged) return;
  slimLogged = true;
  log('info', 'Tool schemas slimmed', {
    changed: result.changed,
    before_bytes: result.before,
    after_bytes: result.after,
    saved_pct: result.before > 0 ? Math.round((1 - result.after / result.before) * 100) : 0,
  });
}

// 上游因为 schema 过大拒绝时，把"哪个工具最大"直接指出来，省得用户自己猜
let schemaGuidanceLogged = false;
function logSchemaGuidance(body) {
  const tools = body?.params?.tools;
  if (!tools || tools.length === 0) return;
  if (schemaGuidanceLogged) return;
  schemaGuidanceLogged = true;
  const largest = tools
    .map((t) => ({ name: t.name || '?', bytes: JSON.stringify(t.input_schema || {}).length }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3);
  log('warn', 'Upstream rejected tool schemas (JSON Schema expansion too large)', {
    tool_count: tools.length,
    largest,
    hint: '设置 CC_SCHEMA_SLIM=always 让代理裁剪 schema，或减少单次请求携带的工具数量',
  });
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
    const mapped = tools.map(t => copyCacheControl({
      type: t.type || 'function',
      name: t.function?.name || t.name || '',
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
    }, t));
    if (CFG.schemaSlimming === 'always') {
      const slimmed = slimTools(mapped);
      body.params.tools = slimmed.tools;
      logSlimSummary(slimmed);
    } else {
      body.params.tools = mapped;
    }
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
// 性能要点：
//  1) 每个 chunk 的固定 JSON 外壳只拼接一次（HEAD/TAIL），热路径只对 text 做
//     JSON.stringify，避免每个 delta 都构造对象图再整体序列化。
//  2) 同一批上游数据（一次 reader.read()）里的多个 text-delta 合并成 1 个 SSE
//     chunk：上游通常每几十字节 flush 一次，逐条转发会让代理侧的序列化/入队
//     开销放大几十倍，而客户端拿到的仍是连续文本。
function createSseTranslator(model, completionId, created) {
  const HEAD = 'data: {"id":"' + completionId
    + '","object":"chat.completion.chunk","created":' + created
    + ',"model":' + JSON.stringify(model)
    + ',"choices":[{"index":0,"delta":';
  const TAIL = ',"finish_reason":null}]}\n\n';

  let firstChunk = true;
  let pendingText = '';
  let pendingReasoning = '';
  let toolCallIndex = 0;
  let finishReason = null;

  const translator = {
    lastCcEvent: '',
    lastErrorMessage: '',
    schemaError: false,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,

    /** 首个 chunk 需要带 role */
    takeRole() {
      if (!firstChunk) return '';
      firstChunk = false;
      return '"role":"assistant",';
    },

    /** 把累计的 reasoning / text 合并成尽量少的 SSE chunk */
    flushPending() {
      if (!pendingText && !pendingReasoning) return '';
      let out = '';
      if (pendingReasoning) {
        const text = pendingReasoning;
        pendingReasoning = '';
        out += HEAD + '{' + this.takeRole() + '"reasoning_content":' + JSON.stringify(text) + '}' + TAIL;
      }
      if (pendingText) {
        const text = pendingText;
        pendingText = '';
        out += HEAD + '{' + this.takeRole() + '"content":' + JSON.stringify(text) + '}' + TAIL;
      }
      return out;
    },

    /** 解析一行 NDJSON，返回需要发送的 SSE 文本（可能为空） */
    pushLine(line) {
      const event = parseCcLine(line);
      if (!event) return '';
      const type = event.type;
      this.lastCcEvent = type;

      switch (type) {
        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (text) pendingText += text;
          return '';
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (text) pendingReasoning += text;
          return '';
        }

        case 'tool-call': {
          let out = this.flushPending();
          const id = event.toolCallId || ('call_' + created + '_' + toolCallIndex);
          const name = event.toolName || '';
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          const role = this.takeRole();
          out += HEAD + '{' + (role ? role + '"content":null,' : '')
            + '"tool_calls":[{"index":' + toolCallIndex
            + ',"id":' + JSON.stringify(id)
            + ',"type":"function","function":{"name":' + JSON.stringify(name)
            + ',"arguments":' + JSON.stringify(args) + '}}]}' + TAIL;
          toolCallIndex++;
          return out;
        }

        case 'finish-step': {
          if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
          if (event.usage) {
            this.inputTokens = event.usage.inputTokens ?? 0;
            this.outputTokens = event.usage.outputTokens ?? 0;
            this.cachedInputTokens = event.usage.cachedInputTokens ?? 0;
          }
          return '';
        }

        case 'finish': {
          let out = this.flushPending();
          const fr = finishReason || mapFinishReason(event.finishReason || 'stop');
          const u = event.totalUsage || event.usage || {};
          normalizeUsage(u);
          this.inputTokens = u.inputTokens ?? 0;
          this.outputTokens = u.outputTokens ?? 0;
          this.cachedInputTokens = u.cachedInputTokens ?? 0;
          const promptTokens = u.inputTokens ?? 0;
          const completionTokens = u.outputTokens ?? 0;
          out += HEAD + '{},"finish_reason":' + JSON.stringify(fr) + '}],"usage":{'
            + '"prompt_tokens":' + promptTokens
            + ',"completion_tokens":' + completionTokens
            + ',"total_tokens":' + (promptTokens + completionTokens)
            + ',"prompt_tokens_details":{"cached_tokens":' + (u.cachedInputTokens ?? 0)
            + '}}}\n\n';
          return out;
        }

        case 'error': {
          const message = event.error?.message || event.message || 'Unknown error';
          this.lastErrorMessage = message;
          if (message.includes('JSON Schema')) this.schemaError = true;
          log('warn', 'CC stream error', { message });
          // 不发 finish_reason chunk，交给流自然结束处理；
          // 但如果这轮什么都没有产出，收尾时要把这条真实原因告诉客户端。
          return '';
        }

        default: {
          if (!CC_SILENT_EVENTS.has(type)) logUnknownEvent(type);
          return '';
        }
      }
    },

    /** SSE 结束标记 */
    getDoneEvent() {
      return 'data: [DONE]\n\n';
    },
  };

  return translator;
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

// 非流式请求：把上游 NDJSON 完整读进内存后组装。
// 两种协议共用同一份收集逻辑，避免重复的解析循环各自漂移。
async function collectCcStream(response, idleTimeoutMs) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const lineBuf = new LineBuffer();
  const out = {
    text: '',
    reasoning: '',
    toolCalls: null,
    finishReason: 'stop',
    usage: null,
    bytes: 0,
    lastEvent: '',
    sawError: false,
    errorMessage: '',
    schemaError: false,
  };

  const handleLine = (line) => {
    const event = parseCcLine(line);
    if (!event) return;
    const type = event.type;
    out.lastEvent = type;

    switch (type) {
      case 'text-delta':
        out.text += event.text || '';
        break;
      case 'reasoning-delta':
        out.reasoning += event.text || '';
        break;
      case 'tool-call':
        (out.toolCalls || (out.toolCalls = [])).push({
          id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
          type: 'function',
          function: {
            name: event.toolName || '',
            arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
          },
        });
        break;
      case 'finish-step':
        if (event.finishReason) out.finishReason = mapFinishReason(event.finishReason);
        break;
      case 'finish':
        out.finishReason = mapFinishReason(event.finishReason || 'stop');
        if (event.totalUsage) out.usage = event.totalUsage;
        break;
      case 'error': {
        out.sawError = true;
        const message = event.error?.message || event.message || 'Unknown error';
        out.errorMessage = message;
        if (message.includes('JSON Schema')) out.schemaError = true;
        log('warn', 'CC stream error (non-stream)', { message });
        break;
      }
      default:
        if (!CC_SILENT_EVENTS.has(type)) logUnknownEvent(type);
        break;
    }
  };

  const watcher = createIdleWatcher(idleTimeoutMs, () => {
    cancelReader(reader);
  });

  try {
    watcher.resume();
    for (;;) {
      const { done, value } = await readStream(reader, watcher);
      if (done) break;
      out.bytes += value.length;
      const lines = lineBuf.push(decoder.decode(value, { stream: true }));
      for (let i = 0; i < lines.length; i++) handleLine(lines[i]);
    }
    if (watcher.timedOut) throw new Error('STREAM_IDLE_TIMEOUT');
    const rest = lineBuf.drain();
    for (let i = 0; i < rest.length; i++) handleLine(rest[i]);
  } finally {
    watcher.stop();
    cancelReader(reader);
  }

  return out;
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

  // 限流类错误（含 402 余额不足映射来的 429）都带上 Retry-After，
  // 让客户端按退避重试，而不是立刻重打把配额/CPU 一起打满。
  if (mapped.status === 429 || ccStatus === 429) {
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
  let currentThinkingText = ''; // 当前 thinking block 累计的文本，用于签名
  let pendingText = '';
  let pendingThinking = '';

  // 关闭当前 block（text 或 thinking）。
  // thinking block 需要先发 signature_delta 再发 content_block_stop。
  function closeBlock() {
    if (!blockStarted) return '';
    const idx = currentBlockIndex;
    let out = '';
    if (currentBlockType === 'thinking') {
      out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: fakeThinkingSignature(currentThinkingText) } })}\n\n`;
      currentThinkingText = '';
    }
    blockStarted = false;
    currentBlockType = null;
    return out + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
  }

  // 打开指定类型的新 block（先关闭上一个）
  function startBlock(type, contentBlock) {
    if (blockStarted && currentBlockType === type) return '';
    const out = closeBlock();
    currentBlockIndex = nextBlockIndex++;
    currentBlockType = type;
    blockStarted = true;
    return out + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: contentBlock })}\n\n`;
  }

  // 把累计的 thinking / text 合并成尽量少的 delta 事件（同一次上游读取内）
  function flushPending() {
    if (!pendingThinking && !pendingText) return '';
    let out = '';
    if (pendingThinking) {
      const text = pendingThinking;
      pendingThinking = '';
      out += startBlock('thinking', { type: 'thinking', thinking: '' });
      currentThinkingText += text;
      out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: text } })}\n\n`;
    }
    if (pendingText) {
      const text = pendingText;
      pendingText = '';
      out += startBlock('text', { type: 'text', text: '' });
      out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`;
    }
    return out;
  }

  /** 处理一行 NDJSON，返回要发送的 SSE 文本（可能为空） */
  function handleLine(line) {
    const event = parseCcLine(line);
    if (!event) return '';
    ctx.lastCcEvent = event.type;

    switch (event.type) {
      case 'reasoning-delta': {
        // CC reasoning → Anthropic thinking block
        const text = event.text || '';
        if (text) pendingThinking += text;
        return '';
      }

      case 'text-delta': {
        const text = event.text || '';
        if (text) pendingText += text;
        outputTokens += 1;
        return '';
      }

      case 'tool-call': {
        // 先关闭待处理的 text block
        let out = flushPending();
        out += closeBlock();

        const id = event.toolCallId || `toolu_${randomUUID().slice(0, 12)}`;
        const name = event.toolName || '';
        const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});

        const tcIndex = nextBlockIndex++;
        out += `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: tcIndex, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`;
        out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: tcIndex, delta: { type: 'input_json_delta', partial_json: input } })}\n\n`;
        out += `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tcIndex })}\n\n`;
        outputTokens += 20;
        return out;
      }

      case 'finish-step':
      case 'finish': {
        // CC 用的是 'tool-calls'/'length'，先规范成 OpenAI 风格再映射到 Anthropic
        if (event.finishReason) stopReason = mapAnthropicStopReason(mapFinishReason(event.finishReason));
        const u = event.totalUsage || event.usage;
        if (u) {
          normalizeUsage(u);
          inputTokens = u.inputTokens ?? inputTokens;
          outputTokens = u.outputTokens ?? outputTokens;
          cachedInputTokens = u.cachedInputTokens ?? cachedInputTokens;
          cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? cacheWriteTokens;
        } else {
          inputTokens = 0;
          outputTokens = 0;
          cachedInputTokens = 0;
          cacheWriteTokens = 0;
        }
        ctx.inputTokens = inputTokens;
        ctx.outputTokens = outputTokens;
        ctx.cachedInputTokens = cachedInputTokens;
        return '';
      }

      case 'error': {
        hasError = true;
        const msg = event.error?.message || event.message || 'Unknown CC error';
        return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: msg } })}\n\n`;
      }

      default: {
        if (!CC_SILENT_EVENTS.has(event.type)) logUnknownEvent(event.type);
        return '';
      }
    }
  }

  // message_start 永远是第一个事件
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
  const lineBuf = new LineBuffer();
  const watcher = createIdleWatcher(CFG.streamIdleTimeoutMs, () => {
    cancelReader(reader);
  });

  try {
    for (;;) {
      watcher.resume();
      const { done, value } = await readStream(reader, watcher);
      if (done) break;
      ctx.bytesReceived += value.length;
      const lines = lineBuf.push(decoder.decode(value, { stream: true }));
      let out = '';
      for (let i = 0; i < lines.length; i++) out += handleLine(lines[i]);
      out += flushPending();
      if (out) { watcher.pause(); yield out; }
    }
    // 静默超时：交给上层按超时错误处理
    if (watcher.timedOut) throw new Error('STREAM_IDLE_TIMEOUT');

    const rest = lineBuf.drain();
    let tail = '';
    for (let i = 0; i < rest.length; i++) tail += handleLine(rest[i]);
    tail += flushPending();
    if (tail) { yield tail; tail = ''; }

    // 收尾 — 关闭未完成的 block，发 message_delta + message_stop
    if (!hasError) {
      tail += closeBlock();

      // 输出 token 为 0 时记为错误，避免下游异常计费
      if (outputTokens === 0) {
        tail += `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`;
      } else {
        tail += `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn' },
          usage: { output_tokens: outputTokens, cache_read_input_tokens: cachedInputTokens, cache_creation_input_tokens: cacheWriteTokens || null, input_tokens: inputTokens },
        })}\n\n`;

        tail += `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
      }
      if (tail) yield tail;
    }
  } finally {
    watcher.stop();
    // 确保流中断时通知上游
    cancelReader(reader);
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

// 直接在这些 Response 的 headers 上加 CORS，而不是再造一层
// `new Response(res.body, ...)`：后者会让每个流式响应多经过一次 body 转接。
function withCors(res) {
  try {
    const cors = corsHeaders();
    for (const k in cors) res.headers.set(k, cors[k]);
    return res;
  } catch {
    // 极少数不可变 headers 场景下退回重建
    const headers = new Headers(res.headers);
    const cors = corsHeaders();
    for (const k in cors) headers.set(k, cors[k]);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

function headerObj(request) {
  const h = {};
  // Headers 迭代给出的 key 已经是小写，无需再 toLowerCase() 与多次 get()。
  for (const [k, v] of request.headers) h[k] = v;
  h['Authorization'] = h['authorization'] || '';
  h['X-Api-Key'] = h['x-api-key'] || '';
  h['x-session-id'] = h['x-session-id'] || undefined;
  h['x-claude-code-session-id'] = h['x-claude-code-session-id'] || undefined;
  return h;
}

async function readJson(request) {
  // 先用 Content-Length 挡掉超大请求，避免把整个 body 读成字符串再丢弃；
  // request.json() 走运行时原生解析，比 text() + JSON.parse 少一次大字符串分配。
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_SIZE) throw new Error('Request body exceeds 10MB limit');
  return await request.json();
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

async function handleChatCompletions(request, ctx) {
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

  // 版本号刷新不阻塞首个字节：冷启动时把 npm registry 请求交给 waitUntil，
  // 首请求仍用当前（或兜底）版本号，避免白白拉长响应时间。
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(maybeRefreshCCVersion());
  else await maybeRefreshCCVersion();

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
      const lineBuf = new LineBuffer();
      reader = ccResponse.body.getReader();

      // 单个静默看门狗，贯穿预缓冲与后续转发（不再每次 read 建一个定时器）
      const watcher = createIdleWatcher(CFG.streamIdleTimeoutMs, () => {
        try { abortController.abort(); } catch {}
        cancelReader(reader);
      });

      // 先缓冲到第一段可见内容，这样上游 401/429 之类仍能以 JSON 返回。
      let preEvents = [];
      let gotVisible = false;
      let streamError = null;

      try {
        watcher.resume();
        while (!gotVisible) {
          const { done, value } = await readStream(reader, watcher);
          if (watcher.timedOut) throw new Error('STREAM_IDLE_TIMEOUT');
          if (done) {
            for (const line of lineBuf.drain()) {
              const sse = translator.pushLine(line);
              if (sse) { preEvents.push(sse); gotVisible = true; }
            }
            break;
          }
          bytesReceived += value.length;
          const lines = lineBuf.push(decoder.decode(value, { stream: true }));
          for (let i = 0; i < lines.length; i++) {
            const sse = translator.pushLine(lines[i]);
            if (sse) { preEvents.push(sse); gotVisible = true; }
          }
          const pending = translator.flushPending();
          if (pending) { preEvents.push(pending); gotVisible = true; }
        }
      } catch (e) {
        streamError = e;
      }

      if (streamError) {
        watcher.stop();
        cancelReader(reader);
        try { abortController.abort(); } catch {}
        if (streamError.message === 'STREAM_IDLE_TIMEOUT') {
          consecutiveTimeouts++;
          const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
            ? 'Response timeout - try reducing context length (summarize earlier messages)'
            : 'Response timeout - request timed out';
          return jsonResponse(429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
        }
        return jsonResponse(502, { error: { message: `Upstream error: ${describeFetchError(streamError)}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
      }

      // 在预缓冲阶段就结束且没有任何可见输出
      if (!gotVisible && translator.outputTokens === 0 && preEvents.length === 0) {
        watcher.stop();
        try { abortController.abort(); } catch {}
        if (translator.lastErrorMessage) {
          // 上游明确拒绝了这次请求：把原因如实返回，而不是伪装成"空响应 + 请重试"。
          // schema 过大是确定性的，用 400 让客户端停止无意义的重试。
          if (translator.schemaError) {
            logSchemaGuidance(ccBody);
            return jsonResponse(400, { error: { message: translator.lastErrorMessage, type: 'invalid_request_error' } });
          }
          return jsonResponse(429, { error: { message: translator.lastErrorMessage, type: 'rate_limit_error' }, retry_after: 10 });
        }
        return jsonResponse(429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
      }

      const enc = new TextEncoder();
      let queue = preEvents;
      let finished = false;
      let lastKeepaliveAt = Date.now();

      // 用 pull 驱动而不是在 start() 里 free-run：拉取方（客户端）慢时形成真实背压，
      // 不会把整段响应囤在 isolate 内存里。
      const body = new ReadableStream({
        async pull(controller) {
          // 有待发送内容时先发出去
          if (queue.length > 0) {
            controller.enqueue(enc.encode(queue.join('')));
            queue = [];
            return;
          }
          if (finished) {
            watcher.stop();
            try { controller.close(); } catch {}
            return;
          }

          watcher.resume();
          try {
            while (queue.length === 0) {
              if (abortController.signal.aborted && !watcher.timedOut) {
                // 客户端断开
                finished = true;
                watcher.stop();
                cancelReader(reader);
                try { controller.close(); } catch {}
                return;
              }

              const { done, value } = await readStream(reader, watcher);

              // 静默超时后 reader.cancel() 会让 read 以 done 结束，这里单独处理
              if (watcher.timedOut) throw new Error('STREAM_IDLE_TIMEOUT');

              if (done) {
                for (const line of lineBuf.drain()) {
                  const sse = translator.pushLine(line);
                  if (sse) queue.push(sse);
                }
                const tail = translator.flushPending();
                if (tail) queue.push(tail);
                finished = true;
                watcher.stop();

                if (translator.outputTokens === 0) {
                  // 输出为 0 记为错误，避免下游按空响应计费
                  try { abortController.abort(); } catch {}
                  if (translator.schemaError) logSchemaGuidance(ccBody);
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
                  queue.push(`data: ${JSON.stringify({
                    error: {
                      message: translator.lastErrorMessage || 'Empty response from upstream (zero output tokens)',
                      type: translator.lastErrorMessage ? 'upstream_error' : 'rate_limit_error',
                    },
                    retry_after: 10,
                  })}\n\n`);
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
                  queue.push(translator.getDoneEvent());
                }
                break;
              }

              bytesReceived += value.length;
              const lines = lineBuf.push(decoder.decode(value, { stream: true }));
              for (let i = 0; i < lines.length; i++) {
                const sse = translator.pushLine(lines[i]);
                if (sse) queue.push(sse);
              }
              const tail = translator.flushPending();
              if (tail) queue.push(tail);

              // 仅在静默超过间隔时发 SSE 注释，防止客户端超时
              if (queue.length === 0 && Date.now() - lastKeepaliveAt >= SSE_KEEPALIVE_INTERVAL_MS) {
                queue.push(': keepalive\n\n');
                lastKeepaliveAt = Date.now();
              }
            }

            if (queue.length > 0) {
              controller.enqueue(enc.encode(queue.join('')));
              queue = [];
            } else if (finished) {
              try { controller.close(); } catch {}
            }
          } catch (e) {
            finished = true;
            watcher.stop();
            cancelReader(reader);
            if (e && e.message === 'STREAM_IDLE_TIMEOUT') {
              log('warn', 'Stream idle timeout', {
                path: '/v1/chat/completions', model, streaming: true,
                timeoutMs: CFG.streamIdleTimeoutMs, elapsedMs: Date.now() - startTime,
                id: completionId, bytesReceived, lastCcEvent: translator.lastCcEvent || '(none)',
              });
              try { abortController.abort(); } catch {}
              consecutiveTimeouts++;
              const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
                ? 'Response timeout - try reducing context length (summarize earlier messages)'
                : 'Response timeout - request timed out';
              queue.push(`data: ${JSON.stringify({ error: { message: timeoutMsg, type: 'rate_limit_error' }, retry_after: 5 })}\n\n`);
            } else if (abortController.signal.aborted) {
              // 客户端已断开，无需再写入错误
              try { controller.close(); } catch {}
              return;
            } else {
              log('error', 'Stream error', { message: describeFetchError(e) });
              try { abortController.abort(); } catch {}
              queue.push(`data: ${JSON.stringify({ error: { message: (e && e.message) || 'upstream error', type: 'proxy_error' } })}\n\n`);
            }
            if (queue.length > 0) {
              controller.enqueue(enc.encode(queue.join('')));
              queue = [];
            }
          } finally {
            // 交出数据后进入等客户端状态，不再计为上游空闲
            watcher.pause();
          }
        },
        cancel() {
          finished = true;
          watcher.stop();
          try { abortController.abort(); } catch {}
          cancelReader(reader);
        },
      });

      // 从返回响应到客户端第一次 pull 之间也在"等客户端"，先暂停空闲计时
      watcher.pause();
      return new Response(body, { status: 200, headers: sseHeaders() });
    }

    // ── non-stream ──
    const collected = await collectCcStream(ccResponse, CFG.nonstreamIdleTimeoutMs);
    bytesReceived = collected.bytes;
    lastCcEvent = collected.lastEvent;
    fullText = collected.text;
    let usage = collected.usage;
    const finishReason = collected.finishReason;

    if ((usage?.outputTokens ?? 0) === 0) {
      try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
      if (collected.schemaError) {
        logSchemaGuidance(ccBody);
        return jsonResponse(400, { error: { message: collected.errorMessage || 'Upstream rejected the request', type: 'invalid_request_error' } });
      }
      return jsonResponse(429, {
        error: {
          message: collected.errorMessage || 'Empty response from upstream (zero output tokens)',
          type: collected.errorMessage ? 'upstream_error' : 'rate_limit_error',
        },
        retry_after: 10,
      });
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
          collected.toolCalls ? { tool_calls: collected.toolCalls } : {},
          collected.reasoning ? { reasoning_content: collected.reasoning } : {},
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
        timeoutMs: CFG.nonstreamIdleTimeoutMs, elapsedMs: Date.now() - startTime,
        id: completionId, bytesReceived, lastCcEvent: lastCcEvent || '(none)',
      });
      cancelReader(reader);
      try { abortController.abort(); } catch {}
      consecutiveTimeouts++;
      const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
        ? 'Response timeout - try reducing context length (summarize earlier messages)'
        : 'Response timeout - request timed out';
      return jsonResponse(429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
    }
    log('error', 'Upstream error', { message: describeFetchError(e) });
    try { abortController.abort(); } catch {}
    return jsonResponse(502, { error: { message: `Upstream error: ${describeFetchError(e)}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
  }
}

// ── Anthropic Messages ───────────────────────────────

async function handleMessages(request, ctx) {
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

  // 版本号刷新不阻塞首个字节：冷启动时把 npm registry 请求交给 waitUntil，
  // 首请求仍用当前（或兜底）版本号，避免白白拉长响应时间。
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(maybeRefreshCCVersion());
  else await maybeRefreshCCVersion();

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

      // 预缓冲到第一段可见内容，保留"上游失败时返回 JSON 错误"的行为
      const generator = createAnthropicSseTranslator(ccResponse, model, messageId, ctx);
      const pre = [];
      let gotVisible = false;
      let genError = null;
      let genDone = false;
      const gen = generator[Symbol.asyncIterator]();

      try {
        while (!gotVisible) {
          const step = await gen.next();
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
        return anthropicErrorResponse(502, 'proxy_error', `Upstream error: ${describeFetchError(genError)}`, 10);
      }

      if (!gotVisible && ctx.outputTokens === 0) {
        // 没有产出就结束了
        const hasErrorEvent = pre.some(e => e.includes('"type":"error"') || e.includes('"type": "error"'));
        if (!hasErrorEvent) {
          try { abortController.abort(); } catch {}
          return anthropicErrorResponse(429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
        }
      }

      const enc = new TextEncoder();
      let finished = genDone;
      let logged = false;

      const finishOnce = () => {
        if (logged) return;
        logged = true;
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
      };

      const body = new ReadableStream({
        async pull(controller) {
          if (pre.length > 0) {
            controller.enqueue(enc.encode(pre.join('')));
            pre.length = 0;
            if (finished) { finishOnce(); try { controller.close(); } catch {} }
            return;
          }
          if (finished) {
            try { controller.close(); } catch {}
            return;
          }
          try {
            if (abortController.signal.aborted) {
              finished = true;
              try { controller.close(); } catch {}
              return;
            }
            const step = await gen.next();
            if (step.done) {
              finished = true;
              finishOnce();
              try { controller.close(); } catch {}
              return;
            }
            controller.enqueue(enc.encode(step.value));
          } catch (e) {
            finished = true;
            try { const p = gen.return(undefined); if (p && p.catch) p.catch(() => {}); } catch {}
            if (abortController.signal.aborted) {
              try { controller.close(); } catch {}
              return;
            }
            let msg;
            if (e && e.message === 'STREAM_IDLE_TIMEOUT') {
              log('warn', 'Stream idle timeout', {
                path: '/v1/messages', model, streaming: true,
                timeoutMs: CFG.streamIdleTimeoutMs, elapsedMs: Date.now() - startTime, id: messageId,
              });
              try { abortController.abort(); } catch {}
              consecutiveTimeouts++;
              const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
                ? 'Response timeout - try reducing context length (summarize earlier messages)'
                : 'Response timeout - request timed out';
              msg = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: timeoutMsg }, retry_after: 5 })}\n\n`;
            } else {
              log('error', 'Anthropic stream error', { message: describeFetchError(e) });
              try { abortController.abort(); } catch {}
              msg = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: (e && e.message) || 'upstream error' } })}\n\n`;
            }
            controller.enqueue(enc.encode(msg));
            try { controller.close(); } catch {}
          }
        },
        cancel() {
          finished = true;
          // 关闭生成器，让它内部的 finally 清理看门狗并取消上游读取
          try { const p = gen.return(undefined); if (p && p.catch) p.catch(() => {}); } catch {}
          try { abortController.abort(); } catch {}
        },
      });

      return new Response(body, { status: 200, headers: sseHeaders() });
    }

    // non-stream Anthropic
    messageId = 'msg_' + randomUUID().slice(0, 12);
    const collected = await collectCcStream(ccResponse, CFG.nonstreamIdleTimeoutMs);
    bytesReceived = collected.bytes;
    lastCcEvent = collected.lastEvent;
    fullText = collected.text;
    let usage = collected.usage;
    const finishReason = collected.finishReason;

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
    return jsonResponse(200, buildAnthropicResponse(model, fullText, collected.toolCalls, finishReason, usage, collected.reasoning));

  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled', { path: '/v1/messages', model, messageId });
      return anthropicErrorResponse(499, 'cancelled', 'Client disconnected');
    }
    if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/messages', model, streaming: false,
        timeoutMs: CFG.nonstreamIdleTimeoutMs, elapsedMs: Date.now() - startTime, id: messageId,
      });
      cancelReader(reader);
      try { abortController.abort(); } catch {}
      consecutiveTimeouts++;
      const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
        ? 'Response timeout - try reducing context length (summarize earlier messages)'
        : 'Response timeout - request timed out';
      return anthropicErrorResponse(429, 'rate_limit_error', timeoutMsg, 5);
    }
    log('error', 'Upstream error', { message: describeFetchError(e) });
    try { abortController.abort(); } catch {}
    return anthropicErrorResponse(502, 'proxy_error', `Upstream error: ${describeFetchError(e)}`, 10);
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

async function handleModels(request, ctx) {
  const headers = headerObj(request);
  const apiKey = getApiKey(headers) || CFG.apiKey || null;
  // 版本号刷新不阻塞首个字节：冷启动时把 npm registry 请求交给 waitUntil，
  // 首请求仍用当前（或兜底）版本号，避免白白拉长响应时间。
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(maybeRefreshCCVersion());
  else await maybeRefreshCCVersion();
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
  async fetch(request, env, ctx) {
    CFG = loadConfig(env || {});

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    let res;
    try {
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        res = await handleChatCompletions(request, ctx);
      } else if (url.pathname === '/v1/messages' && request.method === 'POST') {
        res = await handleMessages(request, ctx);
      } else if (url.pathname === '/v1/models' && request.method === 'GET') {
        res = await handleModels(request, ctx);
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
