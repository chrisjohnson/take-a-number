import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Queues } from '../daemon/lib/queues.js';
import { createMetrics } from '../daemon/lib/metrics.js';

const T0 = 1_000_000;

function make() {
  let t = T0;
  const queues = new Queues({
    queues: [
      { id: 'gpu-a', limit: 1, models: ['m1'] },
      { id: 'gpu-b', limit: 2, models: ['m2'] },
    ],
    unmapped: 'unlimited',
    queueLimit: 10,
    now: () => t,
  });
  const metrics = createMetrics({ queues, version: 'test', startedAt: T0 });
  queues.onEvent = (type, payload) => metrics.observe(type, payload);
  return {
    queues,
    metrics,
    advance: (ms) => {
      t += ms;
    },
    render: () => metrics.render(),
  };
}

const line = (text, prefix) => text.split('\n').find((l) => l.startsWith(prefix));

test('renders the empty state', () => {
  const { render } = make();
  const out = render();
  assert.equal(line(out, 'tan_up{version="test"}'), 'tan_up{version="test"} 1');
  assert.equal(line(out, 'tan_identities '), 'tan_identities 0');
  assert.equal(line(out, 'tan_identity_ups_total '), 'tan_identity_ups_total 0');
  assert.equal(line(out, 'tan_queue_depth{queue="gpu-a"}'), 'tan_queue_depth{queue="gpu-a"} 0');
  assert.equal(line(out, 'tan_queue_depth{queue="gpu-b"}'), 'tan_queue_depth{queue="gpu-b"} 0');
  assert.equal(line(out, 'tan_queue_limit{queue="gpu-a"}'), 'tan_queue_limit{queue="gpu-a"} 1');
  assert.equal(line(out, 'tan_queue_limit{queue="gpu-b"}'), 'tan_queue_limit{queue="gpu-b"} 2');
  assert.equal(line(out, 'tan_queue_active{queue="gpu-a"}'), 'tan_queue_active{queue="gpu-a"} 0');
  assert.ok(line(out, '# TYPE tan_grants_total counter'), 'declares the counter family');
  assert.ok(line(out, '# TYPE tan_wait_seconds histogram'), 'declares the histogram family');
  assert.equal(line(out, 'tan_grants_total{'), undefined, 'no counter series until events');
  assert.equal(line(out, 'tan_wait_seconds_bucket'), undefined, 'no histogram series until events');
});

test('tracks active leases, queue depth and identity gauges', () => {
  const { queues, advance, render } = make();
  queues.registerIdentity('i1', { harness: 'test', instance: 'alpha', pid: 1, host: 'h', user: 'u' });
  queues.registerIdentity('i2', { harness: 'test', instance: 'beta', pid: 2, host: 'h', user: 'u' });
  const a = queues.acquire({ identityId: 'i1', model: 'm1' });
  assert.equal(a.status, 'granted');
  advance(3000);
  const b = queues.acquire({ identityId: 'i2', model: 'm1' });
  assert.equal(b.status, 'queued');
  advance(3000);
  const out = render();
  assert.equal(line(out, 'tan_identities '), 'tan_identities 2');
  assert.equal(line(out, 'tan_identity_ups_total '), 'tan_identity_ups_total 2');
  assert.equal(line(out, 'tan_queue_active{queue="gpu-a"}'), 'tan_queue_active{queue="gpu-a"} 1');
  assert.equal(line(out, 'tan_queue_depth{queue="gpu-a"}'), 'tan_queue_depth{queue="gpu-a"} 1');
  assert.equal(line(out, 'tan_identity_leases{identity="test/alpha#1@h"}'), 'tan_identity_leases{identity="test/alpha#1@h"} 1');
  assert.equal(line(out, 'tan_identity_waiters{identity="test/beta#2@h"}'), 'tan_identity_waiters{identity="test/beta#2@h"} 1');
  assert.equal(line(out, 'tan_queue_longest_wait_seconds{queue="gpu-a"}'), 'tan_queue_longest_wait_seconds{queue="gpu-a"} 3');
  assert.equal(line(out, 'tan_queue_longest_lease_age_seconds{queue="gpu-a"}'), 'tan_queue_longest_lease_age_seconds{queue="gpu-a"} 6');
});

test('counts grants, releases and wait durations', () => {
  const { queues, advance, render } = make();
  queues.registerIdentity('i1', { harness: 'test', instance: 'alpha', pid: 1, host: 'h', user: 'u' });
  queues.registerIdentity('i2', { harness: 'test', instance: 'beta', pid: 2, host: 'h', user: 'u' });
  const a = queues.acquire({ identityId: 'i1', model: 'm1' });
  advance(2500);
  queues.acquire({ identityId: 'i2', model: 'm1' }); // queued behind a
  advance(1000);
  assert.equal(queues.release(a.lease.id), true); // drains the waiter
  advance(4000);
  const active = queues.snapshot().queues.find((q) => q.id === 'gpu-a').active;
  assert.equal(active.length, 1);
  assert.equal(queues.release(active[0].leaseId), true);
  const out = render();
  assert.equal(line(out, 'tan_grants_total{queue="gpu-a",identity="alpha"}'), 'tan_grants_total{queue="gpu-a",identity="alpha"} 1');
  assert.equal(line(out, 'tan_grants_total{queue="gpu-a",identity="beta"}'), 'tan_grants_total{queue="gpu-a",identity="beta"} 1');
  assert.equal(line(out, 'tan_releases_total{queue="gpu-a",reason="released"}'), 'tan_releases_total{queue="gpu-a",reason="released"} 2');
  // alpha waited 0s, beta 1s (queued at +2.5s, granted at +3.5s)
  assert.equal(line(out, 'tan_wait_seconds_bucket{queue="gpu-a",le="0.5"}'), 'tan_wait_seconds_bucket{queue="gpu-a",le="0.5"} 1');
  assert.equal(line(out, 'tan_wait_seconds_bucket{queue="gpu-a",le="1"}'), 'tan_wait_seconds_bucket{queue="gpu-a",le="1"} 2');
  assert.equal(line(out, 'tan_wait_seconds_bucket{queue="gpu-a",le="+Inf"}'), 'tan_wait_seconds_bucket{queue="gpu-a",le="+Inf"} 2');
  assert.equal(line(out, 'tan_wait_seconds_sum{queue="gpu-a"}'), 'tan_wait_seconds_sum{queue="gpu-a"} 1');
  assert.equal(line(out, 'tan_wait_seconds_count{queue="gpu-a"}'), 'tan_wait_seconds_count{queue="gpu-a"} 2');
  // alpha ran 3.5s, beta 4s
  assert.equal(line(out, 'tan_run_seconds_bucket{queue="gpu-a",le="5"}'), 'tan_run_seconds_bucket{queue="gpu-a",le="5"} 2');
  assert.equal(line(out, 'tan_run_seconds_sum{queue="gpu-a"}'), 'tan_run_seconds_sum{queue="gpu-a"} 7.5');
});

test('labels unmapped grants and releases as queue="unmapped"', () => {
  const { queues, render } = make();
  queues.registerIdentity('i1', { harness: 'test', instance: 'alpha', pid: 1, host: 'h', user: 'u' });
  const r = queues.acquire({ identityId: 'i1', model: 'deepseek-flash' });
  assert.equal(r.status, 'unlimited');
  queues.release(r.lease.id);
  const out = render();
  assert.equal(line(out, 'tan_grants_total{queue="unmapped",identity="alpha"}'), 'tan_grants_total{queue="unmapped",identity="alpha"} 1');
  assert.equal(line(out, 'tan_releases_total{queue="unmapped",reason="released"}'), 'tan_releases_total{queue="unmapped",reason="released"} 1');
});

test('counts cancellations and rejections with reasons', () => {
  const { queues, render } = make();
  queues.registerIdentity('i1', { harness: 'test', instance: 'alpha', pid: 1, host: 'h', user: 'u' });
  queues.registerIdentity('i2', { harness: 'test', instance: 'beta', pid: 2, host: 'h', user: 'u' });
  queues.acquire({ identityId: 'i1', model: 'm1' });
  const b = queues.acquire({ identityId: 'i2', model: 'm1' });
  assert.equal(queues.cancel(b.waiter.id, 'user_interrupt'), true);
  // gpu-b has limit 2 with no callers: exhaust it, then one more rejects as queue_full
  queues.configure([{ id: 'gpu-b', limit: 1, models: ['m2'] }]);
  queues.acquire({ identityId: 'i1', model: 'm2' }); // takes the only slot
  queues.acquire({ identityId: 'i2', model: 'm2' }); // queued
  queues.queueLimit = 1; // one waiter is already at the bound
  assert.throws(() => queues.acquire({ identityId: 'i1', model: 'm2' }));
  const out = render();
  assert.equal(line(out, 'tan_cancellations_total{queue="gpu-a",reason="user_interrupt"}'), 'tan_cancellations_total{queue="gpu-a",reason="user_interrupt"} 1');
  assert.equal(line(out, 'tan_rejections_total{queue="gpu-b",reason="queue_full"}'), 'tan_rejections_total{queue="gpu-b",reason="queue_full"} 1');
});

test('identity_down cancels waiters and releases leases (all counted)', () => {
  const { queues, render } = make();
  queues.registerIdentity('i1', { harness: 'test', instance: 'alpha', pid: 1, host: 'h', user: 'u' });
  queues.registerIdentity('i2', { harness: 'test', instance: 'beta', pid: 2, host: 'h', user: 'u' });
  queues.acquire({ identityId: 'i1', model: 'm1' });
  const b = queues.acquire({ identityId: 'i2', model: 'm1' });
  queues.identityDown('i2');
  const out = render();
  assert.equal(line(out, 'tan_cancellations_total{queue="gpu-a",reason="identity_down"}'), 'tan_cancellations_total{queue="gpu-a",reason="identity_down"} 1');
  void b;
});

test('escapes label values', () => {
  const { queues, render } = make();
  queues.registerIdentity('i1', { harness: 'test', instance: 'we"ird\\name', pid: 1, host: 'h', user: 'u' });
  queues.acquire({ identityId: 'i1', model: 'm1' });
  const out = render();
  assert.equal(line(out, 'tan_grants_total{queue="gpu-a",identity="we\\"ird\\\\name"}'), 'tan_grants_total{queue="gpu-a",identity="we\\"ird\\\\name"} 1');
});
