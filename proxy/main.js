// take-a-number proxy: the admission gate in front of a litellm (or any
// OpenAI-compatible) upstream. Pipes bytes unmodified (SSE included) and adds
// one local round-trip to the take-a-number daemon per request. Compliant
// clients (x-tan-client header) forward on a lease they already reserved;
// everyone else is hard-queued with the request held open until their turn.
//
//   node proxy/main.js --upstream 127.0.0.1:4000 --listen 127.0.0.1:4140 \
//     --sock /run/take-a-number/tan.sock --instance tan-proxy

import http from 'node:http';
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TanClient } from '../client/index.mjs';
import { createAdmitter } from './lib/admit.js';

const BODY_CAP = 64 * 1024 * 1024;
// A held lease whose response produces no bytes for this long is a hung
// generation (wedged worker, client stuck mid-stream). The proxy kills the
// upstream leg and releases the lease with reason "watchdog". 15 minutes of
// silence is far beyond any cold start, so a legitimate slow generation is
// never touched; the threshold is "no bytes", not "total duration".
const STALL_MS = 15 * 60 * 1000;
// Hop-by-hop headers never cross a proxy (RFC 7230 §6.1) plus host/content-length,
// which the proxy recomputes for the upstream leg.
const STRIP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailing-headers', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  // Proxy-internal admission headers: never forwarded to the upstream model.
  'x-tan-client', 'x-tan-claim',
]);

function parseArgs(argv) {
  const args = {
    upstream: '127.0.0.1:4000',
    listen: '127.0.0.1:4140',
    sock: '/run/take-a-number/tan.sock',
    tcp: '127.0.0.1:4100',
    instance: 'tan-proxy',
    stallMs: STALL_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--upstream') { args.upstream = value; i += 1; }
    else if (key === '--listen') { args.listen = value; i += 1; }
    else if (key === '--sock') { args.sock = value; i += 1; }
    else if (key === '--tcp') { args.tcp = value; i += 1; }
    else if (key === '--instance') { args.instance = value; i += 1; }
    else if (key === '--stall-ms') {
      const ms = Number(value);
      args.stallMs = Number.isFinite(ms) && ms >= 0 ? ms : STALL_MS;
      i += 1;
    }
  }
  return args;
}

function splitHostPort(value, fallbackPort) {
  const [host, port] = value.split(':');
  // port '0' is a valid (ephemeral) port and must not fall through to the default.
  const parsed = port === undefined || port === '' ? fallbackPort : Number(port);
  return { host: host || '127.0.0.1', port: Number.isFinite(parsed) ? parsed : fallbackPort };
}

function stripHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (STRIP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_CAP) {
        reject(new Error(`body exceeds ${BODY_CAP} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// The OpenAI-compatible `model` field selects the queue. Unparseable or absent
// means "unmapped" (forwarded without queueing a specific GPU).
function extractModel(body) {
  if (body === null || body.length === 0) return null;
  try {
    const obj = JSON.parse(body.toString('utf8'));
    return obj && typeof obj.model === 'string' && obj.model !== '' ? obj.model : null;
  } catch {
    return null;
  }
}

// Pipe one request to the upstream and the response back, unmodified. Resolves
// (and calls onSettled exactly once with { stalled }) when the response
// finishes, the client goes away, the upstream errors, or the watchdog fires.
// Never throws.
//
// `stallMs` (0 = off): a resettable silence timer on the response bytes. If no
// byte arrives for `stallMs`, the generation is declared hung: the upstream leg
// is destroyed (frees the GPU) and the settle is flagged `stalled`, so the
// caller can release the lease with a distinct, auditable reason.
function forward(req, res, body, upstream, { signal, onSettled, stallMs = 0 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stalled = false;
    let stallTimer = null;
    const clearStall = () => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearStall();
      try {
        onSettled?.({ stalled });
      } catch {
        // caller problem, not a forwarding problem
      }
      resolve();
    };
    const armStall = () => {
      if (stallMs <= 0) return;
      clearStall();
      stallTimer = setTimeout(() => {
        stallTimer = null;
        stalled = true;
        upstreamReq.destroy();
        // Cut the client's response cleanly: deliver the bytes seen so far,
        // then end, so the caller doesn't hang on a dead stream.
        if (res.headersSent && !res.writableEnded) res.end();
        settle();
      }, stallMs);
      if (typeof stallTimer.unref === 'function') stallTimer.unref();
    };
    if (signal?.aborted) {
      settle();
      return;
    }
    const upstreamReq = http.request(
      { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers: stripHeaders(req.headers), agent: upstream.agent },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, stripHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
        upstreamRes.on('data', armStall);
        upstreamRes.on('end', settle);
        upstreamRes.on('close', settle);
      },
    );
    upstreamReq.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'upstream_error', message: String(error?.message ?? error) }));
      settle();
    });
    if (signal) signal.addEventListener('abort', () => { upstreamReq.destroy(); settle(); }, { once: true });
    res.on('close', () => { upstreamReq.destroy(); settle(); });
    armStall();
    upstreamReq.end(body);
  });
}

function health(res, { degraded, startedAt }) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, degraded, uptimeMs: Date.now() - startedAt }));
}

export async function startProxy({
  upstream, listen, sock, tcp, instance, stallMs = STALL_MS,
  client = new TanClient({ sock, tcp, harness: 'tan-proxy', instance, degradedAfterMs: 500 }),
} = {}) {
  const up = splitHostPort(upstream, 4000);
  const agent = new http.Agent({ keepAlive: true });
  const admit = createAdmitter({ client });
  const startedAt = Date.now();

  await client.connect();

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
      return health(res, { degraded: client.degraded, startedAt });
    }
    const controller = new AbortController();
    // Client abort = the response connection closes before we finished writing.
    // (req's 'close' fires on normal body consumption, so it is the wrong signal.)
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    let body = Buffer.alloc(0);
    try {
      body = await readBody(req);
    } catch {
      if (!res.headersSent) res.writeHead(413, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'body_too_large' }));
    }
    const model = extractModel(body);
    // Self-identification, not a secret: the client's instance name (e.g. "web"),
    // matching the instance it registered with the take-a-number daemon.
    const instance = typeof req.headers['x-tan-client'] === 'string' ? req.headers['x-tan-client'] : null;
    // Dynamic clients also present the one-time claim token minted at grant
    // (x-tan-claim). Static clients omit it; the daemon ignores it for them.
    const claimToken = typeof req.headers['x-tan-claim'] === 'string' && req.headers['x-tan-claim'] !== '' ? req.headers['x-tan-claim'] : undefined;
    try {
      const decision = await admit({ model, instance, claimToken, signal: controller.signal });
      const leaseId = decision.leaseId;
      await forward(req, res, body, { ...up, agent }, {
        signal: controller.signal,
        stallMs,
        onSettled: ({ stalled }) => {
          // A watchdog kill releases with its own reason so the audit can tell
          // a hung-generation abort from a normal settle.
          if (leaseId) client.release(leaseId, stalled ? 'watchdog' : undefined);
        },
      });
    } catch (error) {
      if (error?.code === 'ABORTED') return; // client went away; nothing left to send
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_error', message: String(error?.message ?? error) }));
    }
  });

  const { host, port } = splitHostPort(listen, 4140);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // eslint-disable-next-line no-console
  console.error(`take-a-number proxy: listening on ${listen}, upstream ${upstream}, instance "${instance}"`);
  return {
    server,
    client,
    close: () => new Promise((resolve) => {
      agent.destroy();
      client.close();
      server.close(() => resolve());
    }),
  };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  startProxy(args).catch((error) => {
    // eslint-disable-next-line no-console
    console.error('take-a-number proxy failed to start:', error);
    process.exit(1);
  });
}
