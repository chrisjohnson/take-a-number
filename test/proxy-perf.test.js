// take-a-number proxy: LATENCY BENCHMARK (not a correctness test).
//
// Measures the latency the admission proxy adds to a model call, in the shape
// the agent harness actually makes: a tight sequential loop of quick
// inference calls (inference -> tool -> inference -> tool -> ...). Each call
// is a small request/response against a fast mock upstream, so we isolate the
// proxy's contribution (daemon round-trips + the HTTP hop), not model time.
//
// Three paths are measured and compared:
//   - direct     : fetch straight to the upstream (no proxy) — the baseline.
//   - compliant  : the real dsh/opencode flow — the client reserves a lease
//                  (acquire), then the request goes through the proxy, which
//                  checks the lease out and releases it on settle.
//   - hard       : a non-compliant caller — no identity; the proxy acquires
//                  and releases on its own.
//
// "Proxy overhead" = (proxied path) - (direct). This runs in the normal test
// suite on every `node --test`, so a future change that adds a round-trip, a
// blocking call, or an accidental queue wait fails the bound and gets noticed.
// The bound is deliberately generous: it catches a real regression, and it
// never flakes on a busy box.

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

// Iterations per path. Enough for a stable p95, small enough to keep the
// suite fast. Override with TAN_PERF_N for a heavier local run.
const N = Math.max(10, Number(process.env.TAN_PERF_N ?? 60));
// Generous regression bound on the compliant path's average overhead.
const MAX_COMPLIANT_OVERHEAD_MS = 25;

const dir = mkdtempSync(join(tmpdir(), 'tan-perf-'));
const sockPath = join(dir, 'tan.sock');
const benchBody = JSON.stringify({ model: 'bench', messages: [{ role: 'user', content: 'ping' }] });
const jsonHeaders = { 'content-type': 'application/json' };

let queues, audit, feed, udsServer, upstream, upstreamPort, proxy, proxyPort, holder;

before(async () => {
  // A limit-1 queue with a single benchmark caller: every call is granted
  // immediately, so we measure proxy overhead, never queue wait.
  queues = new Queues({
    queues: [{ id: 'gpu-a', limit: 1, models: ['bench'] }],
    unmapped: 'unlimited',
    queueLimit: 10,
  });
  audit = new Audit(join(dir, 'audit'));
  feed = new EventFeed();
  feed.setFrameBuilder(() => ({ type: 'status', ...queues.snapshot() }));
  connectEvents(queues, feed, audit);
  udsServer = createServer((socket) =>
    handleConnection(socket, { queues, audit, feed, version: 'test', uptimeMs: () => 1, persistConfig: () => {} }));
  udsServer.listen(sockPath);

  // Fast mock upstream: a small JSON body, no artificial delay.
  upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, choices: [{ message: { content: 'pong' } }] }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;

  proxy = await startProxy({
    upstream: `127.0.0.1:${upstreamPort}`,
    listen: '127.0.0.1:0',
    sock: sockPath,
    tcp: '127.0.0.1:1',
    instance: 'perf-proxy',
  });
  proxyPort = proxy.server.address().port;

  // The compliant caller (stands in for dsh/opencode's plugin).
  holder = new TanClient({ sock: sockPath, tcp: '127.0.0.1:1', harness: 'bench', instance: 'bench', degradedAfterMs: 200 });
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

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { avg: s.reduce((a, b) => a + b, 0) / s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}

const ms = (bigint) => Number(bigint) / 1e6;

async function directLoop(url) {
  const ttfb = [];
  const total = [];
  for (let i = 0; i < N; i += 1) {
    const t0 = process.hrtime.bigint();
    const res = await fetch(url, { method: 'POST', headers: jsonHeaders, body: benchBody });
    ttfb.push(ms(process.hrtime.bigint() - t0)); // headers = first byte
    await res.text();
    total.push(ms(process.hrtime.bigint() - t0));
  }
  return { ttfb: stats(ttfb), total: stats(total) };
}

async function compliantLoop(url) {
  const total = [];
  for (let i = 0; i < N; i += 1) {
    const t0 = process.hrtime.bigint();
    // The harness's plugin reserves a turn before the request (dsh/opencode).
    await holder.acquire({ model: 'bench' });
    const res = await fetch(url, { method: 'POST', headers: { ...jsonHeaders, 'x-tan-client': 'bench' }, body: benchBody });
    await res.text();
    total.push(ms(process.hrtime.bigint() - t0)); // proxy released the lease on settle
  }
  return stats(total);
}

async function hardLoop(url) {
  const total = [];
  for (let i = 0; i < N; i += 1) {
    const t0 = process.hrtime.bigint();
    const res = await fetch(url, { method: 'POST', headers: jsonHeaders, body: benchBody });
    await res.text();
    total.push(ms(process.hrtime.bigint() - t0));
  }
  return stats(total);
}

test(`proxy overhead in a tight ${N}-call inference loop`, async () => {
  const directUrl = `http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
  const proxyUrl = `http://127.0.0.1:${proxyPort}/v1/chat/completions`;

  // Warm up (JIT, socket pools, daemon identity) before measuring.
  await directLoop(directUrl);
  await compliantLoop(proxyUrl);
  await hardLoop(proxyUrl);

  const direct = await directLoop(directUrl);
  const compliant = await compliantLoop(proxyUrl);
  const hard = await hardLoop(proxyUrl);

  const compOver = { avg: compliant.avg - direct.total.avg, p95: compliant.p95 - direct.total.p95 };
  const hardOver = { avg: hard.avg - direct.total.avg, p95: hard.p95 - direct.total.p95 };

  // eslint-disable-next-line no-console
  console.log(`\n=== take-a-number proxy latency benchmark (${N} sequential calls) ===`);
  // eslint-disable-next-line no-console
  console.log(`direct     total  avg ${direct.total.avg.toFixed(2)}ms  p50 ${direct.total.p50.toFixed(2)}  p95 ${direct.total.p95.toFixed(2)}  (ttfb avg ${direct.ttfb.avg.toFixed(2)}ms)`);
  // eslint-disable-next-line no-console
  console.log(`compliant  total  avg ${compliant.avg.toFixed(2)}ms  p50 ${compliant.p50.toFixed(2)}  p95 ${compliant.p95.toFixed(2)}   [reserve + proxy checkout/release]`);
  // eslint-disable-next-line no-console
  console.log(`hard       total  avg ${hard.avg.toFixed(2)}ms  p50 ${hard.p50.toFixed(2)}  p95 ${hard.p95.toFixed(2)}   [proxy acquire/release]`);
  // eslint-disable-next-line no-console
  console.log(`overhead (compliant)  avg ${compOver.avg.toFixed(2)}ms  p95 ${compOver.p95.toFixed(2)}ms`);
  // eslint-disable-next-line no-console
  console.log(`overhead (hard)       avg ${hardOver.avg.toFixed(2)}ms  p95 ${hardOver.p95.toFixed(2)}ms`);
  // eslint-disable-next-line no-console
  console.log('==================================================================\n');

  // The regression guard: the compliant path (what the agent harness uses)
  // must stay well under the bound. A real regression (extra round-trip, a
  // blocking call, an accidental queue wait) blows past this.
  assert.ok(
    compOver.avg < MAX_COMPLIANT_OVERHEAD_MS,
    `compliant proxy overhead avg ${compOver.avg.toFixed(2)}ms exceeds the ${MAX_COMPLIANT_OVERHEAD_MS}ms regression bound`,
  );
});
