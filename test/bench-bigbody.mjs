/**
 * Request-body CPU benchmark: how much CPU does a large agent context cost?
 *
 *   node test/bench-bigbody.mjs
 *
 * A stateless chat-completions client resends the whole conversation every turn.
 * With big tool outputs that easily reaches ~1 MB, and this proxy has to:
 *   decode body -> JSON.parse -> reshape to the CC schema -> JSON.stringify -> send
 * All of that is CPU, and it happens *before* the first token arrives.
 *
 * Reference budgets (https://developers.cloudflare.com/workers/platform/limits/):
 *   Workers Free : 10 ms CPU per request
 *   Workers Paid : 30 s CPU per request by default (up to 5 min via limits.cpu_ms)
 *
 * Node is not the Workers runtime, but the same Web APIs are involved; treat the
 * numbers as a lower bound and the ratio between sizes as the useful signal.
 */

function buildBigRequest(targetBytes) {
  const messages = [{ role: 'system', content: 'You are a coding agent. '.repeat(40) }];
  let size = 0;
  let i = 0;
  while (size < targetBytes) {
    const toolResult = 'line of file content '.repeat(60) + `# ${i}\n`;
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: `call_${i}`,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: `/src/f${i}.ts` }) },
      }],
    });
    messages.push({ role: 'tool', tool_call_id: `call_${i}`, name: 'read_file', content: toolResult });
    messages.push({ role: 'user', content: `continue ${i}` });
    size += toolResult.length + 200;
    i++;
  }
  const tools = Array.from({ length: 12 }, (_, k) => ({
    type: 'function',
    function: {
      name: `tool_${k}`,
      description: 'does something useful '.repeat(20),
      parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
    },
  }));
  return { model: 'deepseek/deepseek-v4-flash', stream: true, max_tokens: 32000, messages, tools };
}

const enc = new TextEncoder();

// Upstream responds immediately with one delta + finish: we measure the request
// path (decode/parse/reshape/serialize), not streaming.
globalThis.fetch = async (url) => {
  if (String(url).includes('/alpha/generate')) {
    return new Response(new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(
          JSON.stringify({ type: 'text-delta', text: 'ok' }) + '\n' +
          JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } }) + '\n',
        ));
        c.close();
      },
    }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

const { default: worker } = await import('../src/index.js');

async function once(json, key) {
  const req = new Request('https://worker.example/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: json,
  });
  const res = await worker.fetch(req, {}, { waitUntil() {} });
  await res.text();
  return res.status;
}

const WARM = 3;
const N = 15;

// 单次采样的中位数：平均会被偶发的大 GC 拉偏（同一份 body 可能量出 8ms 或 17ms），
// 中位数才是稳定的信号。
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

console.log(' body KB   msgs   median    p90      verdict (median)');
console.log('─'.repeat(64));

for (const kb of [100, 200, 400, 800, 1100]) {
  const req = buildBigRequest(kb * 1024);
  const json = JSON.stringify(req);
  const key = `user_bench${kb}x`;

  let status = 0;
  for (let i = 0; i < WARM; i++) status = await once(json, key);

  const samples = [];
  for (let i = 0; i < N; i++) {
    const t = process.cpuUsage();
    await once(json, key);
    const d = process.cpuUsage(t);
    samples.push((d.user + d.system) / 1000);
  }
  const med = median(samples);
  const p90 = [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.9)];

  const verdict = med < 10 ? 'fits Free (10ms)'
    : med < 30000 ? 'over Free, fine on Paid (30s)'
    : 'over even Paid default';
  console.log(
    `${String((json.length / 1024).toFixed(0)).padStart(7)}   `
    + `${String(req.messages.length).padStart(5)}   `
    + `${med.toFixed(2).padStart(6)}ms  ${p90.toFixed(2).padStart(6)}ms   ${verdict}`
    + (status === 200 ? '' : `   (status ${status})`),
  );
}

console.log(`
Note: a 1 MB request is ~1 MB of JSON to decode, parse, reshape and re-serialize.
That work alone is several milliseconds, so Workers Free (10 ms CPU) cannot serve
large contexts regardless of how the proxy is written.`);
