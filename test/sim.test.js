/* test/sim.test.js — the dashboard's offline simulator.
 *
 * The contract this suite guards is the one the dashboard actually consumes: a
 * simulated frame must be indistinguishable from a daemon frame at the field
 * level, its timers must only ever move forward, and the whole thing must be a
 * pure, deterministic, dependency-free module (no DOM, no network, no timers).
 * The "real" side of the comparison is built with the daemon's own Queues state
 * machine, so if the snapshot contract ever changes, this suite notices.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Queues } from '../daemon/lib/queues.js';
import { createSimulator, tickValue, createRng, DEFAULT_QUEUES } from '../dashboard/sim.js';

const T0 = 1_700_000_000_000; // a fixed wall clock: every frame below is reproducible

const keysOf = (value) => Object.keys(value).sort();

/** Build a frame exactly the way daemon/main.js builds a stream frame. */
function daemonFrame(now) {
  const queues = new Queues({
    queues: [
      { id: 'r9700-egpu', limit: 1, models: ['medium-dense', 'medium-moe'] },
      { id: 'strix-apu', limit: 3, models: ['small-dense', 'big-moe'] },
    ],
    now: () => now,
  });
  const client = { host: 'local-ai-machine', version: '0.7.0' };
  queues.registerIdentity('id-a', { ...client, harness: 'dsh', instance: 'web', pid: 41, user: 'dsh' });
  queues.registerIdentity('id-b', { ...client, harness: 'opencode', instance: 'tui', pid: 42, user: 'chris' });
  queues.registerIdentity('id-c', { ...client, harness: 'tan-cli', instance: 'shell', pid: 43, user: 'chris' });
  queues.acquire({ identityId: 'id-a', model: 'medium-dense', kind: 'chat', description: 'summarising', session: 'aa11', sessionTitle: 'kanban build', turn: 2, modality: 'text' });
  queues.acquire({ identityId: 'id-b', model: 'medium-moe', kind: 'embed', sessionTitle: 'embed backfill' }); // queued
  queues.acquire({ identityId: 'id-c', model: 'small-dense' });
  queues.acquire({ identityId: 'id-a', model: 'big-moe' });
  return { type: 'status', asOf: now, uptimeMs: 60_000, version: '0.4.0', ...queues.snapshot(now) };
}

function simFrame(seed = 7, ...ticks) {
  const sim = createSimulator({ seed, now: T0 });
  let frame = null;
  for (const t of ticks) frame = sim.tick(t);
  return frame;
}

// --- tickValue: the local-clock ticking primitive ---------------------------------

test('tickValue advances a frame-carried duration by the local clock', () => {
  assert.equal(tickValue(1000, 5000, 6000), 2000);
  assert.equal(tickValue(1000, 5000, 5000), 1000);
  assert.equal(tickValue(0, T0, T0 + 45_000), 45_000);
});

test('tickValue clamps when the clock goes backwards or is unusable', () => {
  assert.equal(tickValue(1000, 5000, 4000), 1000, 'a rewound clock must never shrink a timer');
  assert.equal(tickValue(1000, 5000, 4999), 1000);
  assert.equal(tickValue(1000, Number.NaN, 6000), 1000);
  assert.equal(tickValue(1000, 5000, Number.NaN), 1000);
  assert.equal(tickValue(undefined, 5000, 6000), 1000, 'a missing base counts as zero');
});

// --- frame shape: the daemon contract, field for field ----------------------------

test('a simulated frame carries the same top-level fields as a daemon frame', () => {
  assert.deepEqual(keysOf(simFrame(7, T0 + 1000)), keysOf(daemonFrame(T0)));
});

test('a simulated frame carries the same queue, entry and identity fields as a daemon frame', () => {
  const sim = simFrame(11, T0 + 1000);
  const real = daemonFrame(T0);
  const realQueue = real.queues.find((q) => q.id === 'r9700-egpu');
  const simQueue = sim.queues.find((q) => q.id === 'r9700-egpu');
  assert.ok(simQueue, 'the default topology mirrors the box queues');
  assert.deepEqual(keysOf(simQueue), keysOf(realQueue));

  const withWaiters = (frame) => frame.queues.find((q) => q.waiters.length > 0);
  const withActive = (frame) => frame.queues.find((q) => q.active.length > 0);
  assert.ok(withWaiters(sim) && withWaiters(real) && withActive(sim) && withActive(real), 'both frames exercise both entry kinds');
  assert.deepEqual(keysOf(withWaiters(sim).waiters[0]), keysOf(withWaiters(real).waiters[0]));
  assert.deepEqual(keysOf(withActive(sim).active[0]), keysOf(withActive(real).active[0]));
  assert.deepEqual(keysOf(sim.identities[0]), keysOf(real.identities[0]));
});

test('a simulated frame is internally consistent the way a snapshot is', () => {
  const frame = simFrame(3, T0 + 1000);
  assert.equal(frame.type, 'status');
  assert.equal(frame.asOf, T0 + 1000);
  assert.ok(frame.uptimeMs > 0);
  assert.equal(typeof frame.version, 'string');
  const active = frame.queues.reduce((sum, q) => sum + q.active.length, 0);
  const waiting = frame.queues.reduce((sum, q) => sum + q.waiters.length, 0);
  assert.deepEqual(frame.totals, { active, waiting });
  frame.queues.forEach((queue) => {
    assert.equal(queue.used, queue.active.length);
    assert.equal(queue.history60.length, 60, 'the graph wants a full minute of buckets');
    assert.ok(queue.history60.every((bit) => bit === 0 || bit === 1));
    assert.equal(queue.unlimited, queue.limit === null);
    queue.active.forEach((lease) => {
      assert.equal(lease.elapsedMs, Math.max(0, frame.asOf - lease.startedAt));
      assert.ok(lease.identity.includes('/') && lease.identity.includes('@'));
    });
    queue.waiters.forEach((waiter, index) => {
      assert.equal(waiter.position, index + 1, 'positions are 1-based and in line order');
      assert.equal(waiter.waitedMs, Math.max(0, frame.asOf - waiter.enqueuedAt));
    });
  });
  const identities = new Set(frame.identities.map((i) => i.identityId));
  frame.queues.forEach((queue) => [...queue.active, ...queue.waiters].forEach((entry) => {
    assert.ok(identities.has(entry.identityId), 'every entry belongs to a listed identity');
  }));
});

test('the default topology mirrors the box config (strix-apu 3, r9700-egpu 1)', () => {
  const byId = Object.fromEntries(DEFAULT_QUEUES.map((q) => [q.id, q.limit]));
  assert.equal(byId['strix-apu'], 3);
  assert.equal(byId['r9700-egpu'], 1);
});

test('the default simulated uptime stays under an hour so the KPI renders seconds', () => {
  // fmtMs() shows "5h 12m" past the hour, which only moves once a minute; the
  // whole point of the simulated feed is timers you can watch tick.
  const frame = createSimulator({ now: T0 }).tick(T0 + 1000);
  assert.ok(frame.uptimeMs > 0 && frame.uptimeMs < 3_600_000, `uptimeMs was ${frame.uptimeMs}`);
});

// --- determinism ------------------------------------------------------------------

test('the same seed and the same tick sequence produce identical frames', () => {
  const times = [T0 + 1000, T0 + 2000, T0 + 5000, T0 + 9000, T0 + 20000];
  const run = () => {
    const sim = createSimulator({ seed: 42, now: T0 });
    return times.map((t) => sim.tick(t));
  };
  assert.deepEqual(run(), run(), 'frames are a pure function of seed + tick times');
});

test('a different seed produces a different world', () => {
  assert.notDeepEqual(simFrame(1, T0 + 1000), simFrame(2, T0 + 1000));
});

test('createRng is a deterministic generator over [0, 1)', () => {
  const draw = (seed, count) => {
    const rng = createRng(seed);
    return Array.from({ length: count }, () => rng());
  };
  const values = draw(99, 500);
  values.forEach((v) => assert.ok(v >= 0 && v < 1, `${v} outside [0, 1)`));
  assert.deepEqual(values, draw(99, 500), 'the same seed replays the same stream');
  assert.notDeepEqual(values.slice(0, 16), draw(100, 16), 'a different seed diverges');
  assert.ok(new Set(values).size > 450, 'the stream is not degenerate');
});

// --- realtime behaviour: timers only move forward ---------------------------------

test('elapsedMs, waitedMs and uptimeMs advance monotonically across ticks', () => {
  const sim = createSimulator({ seed: 5, now: T0 });
  let previous = sim.tick(T0 + 1000);
  let comparedLeases = 0;
  let comparedWaiters = 0;
  for (let t = T0 + 2000; t <= T0 + 120_000; t += 1000) {
    const frame = sim.tick(t);
    assert.ok(frame.uptimeMs > previous.uptimeMs, 'the daemon-up KPI keeps growing');
    assert.ok(frame.asOf > previous.asOf);
    previous.queues.forEach((queue, index) => {
      const next = frame.queues[index];
      const prevLeases = new Map(queue.active.map((l) => [l.leaseId, l.elapsedMs]));
      next.active.forEach((lease) => {
        if (prevLeases.has(lease.leaseId)) {
          assert.ok(lease.elapsedMs > prevLeases.get(lease.leaseId), 'a live call ages');
          comparedLeases += 1;
        }
      });
      const prevWaiters = new Map(queue.waiters.map((w) => [w.waiterId, w.waitedMs]));
      next.waiters.forEach((waiter) => {
        if (prevWaiters.has(waiter.waiterId)) {
          assert.ok(waiter.waitedMs > prevWaiters.get(waiter.waiterId), 'a queued call keeps waiting');
          comparedWaiters += 1;
        }
      });
    });
    previous = frame;
  }
  assert.ok(comparedLeases > 20 && comparedWaiters > 5, 'the world is populated enough for this to mean something');
});

test('the world is alive: calls arrive, promote out of the queue, and leave', () => {
  const sim = createSimulator({ seed: 13, now: T0 });
  let frame = sim.tick(T0 + 1000);
  const seenLeases = new Set(frame.queues.flatMap((q) => q.active.map((l) => l.leaseId)));
  let departed = 0;
  let arrived = 0;
  let promotions = 0;
  for (let t = T0 + 2000; t <= T0 + 600_000; t += 1000) {
    const next = sim.tick(t);
    const prevLeaseIds = new Set(frame.queues.flatMap((q) => q.active.map((l) => l.leaseId)));
    const prevWaiterKeys = new Set(frame.queues.flatMap((q) => q.waiters.map((w) => `${w.identityId}::${w.model}`)));
    const nowLeaseIds = new Set(next.queues.flatMap((q) => q.active.map((l) => l.leaseId)));
    prevLeaseIds.forEach((id) => { if (!nowLeaseIds.has(id)) departed += 1; });
    nowLeaseIds.forEach((id) => {
      if (prevLeaseIds.has(id)) return;
      arrived += 1;
      const lease = next.queues.flatMap((q) => q.active).find((l) => l.leaseId === id);
      // the dashboard's own promotion heuristic: a new lease whose identity+model
      // matches a waiter that just left the line came up from the queue
      if (prevWaiterKeys.has(`${lease.identityId}::${lease.model}`)) promotions += 1;
    });
    frame = next;
  }
  assert.ok(arrived > 10, `calls arrive over ten minutes (saw ${arrived})`);
  assert.ok(departed > 10, `calls finish and leave (saw ${departed})`);
  assert.ok(promotions > 0, `waiters get promoted into freed slots (saw ${promotions})`);
});

test('queues never exceed their limit and stay strictly FIFO', () => {
  const sim = createSimulator({ seed: 21, now: T0 });
  for (let t = T0 + 1000; t <= T0 + 300_000; t += 500) {
    const frame = sim.tick(t);
    frame.queues.forEach((queue) => {
      if (!queue.unlimited) assert.ok(queue.active.length <= queue.limit, `${queue.id} over capacity`);
      // a full queue with a line means nobody was skipped: the line is ordered by arrival
      const enqueued = queue.waiters.map((w) => w.enqueuedAt);
      assert.deepEqual(enqueued, [...enqueued].sort((a, b) => a - b), `${queue.id} is not FIFO`);
      queue.waiters.forEach((w, i) => assert.equal(w.position, i + 1));
    });
  }
});

test('a backwards system clock does not rewind the simulated world', () => {
  const sim = createSimulator({ seed: 31, now: T0 });
  const forward = sim.tick(T0 + 60_000);
  const jumped = sim.tick(T0 + 30_000);
  assert.equal(jumped.asOf, forward.asOf, 'the frame is stamped at the newest time seen');
  assert.ok(jumped.uptimeMs >= forward.uptimeMs);
});

test('a custom queue topology is honoured', () => {
  const sim = createSimulator({ seed: 2, now: T0, queues: [{ id: 'solo', limit: 1, models: ['m'] }, { id: 'free', limit: null, models: ['n'] }] });
  const frame = sim.tick(T0 + 1000);
  assert.deepEqual(frame.queues.map((q) => q.id), ['free', 'solo'], 'queues sort by id like the daemon does');
  const free = frame.queues.find((q) => q.id === 'free');
  assert.equal(free.unlimited, true);
  assert.equal(free.limit, null);
  const solo = frame.queues.find((q) => q.id === 'solo');
  assert.equal(solo.limit, 1);
});

// --- purity: what makes this loadable in a browser with no build step -------------

test('sim.js is a zero-dependency pure module (no imports, no DOM, no network, no timers)', () => {
  const src = readFileSync(new URL('../dashboard/sim.js', import.meta.url), 'utf8');
  const forbidden = [
    [/^\s*import\s/m, 'import statement'],
    [/^\s*export\s+\*\s+from/m, 're-export'],
    [/\brequire\s*\(/, 'require()'],
    [/\bdocument\b/, 'document'],
    [/\bfetch\s*\(/, 'fetch'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bsetInterval\s*\(/, 'setInterval'],
    [/\bsetTimeout\s*\(/, 'setTimeout'],
    [/\bWebSocket\b/, 'WebSocket'],
    [/\bprocess\b/, 'process'],
  ];
  forbidden.forEach(([pattern, label]) => {
    const line = src.split('\n').findIndex((text) => pattern.test(text));
    assert.equal(line, -1, `sim.js must not touch ${label} (found on line ${line + 1})`);
  });
});
