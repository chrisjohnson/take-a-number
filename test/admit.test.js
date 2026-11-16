import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmitter } from '../proxy/lib/admit.js';
import { TanError } from '../client/index.mjs';

// A stand-in TanClient whose responses are scripted per call. Records every
// call so tests can assert which path the admitter took.
function fakeClient(script = {}) {
  const calls = { checkout: [], acquire: [], waitFor: [], cancel: [], release: [] };
  const waitResults = script.waitForResults ? [...script.waitForResults] : null;
  return {
    calls,
    degraded: false,
    async checkout(a) {
      calls.checkout.push(a);
      return script.checkout ? script.checkout(a) : { leaseId: null, queue: null };
    },
    async acquire(f) {
      calls.acquire.push(f);
      return script.acquire ? script.acquire(f) : { status: 'granted', leaseId: 'L-grant', queue: 'q' };
    },
    async waitFor(a) {
      calls.waitFor.push(a);
      if (waitResults) {
        const next = waitResults.shift();
        if (next) return next;
      }
      return script.waitFor ? script.waitFor(a) : { status: 'granted', leaseId: 'L-wait', queue: 'q' };
    },
    cancel(id) {
      calls.cancel.push(id);
      return { cancelled: true };
    },
    release(id) {
      calls.release.push(id);
    },
  };
}

const signal = () => new AbortController().signal;

test('compliant checkout hit claims the held lease and skips acquire', async () => {
  const client = fakeClient({ checkout: () => ({ leaseId: 'L-held', queue: 'q' }) });
  const admit = createAdmitter({ client });
  const decision = await admit({ model: 'small-dense', instance: 'web' });
  assert.equal(decision.leaseId, 'L-held');
  assert.equal(decision.source, 'checkout');
  assert.equal(client.calls.acquire.length, 0);
  assert.equal(client.calls.checkout.length, 1);
});

test('compliant checkout miss falls through to the hard path', async () => {
  const client = fakeClient({ checkout: () => ({ leaseId: null, queue: null }) });
  const admit = createAdmitter({ client });
  const decision = await admit({ model: 'small-dense', instance: 'web' });
  assert.equal(decision.source, 'granted');
  assert.equal(client.calls.acquire.length, 1);
});

test('a claimToken is passed to checkout (dynamic client)', async () => {
  const client = fakeClient({ checkout: () => ({ leaseId: 'L-held', queue: 'q' }) });
  const admit = createAdmitter({ client });
  const decision = await admit({ model: 'small-dense', instance: 'lab-a', claimToken: 'tok-123' });
  assert.equal(decision.leaseId, 'L-held');
  assert.equal(decision.source, 'checkout');
  assert.deepEqual(client.calls.checkout[0], { model: 'small-dense', instance: 'lab-a', token: 'tok-123' });
});

test('no claimToken omits the token key from checkout (static client)', async () => {
  const client = fakeClient({ checkout: () => ({ leaseId: 'L-held', queue: 'q' }) });
  const admit = createAdmitter({ client });
  await admit({ model: 'small-dense', instance: 'web' });
  assert.deepEqual(client.calls.checkout[0], { model: 'small-dense', instance: 'web' });
  assert.equal('token' in client.calls.checkout[0], false);
});

test('no instance name goes straight to the hard path (no checkout)', async () => {
  const client = fakeClient();
  const admit = createAdmitter({ client });
  const decision = await admit({ model: 'small-dense' });
  assert.equal(decision.source, 'granted');
  assert.equal(client.calls.checkout.length, 0);
  assert.equal(client.calls.acquire.length, 1);
});

test('hard acquire granted / unlimited / degraded', async () => {
  const granted = createAdmitter({ client: fakeClient({ acquire: () => ({ status: 'granted', leaseId: 'A', queue: 'q' }) }) });
  assert.equal((await granted({ model: 'm' })).leaseId, 'A');

  const unlimited = createAdmitter({ client: fakeClient({ acquire: () => ({ status: 'unlimited', leaseId: 'U', queue: null }) }) });
  const u = await unlimited({ model: 'deepseek-flash' });
  assert.equal(u.leaseId, 'U');
  assert.equal(u.source, 'unlimited');

  const degraded = createAdmitter({ client: fakeClient({ acquire: () => ({ status: 'degraded', leaseId: null, queue: null }) }) });
  assert.equal((await degraded({ model: 'm' })).source, 'degraded');
});

test('hard queued: waits through a still-queued tick, then grants', async () => {
  const client = fakeClient({
    acquire: () => ({ status: 'queued', waiterId: 'W1', queue: 'q', position: 1 }),
    waitForResults: [
      { status: 'still-queued', position: 1, active: 1, limit: 1 },
      { status: 'granted', leaseId: 'L-promo', queue: 'q', waitedMs: 5 },
    ],
  });
  const admit = createAdmitter({ client });
  const decision = await admit({ model: 'm' });
  assert.equal(decision.leaseId, 'L-promo');
  assert.equal(decision.source, 'acquire');
  assert.equal(client.calls.waitFor.length, 2);
});

test('unparseable/absent model is forwarded as unmapped (no queue key)', async () => {
  const client = fakeClient({ acquire: () => ({ status: 'unlimited', leaseId: 'U', queue: null }) });
  const admit = createAdmitter({ client });
  const decision = await admit({ model: null });
  assert.equal(decision.source, 'unlimited');
  assert.equal(client.calls.acquire[0].model, undefined);
});

test('aborted before admitting throws ABORTED and touches nothing', async () => {
  const client = fakeClient();
  const admit = createAdmitter({ client });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => admit({ model: 'm', signal: controller.signal }), (e) => e instanceof TanError && e.code === 'ABORTED');
  assert.equal(client.calls.acquire.length, 0);
});

test('aborted while queued cancels the waiter and throws ABORTED', async () => {
  const client = fakeClient({
    acquire: () => ({ status: 'queued', waiterId: 'W2', queue: 'q', position: 1 }),
    // The long-poll resolves late (like a real timeout); the abort must win
    // the race before it does. Resolving (not hanging) keeps the test from
    // leaking a pending promise.
    waitFor: () => new Promise((resolve) => setTimeout(() => resolve({ status: 'still-queued', position: 1 }), 50)),
  });
  const admit = createAdmitter({ client });
  const controller = new AbortController();
  const promise = admit({ model: 'm', signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, (e) => e instanceof TanError && e.code === 'ABORTED');
  assert.deepEqual(client.calls.cancel, ['W2']);
});

test('a cancelled waiter throws CANCELLED', async () => {
  const client = fakeClient({
    acquire: () => ({ status: 'queued', waiterId: 'W3', queue: 'q', position: 1 }),
    waitFor: () => ({ status: 'cancelled' }),
  });
  const admit = createAdmitter({ client });
  await assert.rejects(() => admit({ model: 'm', signal: signal() }), (e) => e instanceof TanError && e.code === 'CANCELLED');
});
