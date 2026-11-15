// take-a-number daemon entrypoint.
//
// Listens on a UDS (protocol only) and a TCP port (protocol + HTTP + dashboard,
// routed by sniffing the first line of each connection). The HTTP surface is the
// dashboard: GET /, GET /api/status, GET /api/audit, GET /api/events (NDJSON),
// POST /api/set-limits.

import { createServer } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, userInfo } from 'node:os';

import { Queues } from './lib/queues.js';
import { Audit } from './lib/audit.js';
import { EventFeed, handleConnection, connectEvents } from './lib/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VERSION = '0.1.4';

function parseArgs(argv) {
  const args = {
    sock: '/run/take-a-number/tan.sock',
    tcp: '127.0.0.1:4100',
    config: '/etc/take-a-number/config.json',
    audit: '/var/lib/take-a-number/audit',
    dashboard: join(__dirname, '..', 'dashboard'),
    version: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--sock': args.sock = argv[++i]; break;
      case '--tcp': args.tcp = argv[++i]; break;
      case '--config': args.config = argv[++i]; break;
      case '--audit': args.audit = argv[++i]; break;
      case '--dashboard': args.dashboard = argv[++i]; break;
      case '--version': args.version = true; break;
      case '--help': args.help = true; break;
      default:
        process.stderr.write(`unknown argument: ${arg}\n`);
        process.exit(2);
    }
  }
  return args;
}

const HELP = `take-a-number daemon

usage: node daemon/main.js [--sock PATH] [--tcp HOST:PORT] [--config PATH] [--audit DIR] [--dashboard DIR]

  --sock PATH        UDS path (default /run/take-a-number/tan.sock)
  --tcp HOST:PORT    TCP listen address (default 127.0.0.1:4100; loopback only)
  --config PATH      queue config JSON (default /etc/take-a-number/config.json)
  --audit DIR        audit JSONL directory (default /var/lib/take-a-number/audit)
  --dashboard DIR    dashboard static files (default <repo>/dashboard)
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// --- config -----------------------------------------------------------------

function loadConfig(path) {
  if (!existsSync(path)) {
    process.stderr.write(`take-a-number: no config at ${path}; starting with no queues (all calls unlimited)\n`);
    return { queues: [], unmapped: 'unlimited', queueLimit: 1000 };
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    queues: (raw.queues ?? []).map((entry) => ({ ...entry, limit: entry.unlimited === true ? Infinity : Number(entry.limit ?? 1) })),
    unmapped: raw.unmapped === 'reject' ? 'reject' : 'unlimited',
    queueLimit: Number.isInteger(raw.queueLimit) && raw.queueLimit >= 1 ? raw.queueLimit : 1000,
  };
}

function serializeConfig(config) {
  return JSON.stringify(
    {
      queues: config.queues.map((entry) => (entry.limit === Infinity ? { ...entry, limit: null, unlimited: true } : entry)),
      unmapped: config.unmapped,
      queueLimit: config.queueLimit,
    },
    null,
    2,
  ) + '\n';
}

const config = loadConfig(args.config);

// --- core --------------------------------------------------------------------

const startedAt = Date.now();
const uptimeMs = () => Date.now() - startedAt;

const audit = new Audit(args.audit, (line) => process.stderr.write(`take-a-number: ${line}\n`));
const queues = new Queues({
  queues: config.queues,
  unmapped: config.unmapped,
  queueLimit: config.queueLimit,
});
const feed = new EventFeed();
feed.setFrameBuilder(() => ({ type: 'status', asOf: Date.now(), uptimeMs: uptimeMs(), version: VERSION, ...queues.snapshot() }));
connectEvents(queues, feed, audit);

const persistConfig = () => {
  const dir = dirname(args.config);
  mkdirSync(dir, { recursive: true });
  writeFileSync(args.config, serializeConfig({ queues: [...queues.buckets.values()].map((b) => ({ id: b.id, limit: b.limit, models: [...queues.modelQueue.entries()].filter(([, q]) => q === b.id).map(([m]) => m) })), unmapped: queues.unmapped, queueLimit: queues.queueLimit }), 'utf8');
};

audit.record({ event: 'daemon_started', version: VERSION, pid: process.pid, queues: config.queues.map((q) => ({ id: q.id, limit: q.limit === Infinity ? null : q.limit, models: q.models ?? [] })) });

// --- HTTP --------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readBody(head, maxBytes = 64 * 1024) {
  const headerEnd = head.indexOf('\r\n\r\n');
  if (headerEnd === -1) return Promise.reject(new Error('incomplete request head'));
  const headerText = head.slice(0, headerEnd);
  let acc = head.slice(headerEnd + 4);
  const m = /Content-Length: (\d+)/i.exec(headerText);
  const wanted = m ? Number(m[1]) : 0;
  if (wanted > maxBytes) return Promise.reject(new Error('body too large'));
  if (Buffer.byteLength(acc) >= wanted) return Promise.resolve(acc.slice(0, wanted));
  return (socket) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeListener('data', onData);
        reject(new Error('body timeout'));
      }, 5000);
      const onData = (chunk) => {
        acc += chunk.toString('utf8');
        if (Buffer.byteLength(acc) >= wanted) {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          resolve(acc.slice(0, wanted));
        }
      };
      socket.on('data', onData);
    });
}

function httpRespond(socket, status, contentType, body, extraHeaders = []) {
  const head = `HTTP/1.1 ${status}\r\nContent-Type: ${contentType}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\n${extraHeaders.map((h) => `${h}\r\n`).join('')}Connection: close\r\n\r\n`;
  socket.end(`${head}${body}`);
}

async function handleHttp(socket, requestLine, initialData) {
  const [method, target] = requestLine.split(' ');
  const url = new URL(target, 'http://localhost');
  const path = url.pathname;
  if (method === 'OPTIONS') {
    return httpRespond(socket, '204 No Content', 'text/plain', '');
  }
  try {
    if (method === 'GET' && path === '/api/status') {
      return httpRespond(socket, '200 OK', 'application/json', JSON.stringify({ uptimeMs: uptimeMs(), version: VERSION, ...queues.snapshot() }));
    }
    if (method === 'GET' && path === '/api/audit') {
      const { lines, total, truncated } = audit.query({
        identity: url.searchParams.get('identity') ?? undefined,
        queue: url.searchParams.get('queue') ?? undefined,
        model: url.searchParams.get('model') ?? undefined,
        kind: url.searchParams.get('kind') ?? undefined,
        modality: url.searchParams.get('modality') ?? undefined,
        from: url.searchParams.has('from') ? Number(url.searchParams.get('from')) : undefined,
        to: url.searchParams.has('to') ? Number(url.searchParams.get('to')) : undefined,
        limit: Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200), 1), 2000),
      });
      return httpRespond(socket, '200 OK', 'application/json', JSON.stringify({ lines, total, truncated }));
    }
    if (method === 'GET' && path === '/api/events') {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: *\r\nConnection: keep-alive\r\n\r\n');
      const unsubscribe = feed.subscribe((line) => {
        try {
          socket.write(line);
        } catch {
          // gone
        }
      });
      socket.on('close', unsubscribe);
      return; // keep the socket open
    }
    if (method === 'POST' && path === '/api/cancel') {
      const body = await (await readBody(initialData))(socket);
      const { waiterId } = body === '' ? {} : JSON.parse(body);
      if (typeof waiterId !== 'string') return httpRespond(socket, '400 Bad Request', 'application/json', JSON.stringify({ error: 'waiterId required' }));
      return httpRespond(socket, '200 OK', 'application/json', JSON.stringify({ cancelled: queues.cancel(waiterId) }));
    }
    if (method === 'POST' && path === '/api/force-release') {
      const body = await (await readBody(initialData))(socket);
      const { leaseId } = body === '' ? {} : JSON.parse(body);
      if (typeof leaseId !== 'string') return httpRespond(socket, '400 Bad Request', 'application/json', JSON.stringify({ error: 'leaseId required' }));
      return httpRespond(socket, '200 OK', 'application/json', JSON.stringify({ released: queues.forceRelease(leaseId) }));
    }
    if (method === 'POST' && path === '/api/set-limits') {
      const body = await (await readBody(initialData))(socket);
      const payload = JSON.parse(body === '' ? '{}' : body);
      if (!Array.isArray(payload.queues)) {
        return httpRespond(socket, '400 Bad Request', 'application/json', JSON.stringify({ error: 'queues array required' }));
      }
      queues.configure(payload.queues.map((entry) => ({ ...entry, limit: entry.unlimited === true ? Infinity : entry.limit })));
      if (Number.isInteger(payload.queueLimit) && payload.queueLimit >= 1) queues.queueLimit = payload.queueLimit;
      try {
        persistConfig();
      } catch {
        // best effort
      }
      return httpRespond(socket, '200 OK', 'application/json', JSON.stringify(queues.snapshot()));
    }
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      const index = join(args.dashboard, 'index.html');
      if (existsSync(index)) {
        return httpRespond(socket, '200 OK', MIME['.html'], readFileSync(index, 'utf8'));
      }
      return httpRespond(socket, '200 OK', 'text/plain; charset=utf-8', `take-a-number ${VERSION} — dashboard not installed\n`);
    }
    if (method === 'GET' && path.startsWith('/static/')) {
      const name = path.slice('/static/'.length);
      if (name.includes('..') || name.includes('\0')) return httpRespond(socket, '400 Bad Request', 'text/plain', 'bad path');
      const file = join(args.dashboard, name);
      if (!file.startsWith(args.dashboard) || !existsSync(file)) return httpRespond(socket, '404 Not Found', 'text/plain', 'not found');
      const ext = file.slice(file.lastIndexOf('.'));
      return httpRespond(socket, '200 OK', MIME[ext] ?? 'application/octet-stream', readFileSync(file));
    }
    return httpRespond(socket, '404 Not Found', 'application/json', JSON.stringify({ error: 'not found' }));
  } catch (error) {
    try {
      httpRespond(socket, '500 Internal Server Error', 'application/json', JSON.stringify({ error: String(error?.message ?? error) }));
    } catch {
      socket.destroy();
    }
  }
  void initialData;
}

// --- servers -----------------------------------------------------------------

function routeConnection(socket, initialData) {
  const firstLine = initialData.toString('utf8').split('\r\n')[0].split('\n')[0];
  const isHttp = /^GET |^POST |^HEAD |^PUT |^DELETE /.test(firstLine);
  if (isHttp) {
    handleHttp(socket, firstLine, initialData);
    return;
  }
  handleConnection(socket, { queues, audit, feed, version: VERSION, uptimeMs, persistConfig }, initialData);
}

const { host, port } = (() => {
  const [h, p] = args.tcp.split(':');
  return { host: h ?? '127.0.0.1', port: Number(p) };
})();
if (host !== '127.0.0.1' && host !== 'localhost') {
  process.stderr.write('take-a-number: TCP must bind loopback (127.0.0.1); refusing\n');
  process.exit(2);
}

const tcpServer = createServer((socket) => {
  socket.once('data', (chunk) => routeConnection(socket, chunk));
});
const udsServer = createServer((socket) => {
  socket.once('data', (chunk) => handleConnection(socket, { queues, audit, feed, version: VERSION, uptimeMs, persistConfig }, chunk));
});

const shutdown = (signal) => {
  process.stderr.write(`take-a-number: ${signal} received, shutting down\n`);
  audit.record({ event: 'daemon_stopped', pid: process.pid });
  feed.close();
  tcpServer.close();
  udsServer.close();
  try {
    writeFileSync(args.sock + '.down', String(Date.now()));
  } catch {
    // best effort
  }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

tcpServer.listen(port, host, () => {
  process.stderr.write(`take-a-number ${VERSION}: TCP http+protocol on http://${host}:${port}\n`);
});
udsServer.listen(args.sock, () => {
  try {
    // 0777, not the umask default: the queue is a machine-wide service and
    // every local user's harness (dsh, opencode, the CLI) must be able to
    // connect. Node creates the socket srwxr-xr-x, which makes connect()
    // EACCES for everyone but tan — the daemon is the only authority here
    // (per-connection identity, loopback box), so world-connect is the point.
    chmodSync(args.sock, 0o777);
  } catch {
    // a mode failure is surfaced by clients as degraded, not fatal
  }
  process.stderr.write(`take-a-number ${VERSION}: UDS protocol on ${args.sock}\n`);
});
tcpServer.on('error', (error) => {
  process.stderr.write(`take-a-number: TCP listen error: ${error.message}\n`);
  process.exit(1);
});
udsServer.on('error', (error) => {
  process.stderr.write(`take-a-number: UDS listen error: ${error.message}\n`);
  process.exit(1);
});
