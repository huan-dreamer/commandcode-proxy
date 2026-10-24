/**
 * End-to-end tests for the local Node entry (server.mjs).
 *
 *   node --test test/server.test.mjs
 *
 * Unlike test/worker.test.mjs (which calls worker.fetch directly with a stubbed
 * upstream), this exercises the real thing: mock upstream HTTP server ->
 * proxy over real HTTP -> streaming client.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

const ndjson = (evts) => evts.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** 上游 mock：按小块 + 小延迟 flush，模拟真实 token 流 */
function startMockUpstream({ delayMs = 8, chunks = 6 } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/alpha/generate') {
      req.resume();
      await once(req, 'end').catch(() => {});
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (!res.socket) return;
      res.socket.setNoDelay(true);
      const events = [
        { type: 'start' },
        ...Array.from({ length: chunks }, (_, i) => ({ type: 'text-delta', text: `tok${i} ` })),
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 7, outputTokens: chunks } },
      ];
      for (const e of events) {
        if (res.writableEnded) return;
        res.write(JSON.stringify(e) + '\n');
        await new Promise((r) => setTimeout(r, delayMs));
      }
      res.end();
      return;
    }
    if (req.url === '/provider/v1/models') {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock/model' }] }));
      return;
    }
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return server;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

const { createProxyServer } = await import('../server.mjs');

async function setup() {
  const upstream = startMockUpstream();
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    CC_API_BASE: upstreamUrl,
    PROJECT_SLUG: 'cc-proxy-test',
    CC_USE_PROVIDER_MODELS: 'true',
  });
  const proxyUrl = await listen(proxy);
  return {
    proxyUrl,
    async close() {
      await new Promise((r) => proxy.close(r));
      await new Promise((r) => upstream.close(r));
    },
  };
}

const auth = { authorization: 'Bearer user_localtest1', 'content-type': 'application/json' };

test('local server: health and 404', async () => {
  const s = await setup();
  try {
    const health = await fetch(`${s.proxyUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'OK');

    const nf = await fetch(`${s.proxyUrl}/nope`);
    assert.equal(nf.status, 404);

    const models = await fetch(`${s.proxyUrl}/v1/models`, { headers: auth });
    assert.equal(models.status, 200);
    const body = await models.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data[0].id, 'mock/model');
  } finally {
    await s.close();
  }
});

test('local server: 401 without an api key', async () => {
  const s = await setup();
  try {
    const res = await fetch(`${s.proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.type, 'auth_error');
  } finally {
    await s.close();
  }
});

test('local server: streams SSE incrementally (no full buffering)', async () => {
  const s = await setup();
  try {
    const res = await fetch(`${s.proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const arrivals = [];
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(Date.now());
      text += decoder.decode(value, { stream: true });
    }

    assert.ok(arrivals.length > 1, `expected multiple chunks, got ${arrivals.length}`);
    // 首个数据块必须远早于结束时间，否则说明被整体缓冲了
    const span = arrivals.at(-1) - arrivals[0];
    assert.ok(span >= 10, `stream was buffered (span ${span}ms)`);

    const frames = text.split('\n\n').filter((b) => b.trim());
    const objects = frames
      .map((f) => f.split('\n').find((l) => l.startsWith('data: ')))
      .filter(Boolean)
      .map((l) => l.slice(6));
    const doneCount = objects.filter((d) => d === '[DONE]').length;
    assert.equal(doneCount, 1, 'exactly one [DONE]');

    const content = objects
      .filter((d) => d !== '[DONE]')
      .map((d) => JSON.parse(d))
      .map((o) => o.choices[0].delta.content || '')
      .join('');
    assert.equal(content, 'tok0 tok1 tok2 tok3 tok4 tok5 ');

    const finish = objects
      .filter((d) => d !== '[DONE]')
      .map((d) => JSON.parse(d))
      .find((o) => o.choices[0].finish_reason !== null);
    assert.equal(finish.choices[0].finish_reason, 'stop');
    assert.equal(finish.usage.completion_tokens, 6);
  } finally {
    await s.close();
  }
});

test('local server: non-stream JSON response', async () => {
  const s = await setup();
  try {
    const res = await fetch(`${s.proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'm', stream: false, max_tokens: 500,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'tok0 tok1 tok2 tok3 tok4 tok5 ');
    assert.equal(body.usage.completion_tokens, 6);
    assert.equal(body.usage.prompt_tokens, 7);
  } finally {
    await s.close();
  }
});

test('local server: anthropic endpoint works too', async () => {
  const s = await setup();
  try {
    const res = await fetch(`${s.proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 100, stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, 'message');
    const text = body.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    assert.equal(text, 'tok0 tok1 tok2 tok3 tok4 tok5 ');
    assert.equal(body.stop_reason, 'end_turn');
  } finally {
    await s.close();
  }
});

test('local server: client abort mid-stream does not crash or hang', async () => {
  const s = await setup();
  try {
    const ac = new AbortController();
    const res = await fetch(`${s.proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    });
    const reader = res.body.getReader();
    await reader.read();
    ac.abort(); // 客户端挂断
    await new Promise((r) => setTimeout(r, 60));

    // 服务仍然可用
    const health = await fetch(`${s.proxyUrl}/health`);
    assert.equal(health.status, 200);
  } finally {
    await s.close();
  }
});

test('local server: 1 MB request body is accepted', async () => {
  const s = await setup();
  try {
    const big = 'x'.repeat(400 * 1024);
    const res = await fetch(`${s.proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'm', stream: false, max_tokens: 100,
        messages: [
          { role: 'user', content: big },
          { role: 'user', content: big },
          { role: 'user', content: big },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, 'tok0 tok1 tok2 tok3 tok4 tok5 ');
  } finally {
    await s.close();
  }
});
