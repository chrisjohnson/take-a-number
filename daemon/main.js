// take-a-number daemon entrypoint.
//
// Listens on a UDS (protocol only) and a TCP port (protocol + HTTP + dashboard,
// routed by sniffing the first line of each connection). The HTTP surface
// (dashboard + JSON API, optional ?token= auth) lives in lib/http.js.

import { createServer } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, userInfo } from 'node:os';

import { Queues } from './lib/queues.js';
import { Audit } from './lib/audit.js';
import { EventFeed, handleConnection, connectEvents } from './lib/protocol.js';
import { httpHandler } from './lib/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VERSION = '0.4.0';

function parseArgs(argv) {
  const args = {
    sock: '/run/take-a-number/tan.sock',
    tcp: '127.0.0.1:4100',
    config: '/etc/take-a-number/config.json',
    audit: '/var/lib/take-a-number/audit',
    dashboard: join(__dirname, '..', 'dashboard'),
    authToken: process.env.TAN_AUTH_TOKEN ?? '',
    allowNonLoopback: process.env.TAN_ALLOW_NON_LOOPBACK === '1',
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
      case '--auth-token': args.authToken = argv[++i]; break;
      case '--allow-non-loopback': args.allowNonLoopback = true; break;
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

usage: node daemon/main.js [--sock PATH] [--tcp HOST:PORT] [--config PATH] [--audit DIR] [--dashboard DIR] [--auth-token TOKEN]

  --sock PATH        UDS path (default /run/take-a-number/tan.sock)
  --tcp HOST:PORT    TCP listen address (default 127.0.0.1:4100; loopback only)
  --config PATH      queue config JSON (default /etc/take-a-number/config.json)
  --audit DIR        audit JSONL directory (default /var/lib/take-a-number/audit)
  --dashboard DIR    dashboard static files (default <repo>/dashboard)
  --auth-token T     require ?token=T on the HTTP API (default: $TAN_AUTH_TOKEN,
                     empty = open, for local development). The dashboard page
                     itself stays open so its JS can read the token from the
                     URL and carry it on every API call.
  --allow-non-loopback  permit --tcp on a non-loopback address. Containerized
                     deployments only: docker port publishing forwards to the
                     container's bridge IP, which a loopback bind never sees.
                     The isolation then comes from the host-side publish
                     (127.0.0.1:HOSTPORT:4100) plus the container's own
                     network namespace. Never use this for a native service.
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

// Free granted slots that were never claimed within the grant TTL (a static
// client that never sent its request, or a dynamic client whose claim token
// lapsed), and drop lapsed claim tokens. The Queues class itself is timer-free;
// this is the one daemon-side clock that drives the sweep.
const grantSweepMs = 5000;
const grantSweep = setInterval(() => {
  try {
    queues.sweepStaleGrants();
  } catch {
    // a sweep failure must never take the daemon down
  }
}, grantSweepMs);
grantSweep.unref();

const persistConfig = () => {
  const dir = dirname(args.config);
  mkdirSync(dir, { recursive: true });
  writeFileSync(args.config, serializeConfig({ queues: [...queues.buckets.values()].map((b) => ({ id: b.id, limit: b.limit, models: [...queues.modelQueue.entries()].filter(([, q]) => q === b.id).map(([m]) => m) })), unmapped: queues.unmapped, queueLimit: queues.queueLimit }), 'utf8');
};

audit.record({ event: 'daemon_started', version: VERSION, pid: process.pid, queues: config.queues.map((q) => ({ id: q.id, limit: q.limit === Infinity ? null : q.limit, models: q.models ?? [] })) });

// --- servers -----------------------------------------------------------------

const handleHttp = httpHandler({ queues, audit, feed, version: VERSION, uptimeMs, persistConfig, dashboard: args.dashboard, authToken: args.authToken });

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
if (host !== '127.0.0.1' && host !== 'localhost' && !args.allowNonLoopback) {
  process.stderr.write('take-a-number: TCP must bind loopback (127.0.0.1); refusing (pass --allow-non-loopback for containerized deployments)\n');
  process.exit(2);
}
if (host !== '127.0.0.1' && host !== 'localhost') {
  process.stderr.write('take-a-number: warning: TCP bound to non-loopback ' + host + ' (--allow-non-loopback)\n');
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
    unlinkSync(args.sock);
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
try {
  // A previous instance (or a container restart) may have left the socket
  // file behind; listen() would EADDRINUSE on it.
  if (existsSync(args.sock)) unlinkSync(args.sock);
} catch {
  // best effort — a failure surfaces as a listen error below
}
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
