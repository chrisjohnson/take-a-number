// The daemon's HTTP surface: the dashboard (GET /, /static/*) and the JSON API
// (GET /api/status, GET /api/audit, GET /api/events NDJSON, POST /api/cancel,
// POST /api/force-release, POST /api/set-limits).
//
// Optional token auth: when `authToken` is non-empty, every route except the
// dashboard shell and its static assets requires `?token=<authToken>`. The
// shell stays open so the page's JS can read the token from the URL and carry
// it on every API call.

import { readFileSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function httpHandler({ queues, audit, feed, version, uptimeMs, persistConfig, dashboard, authToken = '' }) {
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

  const authorized = (url) => {
    const presented = url.searchParams.get('token') ?? '';
    return presented !== ''
      && Buffer.byteLength(presented) === Buffer.byteLength(authToken)
      && timingSafeEqual(Buffer.from(presented), Buffer.from(authToken));
  };

  async function handleHttp(socket, requestLine, initialData) {
    const [method, target] = requestLine.split(' ');
    const url = new URL(target, 'http://localhost');
    const path = url.pathname;
    if (authToken !== '') {
      const open = method === 'GET' && (path === '/' || path === '/index.html' || path.startsWith('/static/'));
      if (!open && !authorized(url)) {
        return httpRespond(socket, '401 Unauthorized', 'application/json', JSON.stringify({ error: 'missing or invalid ?token=' }));
      }
    }
    if (method === 'OPTIONS') {
      return httpRespond(socket, '204 No Content', 'text/plain', '');
    }
    try {
      if (method === 'GET' && path === '/api/status') {
        return httpRespond(socket, '200 OK', 'application/json', JSON.stringify({ uptimeMs: uptimeMs(), version, ...queues.snapshot() }));
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
        const index = join(dashboard, 'index.html');
        if (existsSync(index)) {
          return httpRespond(socket, '200 OK', MIME['.html'], readFileSync(index, 'utf8'));
        }
        return httpRespond(socket, '200 OK', 'text/plain; charset=utf-8', `take-a-number ${version} — dashboard not installed\n`);
      }
      if (method === 'GET' && path.startsWith('/static/')) {
        const name = path.slice('/static/'.length);
        if (name.includes('..') || name.includes('\0')) return httpRespond(socket, '400 Bad Request', 'text/plain', 'bad path');
        const file = join(dashboard, name);
        if (!file.startsWith(dashboard) || !existsSync(file)) return httpRespond(socket, '404 Not Found', 'text/plain', 'not found');
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

  return handleHttp;
}
