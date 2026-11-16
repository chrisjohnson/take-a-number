import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Queues } from '../daemon/lib/queues.js';
import { Audit } from '../daemon/lib/audit.js';
import { EventFeed, handleConnection, connectEvents } from '../daemon/lib/protocol.js';
import { TanClient } from '../client/index.mjs';
import { startProxy } from '../proxy/main.js';

// Full-stack e2e: a real in-process daemon (UDS), a mock litellm upstream
// (HTTP), and the real proxy wiring the two. Proves the compliant checkout
// path, the hard queue, abort-while-queued, unmapped passthrough, SSE piping,
// upstream errors, and fail-open.

const dir = mkdtempSync(join(tmpdir(), 'tan-proxy-e2e-'));
const sockPath = join(dir, 'tan.sock');

let queues;
let audit;
let feed;
let udsServer;
let upstream;
let upstreamPort;
let upstreamState;
let proxy;
let proxyPort;
let holder; // a "dsh" stand-in: reserves leases, holds slots

function startDaemon() {
  const server = createServer((socket) =>
    handleConnection(socket, { queues, audit, feed, version: 'test', uptimeMs: () => 1, persistConfig: () => {} }));
  server.listen(sockPath);
  return server;
}

before(async () => {
  queues = new Queues({
    queues: [{ id: 'gpu-a', limit: 1, models: ['small-dense'] }],
    unmapped: 'unlimited',
    queueLimit: 10,
  });
  audit = new Audit(join(dir, 'audit'));
  feed = new EventFeed();
  feed.setFrameBuilder(() => ({ type: 'status', ...queues.snapshot() }));
  connectEvents(queues, feed, audit);
  udsServer = startDaemon();

  upstreamState = { requests: [], mode: 'echo' };
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      upstreamState.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (upstreamState.mode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => {
          res.write('data: two\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }, 20);
      } else if (upstreamState.mode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echo: body, 'x-tan-client': req.headers['x-tan-client'] ?? null }));
      }
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;

  proxy = await startProxy({
    upstream: `127.0.0.1:${upstreamPort}`,
    listen: '127.0.0.1:0',
    sock: sockPath,
    tcp: '127.0.0.1:1',
    instance: 'test-proxy',
  });
  proxyPort = proxy.server.address().port;

  holder = new TanClient({ sock: sockPath, tcp: '127.0.0.1:1', harness: 'dsh', instance: 'test', degradedAfterMs: 200 });
  await holder.connect();
});

after(async () => {
  holder?.close();
  await proxy?.close();
  upstream?.close();
  feed?.close();
  udsServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function viaProxy({ body, headers = {}, method = 'POST', path = '/v1/chat/completions', signal } = {}) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    signal,
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

const gpuA = (snap) => snap.queues.find((q) => q.id === 'gpu-a');

test('healthz is 200 and never queued', async () => {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('non-compliant request is hard-queued behind a hold, then forwarded on release', async () => {
  upstreamState.requests.length = 0;
  const hold = await holder.acquire({ model: 'small-dense', kind: 'hold', description: 'test hold' });
  assert.equal(hold.status, 'granted');

  const p = viaProxy({ body: { model: 'small-dense', messages: [] } });
  await new Promise((r) => setTimeout(r, 150)); // proxy must be holding it, not forwarding
  assert.equal(upstreamState.requests.length, 0);
  assert.equal(gpuA(await holder.status()).waiters.length, 1);

  holder.release(hold.leaseId);
  const res = await p;
  assert.equal(res.status, 200);
  assert.equal(upstreamState.requests.length, 1);
  assert.equal(JSON.parse(res.text).echo, JSON.stringify({ model: 'small-dense', messages: [] }));
  // The proxy's lease is released once the response settles.
  assert.equal(gpuA(await holder.status()).used, 0);
});

test('compliant request checks out its held lease (no double-acquire) and releases on settle', async () => {
  upstreamState.requests.length = 0;
  // The holder registered as instance 'test'; it self-identifies with that name.
  const lease = await holder.acquire({ model: 'small-dense', kind: 'interactive-chat' });
  assert.equal(lease.status, 'granted');
  // Slot is now 1/1. If the proxy double-acquired, this request would queue and
  // hang; it must check the lease out and forward immediately.
  const res = await viaProxy({ body: { model: 'small-dense', messages: [] }, headers: { 'x-tan-client': 'test' } });
  assert.equal(res.status, 200);
  assert.equal(upstreamState.requests.length, 1);
  assert.equal(JSON.parse(res.text)['x-tan-client'], 'test'); // header passed through
  assert.equal(gpuA(await holder.status()).used, 0); // proxy released on settle
});

test('a self-identity with no matching held lease falls back to hard queueing', async () => {
  upstreamState.requests.length = 0;
  const hold = await holder.acquire({ model: 'small-dense' });
  assert.equal(hold.status, 'granted');
  // 'stray' is an instance name that holds no lease → no checkout → hard queue.
  const p = viaProxy({ body: { model: 'small-dense', messages: [] }, headers: { 'x-tan-client': 'stray' } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(upstreamState.requests.length, 0); // queued, not forwarded
  holder.release(hold.leaseId);
  const res = await p;
  assert.equal(res.status, 200);
  assert.equal(upstreamState.requests.length, 1);
});

test('unmapped model forwards immediately under an unlimited lease', async () => {
  upstreamState.requests.length = 0;
  const res = await viaProxy({ body: { model: 'deepseek-flash', messages: [] } });
  assert.equal(res.status, 200);
  assert.equal(upstreamState.requests.length, 1);
});

test('SSE response is piped through unmodified, in order', async () => {
  upstreamState.mode = 'sse';
  upstreamState.requests.length = 0;
  const res = await viaProxy({ body: { model: 'deepseek-flash', messages: [] } });
  assert.equal(res.status, 200);
  assert.ok(res.text.indexOf('data: one') !== -1);
  assert.ok(res.text.indexOf('data: two') > res.text.indexOf('data: one'));
  assert.ok(res.text.includes('data: [DONE]'));
  upstreamState.mode = 'echo';
});

test('upstream 500 is piped to the client', async () => {
  upstreamState.mode = 'error';
  const res = await viaProxy({ body: { model: 'deepseek-flash', messages: [] } });
  assert.equal(res.status, 500);
  assert.match(res.text, /boom/);
  upstreamState.mode = 'echo';
});

test('aborting a queued non-compliant request cancels its waiter and frees the queue', async () => {
  upstreamState.requests.length = 0;
  const hold = await holder.acquire({ model: 'small-dense' });
  assert.equal(hold.status, 'granted');
  const controller = new AbortController();
  const p = viaProxy({ body: { model: 'small-dense', messages: [] }, signal: controller.signal }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(gpuA(await holder.status()).waiters.length, 1);
  controller.abort();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(gpuA(await holder.status()).waiters.length, 0);
  assert.equal(upstreamState.requests.length, 0); // never forwarded
  holder.release(hold.leaseId);
  const settled = await p;
  assert.ok(settled instanceof Error); // the aborted fetch rejected
});

test('fail-open: with the daemon down the proxy forwards without queueing', async () => {
  // Last test: take the daemon down and do not restore it.
  udsServer.close();
  udsServer = null;
  // Let the proxy's client flip to degraded.
  await new Promise((r) => setTimeout(r, 800));
  upstreamState.requests.length = 0;
  const res = await viaProxy({ body: { model: 'small-dense', messages: [] } });
  assert.equal(res.status, 200);
  assert.equal(upstreamState.requests.length, 1);
});
