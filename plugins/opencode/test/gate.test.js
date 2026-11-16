import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGate } from '../gate.mjs';

const QUEUES = [{ queue: 'apu', models: ['big-moe', 'small-dense'] }];

function fakeTan(overrides = {}) {
  const calls = { acquire: [], waitFor: [], release: [], cancel: [] };
  const tan = {
    calls,
    acquire: async (fields) => {
      calls.acquire.push(fields);
      return overrides.acquire ? overrides.acquire(fields) : { status: 'granted', leaseId: 'L1', queue: 'apu', claimToken: 'tok-1' };
    },
    waitFor: async (fields) => {
      calls.waitFor.push(fields);
      return overrides.waitFor ? overrides.waitFor(fields) : { status: 'granted', leaseId: 'L2', queue: 'apu', claimToken: 'tok-2' };
    },
    release: (leaseId) => calls.release.push(leaseId),
    cancel: (waiterId) => calls.cancel.push(waiterId),
  };
  return tan;
}

function make(overrides = {}, gateOpts = {}) {
  const tan = fakeTan(overrides);
  const { gate } = createGate({ tan, instance: 'oc', queues: QUEUES, ...gateOpts });
  return { tan, gate };
}

test('unmapped model (plugin view) passes through without a daemon round-trip', async () => {
  const { tan, gate } = make();
  const headers = await gate({ model: 'deepseek-flash', sessionID: 's1' });
  assert.deepEqual(headers, {});
  assert.equal(tan.calls.acquire.length, 0);
});

test('empty model passes through', async () => {
  const { tan, gate } = make();
  assert.deepEqual(await gate({ model: '' }), {});
  assert.deepEqual(await gate({}), {});
  assert.equal(tan.calls.acquire.length, 0);
});

test('mapped + immediate grant returns the claim headers and attribution fields', async () => {
  const { tan, gate } = make();
  const headers = await gate({ model: 'big-moe', sessionID: 'ses_123', agent: 'build' });
  assert.deepEqual(headers, { 'x-tan-client': 'oc', 'x-tan-claim': 'tok-1' });
  assert.equal(tan.calls.acquire.length, 1);
  assert.deepEqual(tan.calls.acquire[0], { model: 'big-moe', kind: 'opencode', session: 'ses_123', description: 'opencode · build' });
});

test('mapped + queued long-polls to the grant and uses the grant token', async () => {
  const { tan, gate } = make({
    acquire: () => ({ status: 'queued', waiterId: 'w1', queue: 'apu', position: 2 }),
  });
  const headers = await gate({ model: 'big-moe' });
  assert.deepEqual(headers, { 'x-tan-client': 'oc', 'x-tan-claim': 'tok-2' });
  assert.deepEqual(tan.calls.waitFor, [{ waiterId: 'w1' }]);
  assert.equal(tan.calls.cancel.length, 0);
});

test('still-queued long-poll ticks loop until granted', async () => {
  let ticks = 0;
  const { gate } = make({
    acquire: () => ({ status: 'queued', waiterId: 'w1', queue: 'apu', position: 1 }),
    waitFor: () => {
      ticks += 1;
      return ticks < 3 ? { status: 'still-queued', position: 1 } : { status: 'granted', leaseId: 'L9', queue: 'apu', claimToken: 'tok-9' };
    },
  });
  const headers = await gate({ model: 'big-moe' });
  assert.deepEqual(headers, { 'x-tan-client': 'oc', 'x-tan-claim': 'tok-9' });
  assert.equal(ticks, 3);
});

test('queued + bounded timeout cancels the waiter and passes through', async () => {
  let t = 0;
  const { tan, gate } = make(
    {
      acquire: () => ({ status: 'queued', waiterId: 'w1', queue: 'apu', position: 1 }),
      waitFor: () => {
        t += 500; // each long-poll tick advances the (fake) clock
        return { status: 'still-queued', position: 1 };
      },
    },
    { acquireTimeoutMs: 1000, now: () => t },
  );
  const headers = await gate({ model: 'big-moe' });
  assert.deepEqual(headers, {});
  assert.deepEqual(tan.calls.cancel, ['w1']);
  assert.equal(tan.calls.release.length, 0);
});

test('degraded acquire passes through without cancel or release', async () => {
  const { tan, gate } = make({ acquire: () => ({ status: 'degraded', leaseId: null, queue: 'big-moe' }) });
  assert.deepEqual(await gate({ model: 'big-moe' }), {});
  assert.equal(tan.calls.cancel.length, 0);
  assert.equal(tan.calls.release.length, 0);
});

test('unlimited (stale map) passes through and releases the synthetic lease', async () => {
  const { tan, gate } = make({ acquire: () => ({ status: 'unlimited', leaseId: 'U1', queue: null }) });
  assert.deepEqual(await gate({ model: 'big-moe' }), {});
  assert.deepEqual(tan.calls.release, ['U1']);
});

test('grant without a claim token passes through (never half-identify)', async () => {
  const { gate } = make({ acquire: () => ({ status: 'granted', leaseId: 'L1', queue: 'apu', claimToken: null }) });
  assert.deepEqual(await gate({ model: 'big-moe' }), {});
});

test('acquire refusal (queue full / reject mode) fails open', async () => {
  const err = new Error('queue "apu" is full');
  err.code = 'QUEUE_FULL';
  const { gate } = make({ acquire: () => { throw err; } });
  assert.deepEqual(await gate({ model: 'big-moe' }), {});
});

test('degraded while queued cancels the waiter and passes through', async () => {
  const { tan, gate } = make({
    acquire: () => ({ status: 'queued', waiterId: 'w1', queue: 'apu', position: 1 }),
    waitFor: () => ({ status: 'degraded' }),
  });
  assert.deepEqual(await gate({ model: 'big-moe' }), {});
  assert.deepEqual(tan.calls.cancel, ['w1']);
});

test('waiter cancelled externally passes through', async () => {
  const { tan, gate } = make({
    acquire: () => ({ status: 'queued', waiterId: 'w1', queue: 'apu', position: 1 }),
    waitFor: () => ({ status: 'cancelled' }),
  });
  assert.deepEqual(await gate({ model: 'big-moe' }), {});
  assert.equal(tan.calls.cancel.length, 0);
});
