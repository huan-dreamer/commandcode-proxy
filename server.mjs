#!/usr/bin/env node
/**
 * 本地运行入口 —— 不依赖 Cloudflare，没有 CPU 时间计费。
 *
 *   node server.mjs            # 默认 http://127.0.0.1:8787
 *   PORT=9000 node server.mjs
 *
 * src/index.js 已经是标准的 Web API（Request / Response / ReadableStream），
 * 这里只做 Node HTTP ↔ Web API 的适配：
 *   - 请求体读成 Buffer 传给 new Request()
 *   - 响应体边读边写，并遵守下游背压（慢客户端不会把整个响应堆在内存里）
 *   - 客户端断开时 abort，连带取消上游请求
 *
 * 配置读取顺序：.dev.vars（与 wrangler 同一个文件） < 进程环境变量。
 * 不需要 KV：CFG.state 为空时代码会自动使用进程内状态。
 */

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import worker from './src/index.js';

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 与 src/index.js 保持一致
const DEFAULT_PORT = 8787;

/** 读取 wrangler 风格的 .dev.vars（KEY=VALUE，支持 # 注释和引号） */
function loadDotVars(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/** 把请求体完整读入内存（chat completions 的 body 需要整体 JSON 解析） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error('Request body exceeds 10MB limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 逐块写出的同时遵守背压；客户端断开时立即返回，避免挂住 */
function writeChunk(res, buf) {
  if (res.write(buf)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

export function createProxyServer(env = {}) {
  return http.createServer(async (req, res) => {
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);

    try {
      // 关掉 Nagle：逐 token 的 SSE 不该被攒包拖慢
      if (res.socket) res.socket.setNoDelay(true);

      const host = req.headers.host || `127.0.0.1:${DEFAULT_PORT}`;
      const url = new URL(req.url || '/', `http://${host}`);

      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        try { headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]); } catch { /* 非法头名忽略 */ }
      }

      const init = { method: req.method, headers, signal: controller.signal };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = await readBody(req);
      }

      const response = await worker.fetch(new Request(url, init), env, {
        // 本地没有 waitUntil 的生命周期管理，直接 background 掉
        waitUntil: (p) => { Promise.resolve(p).catch(() => {}); },
      });

      const outHeaders = {};
      for (const [k, v] of response.headers) outHeaders[k] = v;
      // 这两个由 Node 自己按实际写出的内容决定，透传会冲突
      delete outHeaders['transfer-encoding'];
      if (response.body) delete outHeaders['content-length'];

      if (response.statusText) res.writeHead(response.status, response.statusText, outHeaders);
      else res.writeHead(response.status, outHeaders);

      if (!response.body) { res.end(); return; }
      // 先把响应头发出去，客户端才能尽快看到首字节
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (res.writableEnded || res.destroyed) break;
          await writeChunk(res, Buffer.from(value));
        }
      } finally {
        // cancel() 返回 Promise；abort 后它会以 AbortError 拒绝，必须吞掉
        try { const p = reader.cancel(); if (p && p.catch) p.catch(() => {}); } catch { /* 已关闭 */ }
      }
      if (!res.writableEnded) res.end();
    } catch (e) {
      const message = (e && e.message) || 'internal error';
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message, type: 'server_error' } }));
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      res.off('close', onClose);
    }
  });
}

async function main() {
  const fromFile = loadDotVars('.dev.vars');
  const env = {
    CC_API_BASE: 'https://api.commandcode.ai',
    PROJECT_SLUG: 'cc-proxy',
    ...fromFile,
    ...process.env, // 进程环境变量优先级更高
  };
  // wrangler 里的字符串变量可能为空串，避免空串覆盖默认值
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];

  const port = Number(env.PORT || DEFAULT_PORT);
  const server = createProxyServer(env);

  server.listen(port, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${port}`;
    const keyState = env.CC_API_KEY ? '已从 .dev.vars / 环境变量读取 CC_API_KEY' : '未配置 CC_API_KEY（请在请求头里带 key）';
    console.log(`commandcode-proxy 本地服务已启动
  base url : ${base}/v1
  health   : ${base}/health
  key      : ${keyState}

客户端把 base_url 指到 ${base}/v1 即可，例如：
  export OPENAI_BASE_URL=${base}/v1
  export OPENAI_API_KEY=<你的 user_xxx>
`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 直接 `node server.mjs` 时启动；被 import（测试）时只导出工厂函数
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
