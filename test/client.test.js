import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Queues } from '../daemon/lib/queues.js';
import { Audit } from '../daemon/lib/audit.js';
import { EventFeed, handleConnection, connectEvents } from '../daemon/lib/protocol.js';
import { TanClient, withLease } from '../client/index.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tan-client-'));
const sockPath = join(dir, 'tan.sock');

let udsServer;
let queues;

before(async () => {
  queues = new Queues({
    queues: [{ id: 'gpu-a', limit: 1, models: ['small-dense'] }],
    unmapped: 'unlimited',
    queueLimit: 10,
  });
  const audit = new Audit(join(dir, 'audit'));
  const feed = new EventFeed();
  feed.setFrameBuilder(() => ({ type: 'status', ...queues.snapshot() }));
  connectEvents(queues, feed, audit);
  udsServer = createServer((socket) => handleConnection(socket, { queues, audit, feed, version: 'test', uptimeMs: () => 1, persistConfig: () => {} }));
  await new Promise((resolve) => udsServer.listen(sockPath, resolve));
});

after(() => {
  udsServer.close();
  rmSync(dir, { recursive: true, force: true });
});

function client(instance = 'c1') {
  return new TanClient({ sock: sockPath, harness: 'test', instance, degradedAfterMs: 100 });
}

// Run a test body with a set of clients, always closing them (a live client's
// reconnect loop would keep the test process alive after a failed assertion).
async function withClients(names, fn) {
  const clients = Object.fromEntries(names.map((name) => [name, client(name)]));
  try {
    for (const c of Object.values(clients)) await c.connect();
    return await fn(clients);
  } finally {
    for (const c of Object.values(clients)) c.close();
  }
}

test('acquire grants, release frees the queue', async () => {
  await withClients(['a', 'b'], async ({ a, b }) => {
    const lease = await a.acquire({ model: 'small-dense', kind: 'interactive-chat', description: 'client hold' });
    assert.equal(lease.status, 'granted');
    const queued = await b.acquire({ model: 'small-dense' });
    assert.equal(queued.status, 'queued');
    a.release(lease.leaseId);
    const wait = await b.waitFor({ waiterId: queued.waiterId });
    assert.equal(wait.status, 'granted');
    b.release(wait.leaseId);
  });
});

test('wait after promotion still claims the lease (race: released before the wait arrives)', async () => {
  await withClients(['a', 'b'], async ({ a, b }) => {
    const lease = await a.acquire({ model: 'small-dense' });
    const queued = await b.acquire({ model: 'small-dense' });
    a.release(lease.leaseId); // promotes b before b ever sends `wait`
    const wait = await b.waitFor({ waiterId: queued.waiterId });
    assert.equal(wait.status, 'granted');
    b.release(wait.leaseId);
  });
});

test('withLease gates end-to-end and runs the work under the lease', async () => {
  await withClients(['a', 'b'], async ({ a, b }) => {
    const order = [];
    const workA = withLease(a, { model: 'small-dense', kind: 'call' }, async (leaseId) => {
      order.push(['a', leaseId !== null]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      order.push(['a-done']);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const workB = withLease(b, { model: 'small-dense', kind: 'call' }, async (leaseId) => {
      order.push(['b', leaseId !== null]);
      order.push(['b-done']);
    });
    await Promise.all([workA, workB]);
    assert.deepEqual(order, [['a', true], ['a-done'], ['b', true], ['b-done']]);
  });
});

test('aborting while queued cancels the waiter and rejects', async () => {
  await withClients(['a', 'b'], async ({ a, b }) => {
    const lease = await a.acquire({ model: 'small-dense' });
    const controller = new AbortController();
    const pending = withLease(b, { model: 'small-dense', kind: 'call' }, () => 'should not run', { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100)); // b is queued now
    controller.abort();
    await assert.rejects(pending, (error) => error.code === 'ABORTED');
    // a's lease is intact; b left no waiter behind
    const status = await a.status();
    const gpuA = status.queues.find((q) => q.id === 'gpu-a');
    assert.equal(gpuA.active.length, 1);
    assert.equal(gpuA.waiters.length, 0);
    a.release(lease.leaseId);
  });
});

test('crash (close) reclaims the lease for the next waiter', async () => {
  const a = client('a');
  const b = client('b');
  try {
    await a.connect();
    await b.connect();
    const lease = await a.acquire({ model: 'small-dense' });
    assert.equal(lease.status, 'granted');
    const queued = await b.acquire({ model: 'small-dense' });
    assert.equal(queued.status, 'queued');
    a.close(); // crash: no release
    await new Promise((resolve) => setTimeout(resolve, 80));
    const status = await b.status();
    const gpuA = status.queues.find((q) => q.id === 'gpu-a');
    assert.equal(gpuA.active.length, 1);
    assert.equal(gpuA.active[0].identityId, b.identityId);
  } finally {
    a.close();
    b.close();
  }
});

test('fail-open: daemon down → degraded pass-through, no block', async () => {
  const orphan = new TanClient({ sock: join(dir, 'no-such.sock'), tcp: '127.0.0.1:1', harness: 'test', instance: 'orphan', degradedAfterMs: 50 });
  try {
    const started = Date.now();
    const result = await orphan.acquire({ model: 'small-dense' });
    assert.equal(result.status, 'degraded');
    assert.ok(Date.now() - started < 500, 'degrade must be fast, not a timeout');
  } finally {
    orphan.close();
  }
});

test('events subscription receives status frames on activity', async () => {
  await withClients(['a', 'observer'], async ({ a, observer }) => {
    const frames = [];
    const unsubscribe = observer.events((frame) => frames.push(frame));
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const lease = await a.acquire({ model: 'small-dense' });
      a.release(lease.leaseId);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.ok(frames.length >= 1, `expected frames, got ${frames.length}`);
      assert.ok(frames[0].queues.some((q) => q.id === 'gpu-a'));
    } finally {
      unsubscribe();
    }
  });
});

test('a UDS we may not connect to (EACCES) falls back to TCP', async () => {
  // The daemon chmods its socket 0777, but a client that cannot write the
  // socket file (a different user, a tightened mode) must not loop on the
  // UDS forever — it must fall back to the TCP endpoint. A socket with no
  // write bit denies connect() even for its owner.
  const deniedSock = join(dir, 'denied.sock');
  const uds = createServer(() => {});
  await new Promise((resolve) => uds.listen(deniedSock, resolve));
  chmodSync(deniedSock, 0o555);

  const tcp = createServer((socket) => {
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let index;
      while ((index = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (line === '') continue;
        const msg = JSON.parse(line);
        if (msg.type === 'register') {
          socket.write(JSON.stringify({ id: msg.id, ok: true, identityId: 'test-identity' }) + '\n');
        } else if (msg.type === 'status') {
          socket.write(JSON.stringify({ id: msg.id, ok: true, version: 'test', uptimeMs: 1, totals: { active: 0, waiting: 0 }, queues: [], identities: [] }) + '\n');
        }
      }
    });
  });
  const port = await new Promise((resolve) => tcp.listen(0, '127.0.0.1', () => resolve(tcp.address().port)));

  const c = new TanClient({ sock: deniedSock, tcp: `127.0.0.1:${port}`, harness: 'test', instance: 'e2e', degradedAfterMs: 200 });
  try {
    await c.connect();
    const status = await c.status();
    assert.equal(status.version, 'test');
    assert.equal(c.transport.kind, 'tcp');
  } finally {
    c.close();
    tcp.close();
    uds.close();
    rmSync(deniedSock, { force: true });
  }
});
