import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Queues } from '../daemon/lib/queues.js';
import { Audit } from '../daemon/lib/audit.js';
import { EventFeed } from '../daemon/lib/protocol.js';
import { httpHandler } from '../daemon/lib/http.js';

const dir = mkdtempSync(join(tmpdir(), 'tan-http-'));
const TOKEN = 'test-token-123';

let openServer;
let authServer;
let openPort;
let authPort;

function makeServer(authToken, port) {
  const queues = new Queues({
    queues: [{ id: 'gpu-a', limit: 1, models: ['small-dense'] }],
    unmapped: 'unlimited',
    queueLimit: 10,
  });
  const audit = new Audit(join(dir, `audit-${port}`));
  const localFeed = new EventFeed();
  localFeed.setFrameBuilder(() => ({ type: 'status', ...queues.snapshot() }));
  const handle = httpHandler({
    queues,
    audit,
    feed: localFeed,
    version: 'test',
    uptimeMs: () => 1,
    persistConfig: () => {},
    dashboard: join(import.meta.dirname, '..', 'dashboard'),
    authToken,
  });
  const server = createServer((socket) => {
    socket.once('data', (chunk) => handle(socket, chunk.toString('utf8').split('\r\n')[0], chunk));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

before(async () => {
  openServer = await makeServer('', 0);
  authServer = await makeServer(TOKEN, 0);
  openPort = openServer.address().port;
  authPort = authServer.address().port;
});

after(() => {
  openServer.close();
  authServer.close();
  rmSync(dir, { recursive: true, force: true });
});

test('open daemon (no token) serves the API directly', async () => {
  const res = await fetch(`http://127.0.0.1:${openPort}/api/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.queues.some((q) => q.id === 'gpu-a'));
});

test('authed daemon rejects the API without a token', async () => {
  const res = await fetch(`http://127.0.0.1:${authPort}/api/status`);
  assert.equal(res.status, 401);
});

test('authed daemon accepts a correct token', async () => {
  const res = await fetch(`http://127.0.0.1:${authPort}/api/status?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.queues.some((q) => q.id === 'gpu-a'));
});

test('authed daemon rejects a wrong token', async () => {
  const res = await fetch(`http://127.0.0.1:${authPort}/api/status?token=wrong`);
  assert.equal(res.status, 401);
});

test('authed daemon keeps the dashboard shell and static assets open', async () => {
  const page = await fetch(`http://127.0.0.1:${authPort}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /take-a-number/);
  const asset = await fetch(`http://127.0.0.1:${authPort}/static/app.js`);
  assert.equal(asset.status, 200);
});

test('authed daemon gates mutating POSTs', async () => {
  const res = await fetch(`http://127.0.0.1:${authPort}/api/set-limits`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
});
