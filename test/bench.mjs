/**
 * Local benchmark harness for src/index.js.
 *
 * Runs the Worker module in Node (Node 22 has the same fetch/streams/crypto
 * surface the Worker uses), stubs upstream with a synthetic NDJSON stream and
 * reports CPU time plus timer/promise behaviour.
 *
 *   node test/bench.mjs            # stream benchmark
 *   node test/bench.mjs nonstream
 */

const MODE = process.argv[2] || 'stream';
const EVENTS = Number(process.env.EVENTS || 4000);       // text-delta count
const FLUSH = Number(process.env.FLUSH || 4096);          // upstream flush bytes

// ── timer accounting: catches uncleared setTimeout leaks ─────────────
let timersCreated = 0;
let timersCleared = 0;
let timersFired = 0;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  timersCreated++;
  const id = realSetTimeout(() => { timersFired++; fn(); }, ms, ...rest);
  id.__mine = true;
  return id;
};
globalThis.clearTimeout = (id) => {
  if (id && id.__mine) timersCleared++;
  return realClearTimeout(id);
};

// ── synthetic upstream NDJSON ───────────────────────────────────────
function makeUpstreamBody() {
  const enc = new TextEncoder();
  let pending = '';
  let i = 0;
  let phase = 0; // 0 = reasoning, 1 = text, 2 = tool-call, 3 = finish
  const toolCalls = Number(process.env.TOOLCALLS || 0);

  return new ReadableStream({
    pull(controller) {
      let out = '';
      while (out.length < FLUSH) {
        if (phase === 0) {
          pending = JSON.stringify({ type: 'reasoning-delta', text: 'thinking about it ' }) + '\n';
          if (++i > EVENTS * 0.1) { phase = 1; i = 0; }
        } else if (phase === 1) {
          pending = JSON.stringify({ type: 'text-delta', text: 'lorem ipsum dolor sit amet ' }) + '\n';
          if (++i >= EVENTS) { phase = toolCalls > 0 ? 2 : 3; i = 0; }
        } else if (phase === 2) {
          pending = JSON.stringify({
            type: 'tool-call',
            toolCallId: 'call_' + i,
            toolName: 'read_file',
            input: { path: '/tmp/' + i + '.txt', note: 'x'.repeat(64) },
          }) + '\n';
          if (++i >= toolCalls) phase = 3;
        } else {
          pending = JSON.stringify({
            type: 'finish',
            finishReason: toolCalls > 0 ? 'tool-calls' : 'stop',
            totalUsage: { inputTokens: 1234, outputTokens: EVENTS, cachedInputTokens: 400 },
          }) + '\n';
          out += pending;
          controller.enqueue(enc.encode(out));
          controller.close();
          return;
        }
        out += pending;
      }
      controller.enqueue(enc.encode(out));
    },
  });
}

// first byte(s) must be the "start" signal like the real API
function makeRealisticBody() {
  const enc = new TextEncoder();
  const base = makeUpstreamBody().getReader();
  let primed = false;
  return new ReadableStream({
    async pull(controller) {
      if (!primed) {
        primed = true;
        controller.enqueue(enc.encode(
          JSON.stringify({ type: 'start' }) + '\n' +
          JSON.stringify({ type: 'start-step' }) + '\n' +
          JSON.stringify({ type: 'text-start' }) + '\n',
        ));
        return;
      }
      const { done, value } = await base.read();
      if (done) { controller.close(); return; }
      controller.enqueue(value);
    },
  });
}

globalThis.fetch = async (url) => {
  if (String(url).includes('/alpha/generate')) {
    return new Response(makeRealisticBody(), {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  }
  // fingerprint / lifecycle / npm / models
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

// ── run ─────────────────────────────────────────────────────────────
const { default: worker } = await import('../src/index.js');

const isStream = MODE === 'stream' || MODE === 'anthropic-stream';
const url = MODE.startsWith('anthropic') ? '/v1/messages' : '/v1/chat/completions';
const body = url === '/v1/messages'
  ? {
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      stream: isStream,
      messages: [{ role: 'user', content: 'hello' }],
    }
  : {
      model: 'deepseek/deepseek-v4-flash',
      stream: isStream,
      max_tokens: isStream ? 32000 : 8000,
      messages: [{ role: 'user', content: 'hello' }],
    };

const env = { CC_API_BASE: 'https://api.commandcode.ai', PROJECT_SLUG: 'cc-proxy' };
const req = new Request('https://worker.example' + url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer user_test123' },
  body: JSON.stringify(body),
});

const t0 = process.cpuUsage();
const wall0 = Date.now();
const res = await worker.fetch(req, env);
let bytes = 0;
let sseChunks = 0;

if (res.body) {
  const reader = res.body.getReader();
  const td = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const s = td.decode(value, { stream: true });
    bytes += value.length;
    if (MODE === 'stream' || MODE === 'anthropic-stream') {
      sseChunks += (s.match(/^data: /gm) || []).length + (s.match(/^event: /gm) || []).length;
    } else {
      text += s;
    }
  }
  if (text) {
    const parsed = JSON.parse(text);
    bytes = text.length;
    console.log('  finish_reason:', parsed.choices?.[0]?.finish_reason ?? parsed.stop_reason);
    console.log('  content len :', (parsed.choices?.[0]?.message?.content ?? '').length
      || JSON.stringify(parsed.content?.[0] || {}).length);
    console.log('  tool_calls  :', parsed.choices?.[0]?.message?.tool_calls?.length ?? parsed.content?.filter(c => c.type === 'tool_use').length ?? 0);
  }
}
const cpu = process.cpuUsage(t0);
const wall = Date.now() - wall0;
const cpuMs = (cpu.user + cpu.system) / 1000;

console.log(`\nmode            : ${MODE}`);
console.log(`status          : ${res.status}`);
console.log(`response bytes  : ${bytes}`);
console.log(`sse frames      : ${sseChunks}`);
console.log(`wall ms         : ${wall}`);
console.log(`cpu ms          : ${cpuMs.toFixed(1)}`);
console.log(`timers created  : ${timersCreated}`);
console.log(`timers cleared  : ${timersCleared}`);
console.log(`timers fired    : ${timersFired}`);
console.log(`timers leaked   : ${timersCreated - timersCleared - timersFired}`);

// Leaked timers would keep the Node event loop (and a real isolate) alive; the
// Worker runtime drops them at request end, but their firing costs CPU.
realSetTimeout(() => process.exit(0), 25);
