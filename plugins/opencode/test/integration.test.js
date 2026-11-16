import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Queues } from '../../../daemon/lib/queues.js';
import { Audit } from '../../../daemon/lib/audit.js';
import { EventFeed, handleConnection } from '../../../daemon/lib/protocol.js';
import { TanClient } from '../../../client/index.mjs';
import { createGate } from '../gate.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tan-oc-plugin-'));
const sockPath = join(dir, 'tan.sock');

let udsServer;
let queues;

before(async () => {
  queues = new Queues({
    queues: [{ id: 'apu', limit: 1, models: ['big-moe'] }],
    unmapped: 'unlimited',
    queueLimit: 10,
  });
  const audit = new Audit(join(dir, 'audit'));
  const feed = new EventFeed();
  feed.setFrameBuilder(() => ({ type: 'status', ...queues.snapshot() }));
  udsServer = createServer((socket) => handleConnection(socket, { queues, audit, feed, version: 'test', uptimeMs: () => 1, persistConfig: () => {} }));
  await new Promise((resolve) => udsServer.listen(sockPath, resolve));
});

after(() => {
  udsServer.close();
  rmSync(dir, { recursive: true, force: true });
});

function pluginClient(instance) {
  return new TanClient({ sock: sockPath, harness: 'opencode', instance, capability: 'dynamic', degradedAfterMs: 200 });
}

test('gate acquires a dynamic grant, the proxy claims it by token, release frees the slot', { timeout: 10_000 }, async () => {
  const tan = pluginClient('oc');
  try {
    await tan.connect();
    const { gate } = createGate({ tan, instance: 'oc', queues: [{ queue: 'apu', models: ['big-moe'] }] });
    const headers = await gate({ model: 'big-moe', sessionID: 'ses_1', agent: 'build' });
    assert.equal(headers['x-tan-client'], 'oc');
    assert.ok(headers['x-tan-claim'], 'grant must mint a claim token');
    // Proxy-side claim: exactly what proxy/lib/admit.js does with the headers.
    const claim = await tan.checkout({ model: 'big-moe', instance: 'oc', token: headers['x-tan-claim'] });
    assert.ok(claim.leaseId, 'the token must claim the lease');
    // The token is one-time: a second claim with it misses.
    const again = await tan.checkout({ model: 'big-moe', instance: 'oc', token: headers['x-tan-claim'] });
    assert.equal(again.leaseId, null);
    tan.release(claim.leaseId);
  } finally {
    tan.close();
  }
});

test('gate queues behind a held slot, is granted on release, and claims with a fresh token', { timeout: 10_000 }, async () => {
  const holder = new TanClient({ sock: sockPath, harness: 'dsh', instance: 'web' });
  const tan = pluginClient('oc');
  try {
    await holder.connect();
    await tan.connect();
    const hold = await holder.acquire({ model: 'big-moe' });
    assert.equal(hold.status, 'granted');
    const { gate } = createGate({ tan, instance: 'oc', queues: [{ queue: 'apu', models: ['big-moe'] }] });
    const gatePromise = gate({ model: 'big-moe', sessionID: 'ses_2' });
    // Give the gate a moment to enter the queue, then release the hold.
    await new Promise((r) => setTimeout(r, 150));
    const snap = queues.snapshot();
    const apu = snap.queues.find((q) => q.id === 'apu');
    assert.equal(apu.waiters.length, 1, 'the plugin must be queued behind the hold');
    holder.release(hold.leaseId);
    const headers = await gatePromise;
    assert.ok(headers['x-tan-claim'], 'the promoted grant must carry a claim token');
    const claim = await tan.checkout({ model: 'big-moe', instance: 'oc', token: headers['x-tan-claim'] });
    assert.ok(claim.leaseId);
    tan.release(claim.leaseId);
  } finally {
    holder.close();
    tan.close();
  }
});

test('the gate rides on a grant whose token lapses: sweep frees the unclaimed lease', { timeout: 10_000 }, async () => {
  const tan = pluginClient('oc');
  try {
    await tan.connect();
    const { gate } = createGate({ tan, instance: 'oc', queues: [{ queue: 'apu', models: ['big-moe'] }] });
    const headers = await gate({ model: 'big-moe' });
    assert.ok(headers['x-tan-claim']);
    // Never claim. Force the clock past the grant TTL and sweep.
    const before = queues.snapshot().queues.find((q) => q.id === 'apu').used;
    assert.equal(before, 1);
    // sweepStaleGrants takes an explicit now; push it past the 30 s TTL.
    const swept = queues.sweepStaleGrants(Date.now() + 31_000);
    assert.equal(swept, 1);
    const after = queues.snapshot().queues.find((q) => q.id === 'apu').used;
    assert.equal(after, 0);
  } finally {
    tan.close();
  }
});
