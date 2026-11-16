import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queues, TanError } from '../daemon/lib/queues.js';

function make(overrides = {}) {
  const events = [];
  const queues = new Queues({
    queues: [
      { id: 'gpu-a', limit: 1, models: ['small-dense'] },
      { id: 'gpu-b', limit: 2, models: ['medium-dense', 'big-moe'] },
    ],
    unmapped: 'unlimited',
    queueLimit: 5,
    onEvent: (type, payload) => events.push({ type, ...payload }),
    ...overrides,
  });
  return { queues, events };
}

test('admits up to the limit, then queues in FIFO order', () => {
  const { queues } = make();
  const a = queues.acquire({ identityId: 'i1', model: 'small-dense', kind: 'interactive-chat', description: 'turn 1' });
  assert.equal(a.status, 'granted');
  const b = queues.acquire({ identityId: 'i2', model: 'small-dense' });
  assert.equal(b.status, 'queued');
  assert.equal(b.position, 1);
  const c = queues.acquire({ identityId: 'i3', model: 'small-dense' });
  assert.equal(c.position, 2);

  queues.release(a.lease.id);
  const granted = queues.waitersFor('i2').length + queues.waitersFor('i3').length;
  assert.equal(granted, 1); // i2 promoted, i3 still waiting
  assert.equal(queues.used('gpu-a'), 1);

  const snapshot = queues.snapshot();
  const gpuA = snapshot.queues.find((q) => q.id === 'gpu-a');
  assert.equal(gpuA.active.length, 1);
  assert.equal(gpuA.active[0].identityId, 'i2');
  assert.equal(gpuA.waiters[0].identityId, 'i3');
  assert.equal(gpuA.waiters[0].position, 1);
});

test('limit > 1 admits multiple concurrent leases', () => {
  const { queues } = make();
  const a = queues.acquire({ identityId: 'i1', model: 'medium-dense' });
  const b = queues.acquire({ identityId: 'i2', model: 'big-moe' });
  assert.equal(a.status, 'granted');
  assert.equal(b.status, 'granted');
  const c = queues.acquire({ identityId: 'i3', model: 'medium-dense' });
  assert.equal(c.status, 'queued');
});

test('unmapped models get a synthetic unlimited lease and release cleanly', () => {
  const { queues, events } = make();
  const result = queues.acquire({ identityId: 'i1', model: 'deepseek-flash' });
  assert.equal(result.status, 'unlimited');
  assert.equal(result.queue, null);
  assert.equal(queues.release(result.lease.id), true);
  assert.ok(events.some((e) => e.type === 'granted' && e.unlimited === true));
});

test('unmapped reject mode throws', () => {
  const { queues } = make({ unmapped: 'reject' });
  assert.throws(() => queues.acquire({ identityId: 'i1', model: 'deepseek-flash' }), TanError);
});

test('queueLimit bounds the waiters and rejects with QUEUE_FULL', () => {
  const { queues } = make();
  queues.acquire({ identityId: 'i0', model: 'small-dense' });
  for (let i = 1; i <= 5; i += 1) {
    queues.acquire({ identityId: `i${i}`, model: 'small-dense' });
  }
  assert.throws(() => queues.acquire({ identityId: 'i99', model: 'small-dense' }), (error) => error.code === 'QUEUE_FULL');
});

test('cancel frees the slot for the next waiter', () => {
  const { queues } = make();
  const holder = queues.acquire({ identityId: 'i0', model: 'small-dense' });
  const w1 = queues.acquire({ identityId: 'i1', model: 'small-dense' });
  const w2 = queues.acquire({ identityId: 'i2', model: 'small-dense' });
  assert.equal(queues.cancel(w1.waiter.id), true);
  queues.release(holder.lease.id);
  const snapshot = queues.snapshot();
  const gpuA = snapshot.queues.find((q) => q.id === 'gpu-a');
  assert.equal(gpuA.active[0].identityId, 'i2');
  assert.equal(gpuA.waiters.length, 0);
  void w2;
});

test('identityDown releases that identity\'s leases and cancels its waiters', () => {
  const { queues } = make();
  queues.acquire({ identityId: 'gone', model: 'medium-dense' });
  queues.acquire({ identityId: 'gone', model: 'big-moe' });
  queues.acquire({ identityId: 'gone', model: 'medium-dense' }); // 3rd queues
  const other = queues.acquire({ identityId: 'stay', model: 'small-dense' });
  const result = queues.identityDown('gone');
  assert.equal(result.released, 2);
  assert.equal(result.cancelled, 1);
  assert.equal(queues.used('gpu-b'), 0);
  assert.equal(queues.used('gpu-a'), 1);
  assert.equal(queues.release(other.lease.id), true);
  assert.deepEqual(queues.identityDown('nobody'), { released: 0, cancelled: 0 });
});

test('metadata is stored, clamped, and echoed in the snapshot', () => {
  const { queues } = make();
  const long = 'x'.repeat(300);
  const result = queues.acquire({
    identityId: 'i1',
    model: 'small-dense',
    kind: 'set-title',
    description: long,
    session: 'sess-1',
    sessionTitle: 'Fix the deploy script',
    turn: 7,
    modality: 'text',
    meta: { providerId: 'litellm' },
  });
  const lease = result.lease;
  assert.equal(lease.kind, 'set-title');
  assert.equal(lease.description.length, 160);
  assert.ok(lease.description.endsWith('…'));
  assert.equal(lease.sessionTitle, 'Fix the deploy script');
  assert.equal(lease.turn, 7);
  assert.deepEqual(lease.meta, { providerId: 'litellm' });
  const snapshot = queues.snapshot();
  const entry = snapshot.queues.find((q) => q.id === 'gpu-a').active[0];
  assert.equal(entry.sessionTitle, 'Fix the deploy script');
  assert.equal(entry.turn, 7);
});

test('a drain-promoted lease can be released by its own id (regression: waiter id clobber)', () => {
  const { queues } = make();
  const holder = queues.acquire({ identityId: 'i0', model: 'small-dense' });
  const queued = queues.acquire({ identityId: 'i1', model: 'small-dense' });
  let granted = null;
  queues.attachWaiter(queued.waiter.id, { onGranted: (r) => { granted = r; }, onRejected: () => {} });
  queues.release(holder.lease.id);
  assert.ok(granted, 'waiter should be promoted');
  assert.notEqual(granted.lease.id, queued.waiter.id, 'lease id must not be the waiter id');
  assert.equal(queues.leases.has(granted.lease.id), true, 'lease must be findable by its id');
  assert.equal(queues.release(granted.lease.id), true, 'release by lease.id must work');
  assert.equal(queues.used('gpu-a'), 0);
});

test('waiter attach resolves when the slot frees', async () => {
  const { queues } = make();
  const holder = queues.acquire({ identityId: 'i0', model: 'small-dense' });
  const waiter = queues.acquire({ identityId: 'i1', model: 'small-dense' });
  const granted = new Promise((resolve, reject) => {
    queues.attachWaiter(waiter.waiter.id, { onGranted: resolve, onRejected: reject });
  });
  queues.release(holder.lease.id);
  const result = await granted;
  assert.equal(result.granted, true);
  assert.equal(result.queue, 'gpu-a');
  assert.equal(queues.used('gpu-a'), 1);
});

test('configure shrinks a limit without dropping active leases and cancels waiters of removed queues', () => {
  const { queues } = make();
  queues.acquire({ identityId: 'i0', model: 'small-dense' });
  queues.configure([
    { id: 'gpu-a', limit: 1, models: ['small-dense'] },
    { id: 'gpu-b', limit: 1, models: ['medium-dense'] },
  ]);
  // gpu-b lost big-moe; its queue still exists with limit 1.
  assert.equal(queues.limit('gpu-b'), 1);
  // Remove gpu-b entirely:
  queues.configure([{ id: 'gpu-a', limit: 1, models: ['small-dense'] }]);
  assert.equal(queues.buckets.size, 1);
  // medium-dense is now unmapped → unlimited pass-through.
  const r = queues.acquire({ identityId: 'x', model: 'medium-dense' });
  assert.equal(r.status, 'unlimited');
  assert.equal(queues.release(r.lease.id), true);
});

test('history tracks busy seconds oldest-first', () => {
  let now = 1_000_000_000_000;
  const { queues } = make({ now: () => now });
  queues.acquire({ identityId: 'i0', model: 'small-dense' });
  now += 5000; // 5 s busy
  queues.release(queues.snapshot().queues.find((q) => q.id === 'gpu-a').active[0].leaseId);
  now += 5000; // 5 s idle
  const history = queues.history('gpu-a');
  assert.equal(history.length, 60);
  const busy = history.filter((v) => v === 1).length;
  assert.ok(busy >= 4 && busy <= 6, `expected ~5 busy seconds, got ${busy}`);
});

test('rejected acquire is audited', () => {
  const { queues, events } = make();
  queues.acquire({ identityId: 'i0', model: 'small-dense' });
  for (let i = 1; i <= 5; i += 1) queues.acquire({ identityId: `i${i}`, model: 'small-dense' });
  assert.throws(() => queues.acquire({ identityId: 'full', model: 'small-dense' }));
  assert.ok(events.some((e) => e.type === 'rejected' && e.reason === 'queue_full'));
});

test('checkout claims the matching held lease by (model, clientToken), once', () => {
  const { queues } = make();
  const held = queues.acquire({ identityId: 'dsh-1', model: 'small-dense', clientToken: 'tok-A' });
  assert.equal(held.status, 'granted');

  const claim = queues.checkout({ model: 'small-dense', clientToken: 'tok-A' });
  assert.equal(claim.leaseId, held.lease.id);
  assert.equal(claim.queue, 'gpu-a');

  // A second claim for the same lease misses (one checkout per lease).
  assert.equal(queues.checkout({ model: 'small-dense', clientToken: 'tok-A' }), null);
});

test('checkout does not cross models, tokens, or unlimited leases', () => {
  const { queues } = make();
  const held = queues.acquire({ identityId: 'dsh-1', model: 'small-dense', clientToken: 'tok-A' });
  const otherModel = queues.acquire({ identityId: 'dsh-2', model: 'medium-dense', clientToken: 'tok-A' });
  const otherToken = queues.acquire({ identityId: 'dsh-3', model: 'medium-dense', clientToken: 'tok-B' });
  const unlimited = queues.acquire({ identityId: 'dsh-4', model: 'deepseek-flash', clientToken: 'tok-A' });

  // Wrong model for the token.
  assert.equal(queues.checkout({ model: 'medium-dense', clientToken: 'tok-A' })?.leaseId, otherModel.lease.id);
  // Right model, wrong token.
  assert.equal(queues.checkout({ model: 'small-dense', clientToken: 'tok-B' }), null);
  // Unlimited (unmapped) leases are never proxy-claimed.
  assert.equal(unlimited.status, 'unlimited');
  assert.equal(queues.checkout({ model: 'deepseek-flash', clientToken: 'tok-A' }), null);
  void otherToken;
});

test('checkout is oldest-first among a client\'s concurrent leases for one model', () => {
  const { queues } = make({ queues: [{ id: 'gpu-a', limit: 2, models: ['small-dense'] }] });
  const first = queues.acquire({ identityId: 'dsh-1', model: 'small-dense', clientToken: 'tok-A' });
  const second = queues.acquire({ identityId: 'dsh-1', model: 'small-dense', clientToken: 'tok-A' });
  assert.equal(queues.checkout({ model: 'small-dense', clientToken: 'tok-A' }).leaseId, first.lease.id);
  assert.equal(queues.checkout({ model: 'small-dense', clientToken: 'tok-A' }).leaseId, second.lease.id);
  assert.equal(queues.checkout({ model: 'small-dense', clientToken: 'tok-A' }), null);
});

test('checkout misses once the lease is released; release stays idempotent', () => {
  const { queues } = make();
  const held = queues.acquire({ identityId: 'dsh-1', model: 'small-dense', clientToken: 'tok-A' });
  assert.equal(queues.checkout({ model: 'small-dense', clientToken: 'tok-A' }).leaseId, held.lease.id);
  // The proxy releases after forwarding; the client's own release is a no-op.
  assert.equal(queues.release(held.lease.id, 'proxy_forwarded'), true);
  assert.equal(queues.release(held.lease.id, 'released'), false);
});

test('checkout with missing/blank args is a safe no-op', () => {
  const { queues } = make();
  queues.acquire({ identityId: 'dsh-1', model: 'small-dense', clientToken: 'tok-A' });
  assert.equal(queues.checkout({ model: '', clientToken: 'tok-A' }), null);
  assert.equal(queues.checkout({ model: 'small-dense', clientToken: '' }), null);
  assert.equal(queues.checkout({}), null);
});
