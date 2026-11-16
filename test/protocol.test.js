import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Queues } from '../daemon/lib/queues.js';
import { Audit } from '../daemon/lib/audit.js';
import { EventFeed, handleConnection, connectEvents } from '../daemon/lib/protocol.js';

const dir = mkdtempSync(join(tmpdir(), 'tan-test-'));
const sockPath = join(dir, 'tan.sock');
const tcpHost = '127.0.0.1';
const tcpPort = 4198;

let tcpServer;
let udsServer;
let queues;
let audit;
let feed;

function deps() {
  return { queues, audit, feed, version: 'test', uptimeMs: () => 1, persistConfig: () => {} };
}

before(() => {
  queues = new Queues({
    queues: [{ id: 'gpu-a', limit: 1, models: ['small-dense'] }],
    unmapped: 'unlimited',
    queueLimit: 10,
  });
  audit = new Audit(join(dir, 'audit'));
  feed = new EventFeed();
  feed.setFrameBuilder(() => ({ type: 'status', ...queues.snapshot() }));
  connectEvents(queues, feed, audit);
  udsServer = createServer((socket) => handleConnection(socket, deps()));
  tcpServer = createServer((socket) => handleConnection(socket, deps()));
  udsServer.listen(sockPath);
  tcpServer.listen(tcpPort, tcpHost);
});

after(() => {
  feed.close();
  udsServer.close();
  tcpServer.close();
  rmSync(dir, { recursive: true, force: true });
});

function session(socket) {
  const pending = new Map();
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      const msg = JSON.parse(line);
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg);
        else entry.reject(new Error(`${msg.error?.code}: ${msg.error?.message}`));
      }
    }
  });
  let nextId = 0;
  return {
    request(type, fields = {}) {
      const id = `t${nextId += 1}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(JSON.stringify({ id, type, ...fields }) + '\n');
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`timeout waiting for ${type}`));
          }
        }, 4000).unref();
      });
    },
    raw: socket,
  };
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: sockPath }, () => resolve(socket));
    socket.on('error', reject);
  });
}

async function registered() {
  const socket = await openSocket();
  const s = session(socket);
  const res = await s.request('register', { harness: 'test', instance: 'unit', pid: 1, host: 'testhost', user: 'tester' });
  s.identityId = res.identityId;
  return s;
}

test('register is required first', async () => {
  const s = await registered();
  await s.request('register', { harness: 'test' }).then(
    () => assert.fail('second register should fail'),
    (error) => assert.match(error.message, /ALREADY_REGISTERED/),
  );
  s.raw.destroy();
});

test('acquire grants, second queues, release promotes via wait', async () => {
  const a = await registered();
  const b = await registered();
  const first = await a.request('acquire', { model: 'small-dense', kind: 'interactive-chat', description: 'holder' });
  assert.equal(first.status, 'granted');
  const second = await b.request('acquire', { model: 'small-dense' });
  assert.equal(second.status, 'queued');
  assert.equal(second.position, 1);

  const waitPromise = b.request('wait', { waiterId: second.waiterId, timeoutMs: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const release = await a.request('release', { leaseId: first.leaseId });
  assert.equal(release.released, true);
  const wait = await waitPromise;
  assert.equal(wait.status, 'granted');
  assert.equal(wait.queue, 'gpu-a');
  assert.ok(wait.waitedMs >= 0);
  await b.request('release', { leaseId: wait.leaseId });
  a.raw.destroy();
  b.raw.destroy();
});

test('checkout over the wire claims a clientToken-stamped lease, once', async () => {
  const a = await registered();
  const first = await a.request('acquire', { model: 'small-dense', clientToken: 'tok-wire' });
  assert.equal(first.status, 'granted');

  const claim = await a.request('checkout', { model: 'small-dense', clientToken: 'tok-wire' });
  assert.equal(claim.ok, true);
  assert.equal(claim.leaseId, first.leaseId);
  assert.equal(claim.queue, 'gpu-a');

  // Second claim on the same lease is a miss.
  const again = await a.request('checkout', { model: 'small-dense', clientToken: 'tok-wire' });
  assert.equal(again.leaseId, null);

  await a.request('release', { leaseId: first.leaseId });
  a.raw.destroy();
});

test('checkout without a matching lease or token returns null, not an error', async () => {
  const a = await registered();
  const res = await a.request('checkout', { model: 'small-dense', clientToken: 'nobody' });
  assert.equal(res.ok, true);
  assert.equal(res.leaseId, null);
  a.raw.destroy();
});

test('wait long-poll times out with still-queued', async () => {
  const a = await registered();
  const b = await registered();
  await a.request('acquire', { model: 'small-dense' });
  const queued = await b.request('acquire', { model: 'small-dense' });
  const started = Date.now();
  const wait = await b.request('wait', { waiterId: queued.waiterId, timeoutMs: 1200 });
  assert.equal(wait.status, 'still-queued');
  assert.equal(wait.position, 1);
  assert.ok(Date.now() - started >= 1100);
  a.raw.destroy();
  b.raw.destroy();
});

test('connection close reclaims leases and waiters (identityDown)', async () => {
  const a = await registered();
  const b = await registered();
  const lease = await a.request('acquire', { model: 'small-dense' });
  await b.request('acquire', { model: 'small-dense' }); // queues behind a
  a.raw.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  // b's waiter is now promoted: status shows b active.
  const status = await b.request('status');
  const gpuA = status.queues.find((q) => q.id === 'gpu-a');
  assert.equal(gpuA.active.length, 1);
  assert.equal(gpuA.active[0].identityId, b.identityId);
  assert.equal(gpuA.waiters.length, 0);
  void lease;
  b.raw.destroy();
});

test('status reflects identities and metadata', async () => {
  const a = await registered();
  await a.request('acquire', { model: 'small-dense', kind: 'set-title', description: 'titled', session: 's1', sessionTitle: 'My Session', turn: 3, modality: 'text' });
  const status = await a.request('status');
  assert.equal(status.totals.active, 1);
  assert.equal(status.identities.length, 1);
  assert.match(status.identities[0].identity, /test\/unit#1@testhost/);
  const active = status.queues.find((q) => q.id === 'gpu-a').active[0];
  assert.equal(active.kind, 'set-title');
  assert.equal(active.sessionTitle, 'My Session');
  assert.equal(active.turn, 3);
  a.raw.destroy();
});

test('cancel frees the queue position', async () => {
  const a = await registered();
  const b = await registered();
  const c = await registered();
  await a.request('acquire', { model: 'small-dense' });
  const w1 = await b.request('acquire', { model: 'small-dense' });
  await c.request('acquire', { model: 'small-dense' });
  const cancelled = await b.request('cancel', { waiterId: w1.waiterId });
  assert.equal(cancelled.cancelled, true);
  const status = await a.request('status');
  const gpuA = status.queues.find((q) => q.id === 'gpu-a');
  assert.equal(gpuA.waiters.length, 1);
  assert.equal(gpuA.waiters[0].identityId, c.identityId);
  assert.equal(gpuA.waiters[0].position, 1);
  a.raw.destroy();
  b.raw.destroy();
  c.raw.destroy();
});

test('force-release frees a held lease', async () => {
  const a = await registered();
  const lease = await a.request('acquire', { model: 'small-dense' });
  const res = await a.request('force-release', { leaseId: lease.leaseId });
  assert.equal(res.released, true);
  const status = await a.request('status');
  assert.equal(status.totals.active, 0);
  a.raw.destroy();
});

test('events stream pushes status frames on activity', async () => {
  const a = await registered();
  const eventsSocket = await openSocket();
  const frames = [];
  let buffer = '';
  eventsSocket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      const msg = JSON.parse(line);
      if (msg.type === 'status') frames.push(msg);
    }
  });
  const registeredAck = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('register timeout')), 2000);
    eventsSocket.once('data', (chunk) => {
      if (chunk.toString('utf8').includes('"identityId"')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  eventsSocket.write(JSON.stringify({ id: 'evreg', type: 'register', harness: 'test', instance: 'events', pid: 9 }) + '\n');
  await registeredAck;
  eventsSocket.write(JSON.stringify({ id: 'ev1', type: 'events' }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
  // trigger activity
  await a.request('acquire', { model: 'small-dense' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(frames.length >= 1, `expected at least one status frame, got ${frames.length}`);
  assert.ok(frames[frames.length - 1].queues.some((q) => q.id === 'gpu-a'));
  eventsSocket.destroy();
  a.raw.destroy();
});

test('event feed sends an initial snapshot on subscribe', () => {
  const frames = [];
  const unsubscribe = feed.subscribe((line) => frames.push(JSON.parse(line)));
  assert.equal(frames.length, 1, 'subscriber gets the current state immediately');
  assert.equal(frames[0].type, 'status');
  assert.ok(frames[0].queues.some((q) => q.id === 'gpu-a'));
  unsubscribe();
});

test('events subscription may open anonymously (no identity churn)', async () => {
  const fs = await import('node:fs');
  const auditFile = () => join(dir, 'audit', fs.readdirSync(join(dir, 'audit')).filter((f) => f.endsWith('.jsonl')).at(-1));
  const countIdentityUps = () => fs.readFileSync(auditFile(), 'utf8').split('\n').filter((l) => l.includes('"event":"identity_up"')).length;
  const before = countIdentityUps();
  const sub = await openSocket();
  let streaming = false;
  sub.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line === '') continue;
      if (JSON.parse(line).streaming === true) streaming = true;
    }
  });
  sub.write(JSON.stringify({ id: 'anon1', type: 'events' }) + '\n');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('streaming ack timeout')), 2000);
    const check = () => streaming && (clearTimeout(timer), resolve());
    sub.on('data', check);
  });
  sub.destroy();
  assert.equal(countIdentityUps(), before, 'anonymous subscription takes no identity');
});

test('audit file captures the session', async () => {
  const a = await registered();
  await a.request('acquire', { model: 'small-dense' });
  await a.request('release', { leaseId: (await a.request('status')).queues.find((q) => q.id === 'gpu-a').active[0].leaseId });
  a.raw.destroy();
  const files = (await import('node:fs')).readdirSync(join(dir, 'audit')).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length >= 1);
  const raw = (await import('node:fs')).readFileSync(join(dir, 'audit', files[0]), 'utf8');
  assert.match(raw, /"event":"identity_up"/);
  assert.match(raw, /"event":"granted"/);
  assert.match(raw, /"event":"released"/);
  assert.match(raw, /"event":"connection_closed"/);
});

test('lease audit events carry the identity, not just its id', async () => {
  const a = await registered();
  const { leaseId } = await a.request('acquire', { model: 'small-dense' });
  await a.request('release', { leaseId });
  a.raw.destroy();
  const files = (await import('node:fs')).readdirSync(join(dir, 'audit')).filter((f) => f.endsWith('.jsonl'));
  const lines = (await import('node:fs')).readFileSync(join(dir, 'audit', files.at(-1)), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const event of ['granted', 'released']) {
    const line = lines.find((l) => l.event === event && l.identityId === a.identityId);
    assert.ok(line, `audit has ${event} for this identity`);
    assert.equal(line.identityId, a.identityId);
    assert.equal(line.harness, 'test');
    assert.ok(line.pid !== undefined, `${event} carries the identity pid`);
  }
});
