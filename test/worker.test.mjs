/**
 * Regression + correctness tests for the Worker.
 *
 *   node --test test/
 *
 * Runs the Worker module directly in Node 22 (same fetch / streams / crypto
 * surface it uses on Cloudflare) with a stubbed upstream.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ── timer accounting ────────────────────────────────────────────────
// 既统计创建/清理次数，也跟踪"仍活着"的定时器集合：
// 一个既不清理也不触发的定时器同样是泄漏（例如被暂停的看门狗），
// 只看 created/cleared/fired 是发现不了的。
const timerStats = { created: 0, cleared: 0, fired: 0 };
const liveTimers = new Set();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  timerStats.created++;
  const id = realSetTimeout(() => {
    timerStats.fired++;
    liveTimers.delete(id);
    fn();
  }, ms, ...rest);
  id.__tracked = true;
  liveTimers.add(id);
  return id;
};
globalThis.clearTimeout = (id) => {
  if (id && id.__tracked) {
    timerStats.cleared++;
    liveTimers.delete(id);
  }
  return realClearTimeout(id);
};

const resetTimers = () => {
  timerStats.created = timerStats.cleared = timerStats.fired = 0;
  liveTimers.clear();
};
/** 断言没有遗留的活定时器（允许一个短暂窗口后复查） */
async function assertNoLiveTimers() {
  if (liveTimers.size !== 0) {
    await new Promise((r) => realSetTimeout(r, 20));
  }
  assert.equal(liveTimers.size, 0,
    `live timers leaked: ${liveTimers.size} (created=${timerStats.created} cleared=${timerStats.cleared} fired=${timerStats.fired})`);
}

// ── upstream stub ───────────────────────────────────────────────────
let upstream = { kind: 'ndjson', text: '' };

function byteStream(text, { chunkSize = 0, stall = false } = {}) {
  const bytes = new TextEncoder().encode(text);
  let pos = 0;
  return new ReadableStream({
    pull(controller) {
      if (stall) return new Promise(() => {}); // 永不产生数据 → 触发空闲超时
      if (pos >= bytes.length) { controller.close(); return; }
      const end = chunkSize > 0 ? Math.min(pos + chunkSize, bytes.length) : bytes.length;
      controller.enqueue(bytes.slice(pos, end));
      pos = end;
    },
  });
}

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/alpha/generate')) {
    return new Response(
      byteStream(upstream.text, upstream.opts || {}),
      { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
    );
  }
  if (u.includes('/provider/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'stub/model-a' }] }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

const { default: worker } = await import('../src/index.js');

let keyCounter = 0;
const freshKey = () => `user_test${++keyCounter}x`;

function waitUntilCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})), pending };
}

async function call(path, body, { key = freshKey(), env = {}, headers = {} } = {}) {
  const ctx = waitUntilCtx();
  const req = new Request('https://worker.example' + path, {
    method: path === '/v1/models' ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...headers,
    },
    body: path === '/v1/models' ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(req, { CC_API_BASE: 'https://api.commandcode.ai', ...env }, ctx);
  const text = await res.text();
  return { res, text, ctx };
}

function parseSse(text) {
  const frames = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const frame = { event: null, data: null, comment: null, raw: block };
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) frame.comment = line;
      else if (line.startsWith('event: ')) frame.event = line.slice(7);
      else if (line.startsWith('data: ')) frame.data = line.slice(6);
    }
    frames.push(frame);
  }
  return frames;
}

const ndjson = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

// 覆盖 JSON 转义：引号、反斜杠、换行、制表符、Unicode、emoji
const TRICKY_TEXT = 'he said "hi"\n\ttab\\slash émoji 🙂 </script> & <tag> 中文';

// ══════════════════════════════════════════════════════════════════
// OpenAI streaming
// ══════════════════════════════════════════════════════════════════
test('openai stream: valid SSE, content and usage round-trip', async () => {
  const parts = ['Hello ', 'brave ', 'new ', 'world'];
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'start' },
    { type: 'start-step' },
    { type: 'text-start' },
    ...parts.map((t) => ({ type: 'text-delta', text: t })),
    { type: 'text-end' },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 } },
  ]), opts: { chunkSize: 17 } };
  resetTimers();

  const { res, text } = await call('/v1/chat/completions', {
    model: 'deepseek/deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');

  const frames = parseSse(text);
  const chunks = [];
  for (const f of frames) {
    if (!f.data) continue;
    if (f.data === '[DONE]') { chunks.push('[DONE]'); continue; }
    const obj = JSON.parse(f.data); // 手工拼的 JSON 必须合法
    assert.equal(obj.object, 'chat.completion.chunk');
    assert.equal(obj.model, 'deepseek/deepseek-v4-flash');
    assert.ok(Array.isArray(obj.choices));
    chunks.push(obj);
  }

  assert.equal(chunks.at(-1), '[DONE]');
  const objects = chunks.filter((c) => typeof c === 'object');
  const content = objects.map((c) => c.choices[0].delta.content || '').join('');
  assert.equal(content, parts.join(''));

  // 首个 chunk 必须带 role
  assert.equal(objects[0].choices[0].delta.role, 'assistant');

  const finishes = objects.filter((c) => c.choices[0].finish_reason !== null);
  assert.equal(finishes.length, 1, 'exactly one finish_reason chunk');
  assert.equal(finishes[0].choices[0].finish_reason, 'stop');
  assert.deepEqual(finishes[0].usage, {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 3 },
  });

  // 每个 SSE 帧都必须以 \n\n 结尾（客户端依赖这个边界）
  assert.ok(text.endsWith('\n\n'));

  // 关键：定时器只按"等待上游数据"的次数创建（不是每个事件一个），且全部清理干净
  assert.ok(timerStats.created <= 40, `unexpected timer churn: ${timerStats.created}`);
  await assertNoLiveTimers();
});

test('openai stream: tricky text/unicode escaping survives JSON round-trip', async () => {
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'text-delta', text: TRICKY_TEXT },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
  ]), opts: { chunkSize: 3 } }; // 逐字节切片，制造跨 UTF-8 边界

  const { text } = await call('/v1/chat/completions', {
    model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }],
  });
  const content = parseSse(text)
    .filter((f) => f.data && f.data !== '[DONE]')
    .map((f) => JSON.parse(f.data).choices[0].delta.content || '')
    .join('');
  assert.equal(content, TRICKY_TEXT);
});

test('openai stream: tool calls and finish_reason=tool_calls', async () => {
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'text-delta', text: 'let me check' },
    { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: { path: '/a b/c.txt' } },
    { type: 'tool-call', toolCallId: 'call_2', toolName: 'grep', input: { pattern: 'x"y' } },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 5, outputTokens: 9 } },
  ]), opts: { chunkSize: 23 } };

  const { text } = await call('/v1/chat/completions', {
    model: 'm', stream: true,
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
  });

  const objs = parseSse(text)
    .filter((f) => f.data && f.data !== '[DONE]')
    .map((f) => JSON.parse(f.data));
  const toolCalls = objs.flatMap((o) => o.choices[0].delta.tool_calls || []);
  assert.equal(toolCalls.length, 2);
  assert.deepEqual(toolCalls.map((t) => t.index), [0, 1]);
  assert.equal(toolCalls[0].id, 'call_1');
  assert.equal(toolCalls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { path: '/a b/c.txt' });
  assert.deepEqual(JSON.parse(toolCalls[1].function.arguments), { pattern: 'x"y' });

  const finish = objs.find((o) => o.choices[0].finish_reason !== null);
  assert.equal(finish.choices[0].finish_reason, 'tool_calls');
});

test('openai stream: reasoning deltas surface as reasoning_content', async () => {
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'reasoning-delta', text: 'think1 ' },
    { type: 'reasoning-delta', text: 'think2' },
    { type: 'text-delta', text: 'answer' },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 2 } },
  ]), opts: { chunkSize: 500 } };

  const { text } = await call('/v1/chat/completions', {
    model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }],
  });
  const objs = parseSse(text).filter((f) => f.data && f.data !== '[DONE]').map((f) => JSON.parse(f.data));
  const reasoning = objs.map((o) => o.choices[0].delta.reasoning_content || '').join('');
  const content = objs.map((o) => o.choices[0].delta.content || '').join('');
  assert.equal(reasoning, 'think1 think2');
  assert.equal(content, 'answer');
});

test('openai stream: zero output tokens yields an error payload, not a silent success', async () => {
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'start' },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 0 } },
  ]), opts: { chunkSize: 10 } };

  const { res, text } = await call('/v1/chat/completions', {
    model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res.status, 200);
  const last = parseSse(text).filter((f) => f.data).at(-1);
  const parsed = JSON.parse(last.data);
  assert.match(parsed.error.message, /zero output tokens/);
  assert.equal(parsed.error.type, 'rate_limit_error');
  await assertNoLiveTimers();
});

test('upstream that ends with no content returns JSON 429 and leaves no live timers', async () => {
  // 完全没有可见输出，也没有 finish 事件 → 走预缓冲失败分支，返回 JSON 429
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'start' },
    { type: 'start-step' },
  ]), opts: { chunkSize: 8 } };
  resetTimers();
  const { res } = await call('/v1/chat/completions', {
    model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res.status, 429);
  await assertNoLiveTimers();
});

// ══════════════════════════════════════════════════════════════════
// Anthropic streaming
// ══════════════════════════════════════════════════════════════════
test('anthropic stream: event sequence, text, thinking signature', async () => {
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'reasoning-delta', text: 'pondering...' },
    { type: 'text-delta', text: 'Answer: ' },
    { type: 'text-delta', text: 'yes' },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 4, outputTokens: 6, cachedInputTokens: 2 } },
  ]), opts: { chunkSize: 13 } };

  const { res, text } = await call('/v1/messages', {
    model: 'claude-sonnet-4-6', max_tokens: 100, stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(res.status, 200);

  const frames = parseSse(text);
  const events = frames.map((f) => f.event).filter(Boolean);
  // 每个 event 都必须带合法 JSON data
  for (const f of frames) {
    if (f.event) assert.doesNotThrow(() => JSON.parse(f.data), `bad json for ${f.event}`);
  }

  assert.equal(events[0], 'message_start');
  assert.equal(events.at(-1), 'message_stop');
  assert.ok(events.includes('content_block_start'));
  assert.ok(events.includes('content_block_stop'));
  const payloads = frames.filter((f) => f.event).map((f) => ({ event: f.event, data: JSON.parse(f.data) }));

  // signature_delta 是 content_block_delta 的 delta.type，不是独立的 SSE event 名
  assert.ok(payloads.some((p) => p.data?.delta?.type === 'signature_delta'));
  const textOut = payloads
    .filter((p) => p.event === 'content_block_delta' && p.data.delta.type === 'text_delta')
    .map((p) => p.data.delta.text).join('');
  assert.equal(textOut, 'Answer: yes');

  const thinking = payloads
    .filter((p) => p.event === 'content_block_delta' && p.data.delta.type === 'thinking_delta')
    .map((p) => p.data.delta.thinking).join('');
  assert.equal(thinking, 'pondering...');

  const sig = payloads.find((p) => p.data?.delta?.type === 'signature_delta');
  assert.ok(sig && typeof sig.data.delta.signature === 'string' && sig.data.delta.signature.length > 0);

  const delta = payloads.find((p) => p.event === 'message_delta');
  assert.equal(delta.data.delta.stop_reason, 'end_turn');
  assert.equal(delta.data.usage.output_tokens, 6);

  await assertNoLiveTimers();
});

test('anthropic stream: tool_use blocks', async () => {
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'text-delta', text: 'calling' },
    { type: 'tool-call', toolCallId: 'tu_1', toolName: 'Bash', input: { cmd: 'ls -la' } },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 3, outputTokens: 8 } },
  ]), opts: { chunkSize: 21 } };

  const { text } = await call('/v1/messages', {
    model: 'claude-sonnet-4-6', max_tokens: 100, stream: true,
    messages: [{ role: 'user', content: 'go' }],
  });
  const payloads = parseSse(text).filter((f) => f.event).map((f) => ({ event: f.event, data: JSON.parse(f.data) }));
  const start = payloads.find((p) => p.event === 'content_block_start' && p.data.content_block.type === 'tool_use');
  assert.ok(start);
  assert.equal(start.data.content_block.id, 'tu_1');
  assert.equal(start.data.content_block.name, 'Bash');
  const jsonDelta = payloads.find((p) => p.data?.delta?.type === 'input_json_delta');
  assert.deepEqual(JSON.parse(jsonDelta.data.delta.partial_json), { cmd: 'ls -la' });
  assert.equal(payloads.find((p) => p.event === 'message_delta').data.delta.stop_reason, 'tool_use');
});

// ══════════════════════════════════════════════════════════════════
// Non-streaming
// ══════════════════════════════════════════════════════════════════
test('openai non-stream: aggregates text, tool calls and usage', async () => {
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'reasoning-delta', text: 'plan' },
    { type: 'text-delta', text: 'Hello ' },
    { type: 'text-delta', text: 'there' },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'f', input: { a: 1 } },
    { type: 'finish-step', finishReason: 'tool-calls' },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 8, outputTokens: 12, cachedInputTokens: 1 } },
  ]), opts: { chunkSize: 7 } };

  const { res, text } = await call('/v1/chat/completions', {
    model: 'm', stream: false, max_tokens: 1000,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(text);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'Hello there');
  assert.equal(body.choices[0].message.reasoning_content, 'plan');
  assert.equal(body.choices[0].message.tool_calls.length, 1);
  assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { a: 1 });
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.usage.prompt_tokens, 8);
  assert.equal(body.usage.completion_tokens, 12);
  assert.equal(body.usage.prompt_tokens_details.cached_tokens, 1);
  await assertNoLiveTimers();
});

test('anthropic non-stream: builds content blocks in order', async () => {
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'reasoning-delta', text: 'hmm' },
    { type: 'text-delta', text: 'Done.' },
    { type: 'tool-call', toolCallId: 'tu_9', toolName: 'Read', input: { p: 'x' } },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 2, outputTokens: 5 } },
  ]), opts: { chunkSize: 11 } };

  const { res, text } = await call('/v1/messages', {
    model: 'claude-sonnet-4-6', max_tokens: 500, stream: false,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(text);
  assert.equal(body.type, 'message');
  assert.deepEqual(body.content.map((c) => c.type), ['thinking', 'text', 'tool_use']);
  assert.equal(body.content[1].text, 'Done.');
  assert.deepEqual(body.content[2].input, { p: 'x' });
  assert.equal(body.stop_reason, 'tool_use');
  assert.equal(body.usage.output_tokens, 5);
});

test('openai non-stream: rejects max_tokens above the non-stream cap', async () => {
  const { res, text } = await call('/v1/chat/completions', {
    model: 'm', stream: false, max_tokens: 99999,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(text).error.message, /stream=true/);
});

// ══════════════════════════════════════════════════════════════════
// Idle timeout — the behaviour that used to burn CPU
// ══════════════════════════════════════════════════════════════════
test('stream idle timeout: returns 429 quickly and leaves no timers behind', async () => {
  upstream = { kind: 'ndjson', text: '', opts: { stall: true } };
  resetTimers();
  const started = Date.now();

  const { res, text } = await call('/v1/chat/completions', {
    model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }],
  }, { env: { CC_STREAM_IDLE_TIMEOUT_MS: '120' } });

  const elapsed = Date.now() - started;
  assert.equal(res.status, 429, 'idle timeout must map to 429 JSON, got ' + res.status);
  assert.match(JSON.parse(text).error.message, /timeout/i);
  assert.ok(elapsed < 3000, `should fail fast, took ${elapsed}ms`);
  // 看门狗定时器不能每个事件/每次读取都新建，且必须全部清理
  assert.ok(timerStats.created <= 5, `unexpected timer churn: ${timerStats.created}`);
  await assertNoLiveTimers();
});

test('non-stream idle timeout: returns 429 and cancels upstream', async () => {
  upstream = { kind: 'ndjson', text: '', opts: { stall: true } };
  resetTimers();

  const { res } = await call('/v1/chat/completions', {
    model: 'm', stream: false, max_tokens: 100,
    messages: [{ role: 'user', content: 'x' }],
  }, { env: { CC_NONSTREAM_IDLE_TIMEOUT_MS: '120' } });

  assert.equal(res.status, 429);
  await assertNoLiveTimers();
});

test('anthropic stream idle timeout surfaces an error event', async () => {
  upstream = { kind: 'ndjson', text: '', opts: { stall: true } };
  resetTimers();
  const { res, text } = await call('/v1/messages', {
    model: 'claude-sonnet-4-6', max_tokens: 100, stream: true,
    messages: [{ role: 'user', content: 'x' }],
  }, { env: { CC_STREAM_IDLE_TIMEOUT_MS: '120' } });
  // 预缓冲阶段就超时 → JSON 错误
  assert.equal(res.status, 429);
  await assertNoLiveTimers();
});

test('stream that stalls after first content emits an in-stream timeout error', async () => {
  // 先给一段内容让 SSE 开始，然后停住
  const head = ndjson([
    { type: 'text-delta', text: 'partial' },
  ]);
  let sent = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/alpha/generate')) {
      return new Response(new ReadableStream({
        pull(controller) {
          if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(head)); return; }
          return new Promise(() => {});
        },
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  resetTimers();

  const { res, text } = await call('/v1/chat/completions', {
    model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }],
  }, { env: { CC_STREAM_IDLE_TIMEOUT_MS: '120' } });

  assert.equal(res.status, 200);
  const lastData = parseSse(text).filter((f) => f.data && f.data !== '[DONE]').at(-1);
  const parsed = JSON.parse(lastData.data);
  assert.match(parsed.error.message, /timeout/i);
  assert.equal(parsed.error.type, 'rate_limit_error');

  // 还原默认 stub
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;

// ══════════════════════════════════════════════════════════════════
// Parsing edge cases
// ══════════════════════════════════════════════════════════════════
test('one huge NDJSON line split across many chunks is parsed once', async () => {
  const bigArgs = { blob: 'x'.repeat(200000) };
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'tool-call', toolCallId: 'big', toolName: 'write', input: bigArgs },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 1, outputTokens: 2 } },
  ]), opts: { chunkSize: 997 } }; // 质数切片，确保落在行中间

  const { res, text } = await call('/v1/chat/completions', {
    model: 'm', stream: false, max_tokens: 100,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(text);
  const args = JSON.parse(body.choices[0].message.tool_calls[0].function.arguments);
  assert.equal(args.blob.length, 200000);
});

test('SSE comment lines and [DONE] from upstream are ignored', async () => {
  upstream = { kind: 'ndjson', text:
    ': keepalive\n' +
    JSON.stringify({ type: 'text-delta', text: 'ok' }) + '\n' +
    '\n' +
    '[DONE]\n' +
    JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } }) + '\n',
    opts: { chunkSize: 9 } };

  const { text } = await call('/v1/chat/completions', {
    model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }],
  });
  const objs = parseSse(text).filter((f) => f.data && f.data !== '[DONE]').map((f) => JSON.parse(f.data));
  assert.equal(objs.map((o) => o.choices[0].delta.content || '').join(''), 'ok');
});

test('unknown event types are logged at most once', async () => {
  const logs = [];
  const realLog = console.log;
  console.log = (line) => { logs.push(String(line)); };
  try {
    upstream = { kind: 'ndjson', text: ndjson([
      ...Array.from({ length: 50 }, () => ({ type: 'some-brand-new-event' })),
      { type: 'text-delta', text: 'x' },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
    ]), opts: { chunkSize: 40 } };

    await call('/v1/chat/completions', {
      model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }],
    });
  } finally {
    console.log = realLog;
  }
  const unknownLogs = logs.filter((l) => l.includes('Unknown CC event type'));
  assert.equal(unknownLogs.length, 1, `expected 1 unknown-event log, got ${unknownLogs.length}`);
});

// ══════════════════════════════════════════════════════════════════
// Routing / auth / misc
// ══════════════════════════════════════════════════════════════════
test('missing api key returns 401', async () => {
  const req = new Request('https://worker.example/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  const res = await worker.fetch(req, {}, waitUntilCtx());
  assert.equal(res.status, 401);
  const body = JSON.parse(await res.text());
  assert.equal(body.error.type, 'auth_error');
});

test('files the api key from x-api-key header too', async () => {
  upstream = { kind: 'ndjson', text: ndjson([
    { type: 'text-delta', text: 'a' },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
  ]) };
  const req = new Request('https://worker.example/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'user_viakey123' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] }),
  });
  const res = await worker.fetch(req, {}, waitUntilCtx());
  assert.equal(res.status, 200);
  await res.text();
});

test('health, models and 404 routes', async () => {
  const ctx = waitUntilCtx();
  const health = await worker.fetch(new Request('https://w.example/health'), {}, ctx);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'OK');

  const root = await worker.fetch(new Request('https://w.example/'), {}, ctx);
  assert.equal(await root.text(), 'OK');

  const nf = await worker.fetch(new Request('https://w.example/nope'), {}, ctx);
  assert.equal(nf.status, 404);

  const models = await worker.fetch(new Request('https://w.example/v1/models', {
    headers: { authorization: `Bearer ${freshKey()}` },
  }), { CC_USE_PROVIDER_MODELS: 'true' }, waitUntilCtx());
  assert.equal(models.status, 200);
  const body = JSON.parse(await models.text());
  assert.equal(body.object, 'list');
  assert.ok(body.data.length > 0);
  assert.equal(body.data[0].object, 'model');
});

test('OPTIONS preflight returns 204 with CORS headers', async () => {
  const res = await worker.fetch(new Request('https://w.example/v1/messages', { method: 'OPTIONS' }), {}, waitUntilCtx());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('invalid JSON body returns 400', async () => {
  const req = new Request('https://worker.example/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${freshKey()}` },
    body: '{not json',
  });
  const res = await worker.fetch(req, {}, waitUntilCtx());
  assert.equal(res.status, 400);
});

test('upstream error status is mapped (402 -> 429 rate limit)', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/alpha/generate')) {
      return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 402 });
    }
    return new Response('{}', { status: 200 });
  };
  try {
    const { res, text } = await call('/v1/chat/completions', {
      model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(res.status, 429);
    assert.equal(JSON.parse(text).error.message, 'quota exceeded');
    assert.equal(res.headers.get('retry-after'), '30');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('anthropic request conversion: system + tools + tool_use round-trip', async () => {
  let capturedBody = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/alpha/generate')) {
      capturedBody = JSON.parse(init.body);
      return new Response(byteStream(ndjson([
        { type: 'text-delta', text: 'ok' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ])), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  try {
    await call('/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      system: [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'auto' },
      thinking: { type: 'enabled', budget_tokens: 12000 },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { p: 'a' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' }] },
      ],
      stream: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(capturedBody, 'upstream body captured');
  assert.equal(capturedBody.params.model, 'claude-sonnet-4-6');
  assert.equal(capturedBody.params.stream, true);
  // system 保留 block 结构 + cache_control
  assert.ok(Array.isArray(capturedBody.params.system));
  assert.deepEqual(capturedBody.params.system[0].cache_control, { type: 'ephemeral' });
  // thinking budget -> reasoning_effort
  assert.equal(capturedBody.params.reasoning_effort, 'high');
  assert.equal(capturedBody.params.tools[0].name, 'Read');
  // tool 结果带上反向查到的 tool name
  const toolMsg = capturedBody.params.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.content[0].toolName, 'Read');
});

// ══════════════════════════════════════════════════════════════════
// Backpressure: a slow client must not be mistaken for a stuck upstream
// ══════════════════════════════════════════════════════════════════
test('slow client does not trip the idle timeout', async () => {
  const pieces = Array.from({ length: 12 }, (_, i) => ({ type: 'text-delta', text: `part${i} ` }));
  upstream = { kind: 'ndjson', text: ndjson([
    ...pieces,
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 12 } },
  ]), opts: { chunkSize: 60 } };

  const req = new Request('https://worker.example/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${freshKey()}` },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] }),
  });
  // 空闲超时 100ms，但客户端每读一块就停顿 250ms（远超超时）
  const res = await worker.fetch(req, { CC_STREAM_IDLE_TIMEOUT_MS: '100' }, waitUntilCtx());
  assert.equal(res.status, 200);

  const reader = res.body.getReader();
  const td = new TextDecoder();
  let text = '';
  let reads = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += td.decode(value, { stream: true });
    reads++;
    await new Promise((r) => realSetTimeout(r, 250)); // 慢客户端
  }

  assert.ok(reads > 1, 'stream should be delivered in multiple chunks');
  assert.ok(text.includes('[DONE]'), 'stream must complete normally, not time out');
  assert.ok(!text.includes('rate_limit_error'), 'no false timeout error: ' + text.slice(-300));
  await assertNoLiveTimers();
});

test('client cancellation tears down without leaving timers', async () => {
  upstream = { kind: 'ndjson', text: ndjson(
    Array.from({ length: 200 }, (_, i) => ({ type: 'text-delta', text: `t${i} ` })),
  ), opts: { chunkSize: 40 } };
  resetTimers();

  const req = new Request('https://worker.example/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${freshKey()}` },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] }),
  });
  const res = await worker.fetch(req, {}, waitUntilCtx());
  const reader = res.body.getReader();
  await reader.read();   // 读一点
  await reader.cancel('client went away');
  await new Promise((r) => realSetTimeout(r, 30));

  await assertNoLiveTimers();
});

test('anthropic stream: client cancel releases the generator and its watchdog', async () => {
  upstream = { kind: 'ndjson', text: ndjson(
    Array.from({ length: 300 }, (_, i) => ({ type: 'text-delta', text: `w${i} ` })),
  ), opts: { chunkSize: 40 } };
  resetTimers();

  const req = new Request('https://worker.example/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${freshKey()}` },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'x' }],
    }),
  });
  const res = await worker.fetch(req, {}, waitUntilCtx());
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel('client hung up');
  await new Promise((r) => realSetTimeout(r, 40));

  await assertNoLiveTimers();
});

// ══════════════════════════════════════════════════════════════════
// Tool schema slimming / upstream schema rejection
// ══════════════════════════════════════════════════════════════════

/** 深嵌套 + 大量 anyOf 重复分支，模拟 MCP 工具那种会撑爆上游的 schema */
function massiveSchema(depth) {
  let node = { type: 'string' };
  for (let i = 0; i < depth; i++) {
    node = {
      type: 'object',
      properties: {
        before_scenario: {
          type: 'object',
          properties: {
            events: {
              type: 'array',
              items: {
                items: {
                  anyOf: [
                    { type: 'object', properties: { redirected_from_transaction_id: { anyOf: [node, { type: 'null' }] } } },
                    { type: 'object', properties: { seq: { type: 'number' } } },
                    { type: 'object', properties: { kind: { type: 'string' } } },
                    { type: 'object', properties: { at: { type: 'number' } } },
                    { type: 'object', properties: { x: { type: 'string' } } },
                    { type: 'object', properties: { y: { type: 'string' } } },
                    { type: 'object', properties: { z: { type: 'string' } } },
                    { type: 'object', properties: { w: { type: 'string' } } },
                    { type: 'object', properties: { v: { type: 'string' } } },
                    { type: 'object', properties: { u: { type: 'string' } } },
                  ],
                },
              },
            },
          },
        },
      },
    };
  }
  return node;
}

/** 每层把子 schema 复制到多个 anyOf 分支里，体积随层数爆炸（真实 MCP schema 就是这样） */
function explosiveSchema(levels) {
  let node = { type: 'string' };
  for (let i = 0; i < levels; i++) {
    node = {
      type: 'object',
      properties: {
        before_scenario: {
          type: 'object',
          properties: {
            events: {
              type: 'array',
              items: {
                items: {
                  anyOf: [
                    { type: 'object', properties: { redirected_from_transaction_id: { anyOf: [node, { type: 'null' }] } } },
                    ...Array.from({ length: 7 }, (_, k) => ({
                      type: 'object',
                      properties: { ['f' + k]: { type: 'object', properties: { deep: node } } },
                    })),
                  ],
                },
              },
            },
          },
        },
      },
    };
  }
  return node;
}

function captureBody(responder) {
  const captured = { body: null };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/alpha/generate')) {
      captured.body = JSON.parse(init.body);
      return responder();
    }
    return new Response('{}', { status: 200 });
  };
  return captured;
}

const okStream = () => new Response(byteStream(ndjson([
  { type: 'text-delta', text: 'ok' },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
])), { status: 200 });

test('CC_SCHEMA_SLIM=always shrinks oversized tool schemas before forwarding', async () => {
  const huge = massiveSchema(8);
  const beforeBytes = JSON.stringify(huge).length;
  assert.ok(beforeBytes > 5000, 'fixture should be big, got ' + beforeBytes);

  const captured = captureBody(okStream);
  try {
    const { res } = await call('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { type: 'function', function: { name: 'huge_tool', description: 'big one', parameters: huge } },
        { type: 'function', function: { name: 'small_tool', description: 'tiny', parameters: { type: 'object', properties: { a: { type: 'string' } } } } },
      ],
    }, { env: { CC_SCHEMA_SLIM: 'always' } });
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const tools = captured.body.params.tools;
  assert.equal(tools.length, 2, 'must not drop tools');
  const hugeAfter = JSON.stringify(tools[0].input_schema).length;
  assert.ok(hugeAfter < beforeBytes / 2, `expected big reduction, ${beforeBytes} -> ${hugeAfter}`);
  // 名字和描述必须保留，否则模型不知道这个工具存在
  assert.equal(tools[0].name, 'huge_tool');
  assert.equal(tools[0].description, 'big one');
  // 小 schema 不该被无故改动
  assert.deepEqual(tools[1].input_schema, { type: 'object', properties: { a: { type: 'string' } } });
});

test('by default the proxy does not rewrite tool schemas', async () => {
  // 代理默认是忠实转发：即使 schema 很大也逐字节原样送出
  const huge = massiveSchema(3);
  const captured = captureBody(okStream);
  try {
    await call('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 't', parameters: huge } }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(captured.body.params.tools[0].input_schema, huge);
});

test('CC_SCHEMA_SLIM=auto leaves a normal-sized tool set untouched', async () => {
  const captured = captureBody(okStream);
  const tools = Array.from({ length: 5 }, (_, i) => ({
    type: 'function',
    function: { name: `tool_${i}`, description: 'fine', parameters: { type: 'object', properties: { a: { type: 'string' } } } },
  }));
  try {
    await call('/v1/chat/completions', {
      model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }], tools,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  // 官方 CLI 的 toWireTools 只发 {name, description, input_schema}，没有 type 包装
  assert.deepEqual(captured.body.params.tools, tools.map((t) => ({
    name: t.function.name, description: t.function.description, input_schema: t.function.parameters,
  })));
});

test('auto mode slims oversized schemas without being asked', async () => {
  const captured = captureBody(okStream);
  const huge = explosiveSchema(3);
  const before = JSON.stringify(huge).length;
  assert.ok(before > 20000, 'fixture must be oversized, got ' + before);
  try {
    await call('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'huge', description: 'd', parameters: huge } }],
    }, { env: { CC_SCHEMA_SLIM: 'auto', CC_TOOL_SCHEMA_BUDGET: '8192' } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const after = JSON.stringify(captured.body.params.tools[0].input_schema).length;
  assert.ok(after < before / 4, `auto slimming should shrink ${before} -> ${after}`);
  assert.equal(captured.body.params.tools[0].name, 'huge');
});

test('budget enforcement blanks the largest schemas but keeps names/descriptions', async () => {
  const captured = captureBody(okStream);
  // 很多工具 + 一个怪兽，整体远超预算
  const monster = explosiveSchema(3);
  const tools = [
    { type: 'function', function: { name: 'monster', description: 'the monster', parameters: monster } },
    ...Array.from({ length: 60 }, (_, i) => ({
      type: 'function',
      function: { name: `t${i}`, description: 'x'.repeat(300), parameters: { type: 'object', properties: { a: { type: 'string' } } } },
    })),
  ];
  try {
    await call('/v1/chat/completions', {
      model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }], tools,
    }, { env: { CC_SCHEMA_SLIM: 'auto', CC_TOOL_SCHEMA_BUDGET: '2048' } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const out = captured.body.params.tools;
  assert.equal(out.length, tools.length, '工具不能被丢弃');
  const monsterOut = JSON.stringify(out[0].input_schema).length;
  assert.ok(monsterOut < 64, `monster schema should be blanked, got ${monsterOut}B`);
  assert.equal(out[0].name, 'monster');
  assert.equal(out[0].description, 'the monster');
  // 总体 schema 体积必须落在预算附近
  const total = out.reduce((n, t) => n + JSON.stringify(t.input_schema || {}).length, 0);
  assert.ok(total < 2048 + 64 * out.length, `schema bytes ${total} should respect the budget`);
});

test('$ref / $defs are removed when slimming (they are what explodes)', async () => {
  const withRefs = {
    type: 'object',
    properties: {
      a: { $ref: '#/$defs/Node' },
      b: { anyOf: [{ $ref: '#/$defs/Node' }, { type: 'null' }] },
    },
    $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
  };
  const captured = captureBody(okStream);
  try {
    await call('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 't', parameters: withRefs } }],
    }, { env: { CC_SCHEMA_SLIM: 'always' } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const schema = captured.body.params.tools[0].input_schema;
  assert.equal(schema.$defs, undefined, '$defs must be dropped');
  assert.equal(JSON.stringify(schema).includes('$ref'), false, 'no dangling $ref may remain');
});

test('upstream schema rejection surfaces the real reason instead of "empty response"', async () => {
  const reason = 'tools[0].function.parameters.properties.x.anyOf[1].type JSON Schema reference expansion is too large';
  globalThis.fetch = async (url) => {
    if (String(url).includes('/alpha/generate')) {
      return new Response(byteStream(ndjson([
        { type: 'start' },
        { type: 'error', error: { message: reason } },
      ])), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  try {
    const { res, text } = await call('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 't', parameters: { type: 'object' } } }],
    });
    // 确定性失败 → 400，客户端不该继续重试
    assert.equal(res.status, 400);
    const body = JSON.parse(text);
    assert.equal(body.error.type, 'invalid_request_error');
    assert.match(body.error.message, /JSON Schema reference expansion is too large/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-stream: upstream schema rejection also returns the real reason', async () => {
  const reason = 'tools[1].function.parameters JSON Schema reference expansion is too large';
  globalThis.fetch = async (url) => {
    if (String(url).includes('/alpha/generate')) {
      return new Response(byteStream(ndjson([
        { type: 'error', error: { message: reason } },
      ])), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  try {
    const { res, text } = await call('/v1/chat/completions', {
      model: 'm', stream: false, max_tokens: 100,
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(res.status, 400);
    assert.match(JSON.parse(text).error.message, /expansion is too large/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generic upstream stream error keeps the message but stays retryable', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/alpha/generate')) {
      return new Response(byteStream(ndjson([
        { type: 'error', error: { message: 'upstream model overloaded' } },
      ])), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  try {
    const { res, text } = await call('/v1/chat/completions', {
      model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(res.status, 429);
    assert.match(JSON.parse(text).error.message, /overloaded/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ══════════════════════════════════════════════════════════════════
// 线格式保真度：逐条对齐官方 CLI (command-code@1.88.0) 的 toWire* 形状
// ══════════════════════════════════════════════════════════════════
test('assistant reasoning_content is forwarded as a {type:"reasoning"} block', async () => {
  const captured = captureBody(okStream);
  try {
    await call('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'answer', reasoning_content: 'my earlier thinking' },
        { role: 'user', content: 'next' },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const assistant = captured.body.params.messages.find((m) => m.role === 'assistant');
  assert.deepEqual(assistant.content, [
    { type: 'reasoning', text: 'my earlier thinking' },
    { type: 'text', text: 'answer' },
  ]);
});

test('consecutive tool messages are merged into one role:tool message', async () => {
  const captured = captureBody(okStream);
  try {
    await call('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } },
          { id: 'c2', type: 'function', function: { name: 'grep', arguments: '{"q":"b"}' } },
        ] },
        { role: 'tool', tool_call_id: 'c1', content: 'file a' },
        { role: 'tool', tool_call_id: 'c2', content: 'match b' },
        { role: 'user', content: 'thanks' },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const msgs = captured.body.params.messages;
  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 1, '一轮的工具结果必须合并成一条 tool 消息');
  assert.equal(toolMsgs[0].content.length, 2);
  assert.deepEqual(toolMsgs[0].content.map((c) => c.type), ['tool-result', 'tool-result']);
  // 工具名从 assistant.tool_calls 反查
  assert.equal(toolMsgs[0].content[0].toolName, 'read');
  assert.equal(toolMsgs[0].content[1].toolName, 'grep');
  // 顺序：tool 消息在后续 user 文本之前
  assert.ok(msgs.indexOf(toolMsgs[0]) < msgs.findIndex((m) => m.role === 'user' && m.content[0]?.text === 'thanks'));
});

test('image blocks carry mimeType like the CLI does', async () => {
  const captured = captureBody(okStream);
  try {
    await call('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ] }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const img = captured.body.params.messages[0].content.find((c) => c.type === 'image');
  assert.deepEqual(img, { type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' });
});

test('max_tokens is forwarded as requested, not silently capped', async () => {
  const captured = captureBody(okStream);
  try {
    await call('/v1/chat/completions', {
      model: 'm', stream: true, max_tokens: 500000,
      messages: [{ role: 'user', content: 'x' }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(captured.body.params.max_tokens, 500000);
});

test('body matches the CLI envelope: skills is null and tools have no type wrapper', async () => {
  const captured = captureBody(okStream);
  try {
    await call('/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(captured.body.skills, null);
  assert.equal(captured.body.taste, null);
  assert.equal(captured.body.memory, null);
  assert.deepEqual(Object.keys(captured.body.params.tools[0]).sort(), ['description', 'input_schema', 'name']);
  // messages 里每条 content 都是数组（CLI 的线格式）
  assert.ok(captured.body.params.messages.every((m) => Array.isArray(m.content)));
});

test('anthropic top_p/stop_sequences are logged as unsupported instead of silently vanishing', async () => {
  const logs = [];
  const realLog = console.log;
  console.log = (l) => logs.push(String(l));
  globalThis.fetch = async (url) => {
    if (String(url).includes('/alpha/generate')) return okStream();
    return new Response('{}', { status: 200 });
  };
  try {
    await call('/v1/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 100, stream: true,
      top_p: 0.9, stop_sequences: ['END'],
      messages: [{ role: 'user', content: 'x' }],
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = realLog;
  }
  const warned = logs.filter((l) => l.includes('no upstream equivalent'));
  assert.ok(warned.length >= 1, 'should warn about unsupported params: ' + logs.join('\n'));
  assert.ok(warned.some((l) => l.includes('top_p')));
});
