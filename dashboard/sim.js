/* dashboard/sim.js — a zero-dependency simulated feed for the take-a-number dashboard.
 *
 * The dashboard's timers do not need a realtime network connection: between two
 * frames the page advances every duration it displays with its own clock
 * (`tickValue`), and when there is no daemon at all this module manufactures the
 * frames. It is a pure module — no DOM, no timers, no fetch, no imports — so it
 * runs identically in the browser and under `node --test`, and it is deterministic:
 * a given seed plus a given sequence of tick timestamps always produces the same
 * frames.
 *
 * `createSimulator().tick(t)` returns a frame that matches the daemon's wire
 * contract field for field — the stream frame from `/api/events`
 * (`{ type:'status', asOf, uptimeMs, version, ...queues.snapshot() }`) and
 * therefore the `/api/status` poll body as well — so `dashboard/app.js` renders
 * simulated frames through exactly the same code path as real ones.
 * test/sim.test.js asserts that conformance against a snapshot built by the real
 * `Queues` state machine, which is what keeps this honest as the contract evolves.
 *
 * In the browser it is loaded as a module script (dashboard/index.html) and
 * publishes itself on `window.TAN_SIM` for the classic-script app.js.
 */

/**
 * Default queue topology: mirrors the box's /etc/take-a-number/config.json so a
 * simulated dashboard looks like the real one.
 */
export const DEFAULT_QUEUES = [
  { id: 'r9700-egpu', limit: 1, models: ['medium-dense', 'medium-moe'] },
  { id: 'strix-apu', limit: 3, models: ['small-dense', 'big-moe', 'small-moe', 'image-gen'] },
];

/**
 * Advance a duration that was measured from a frame. `baseMs` is the value the
 * frame carried (elapsed time as of `baseAt`); the local clock says it is now
 * `now`. Clamps at the base so a clock that steps backwards never makes a timer
 * shrink.
 */
export function tickValue(baseMs, baseAt, now) {
  const base = Number.isFinite(baseMs) ? baseMs : 0;
  if (!Number.isFinite(baseAt) || !Number.isFinite(now)) return base;
  const delta = now - baseAt;
  return base + (delta > 0 ? delta : 0);
}

/** Deterministic 32-bit PRNG (mulberry32): returns floats in [0, 1). */
export function createRng(seed) {
  let a = Number.isFinite(seed) ? seed >>> 0 : 0;
  if (a === 0) a = 0x9e3779b9;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOST = 'local-ai-machine';
const HARNESS_POOL = [
  { harness: 'dsh', instance: 'web', user: 'dsh' },
  { harness: 'dsh', instance: 'kanban', user: 'dsh' },
  { harness: 'dsh', instance: 'goal', user: 'dsh' },
  { harness: 'dsh', instance: 'subagent', user: 'dsh' },
  { harness: 'opencode', instance: 'tui', user: 'chris' },
  { harness: 'opencode', instance: 'review', user: 'chris' },
  { harness: 'tan-cli', instance: 'shell', user: 'chris' },
  { harness: 'litellm', instance: 'proxy', user: 'tan' },
];
const KINDS = ['chat', 'chat', 'chat', 'chat', 'reason', 'embed', 'image'];
const CLIENT_VERSIONS = ['0.7.0', '0.7.0', '0.7.0', '0.6.1'];
const MODALITIES = ['text', 'text', 'text', 'text', 'image+text'];
const SESSION_TITLES = [
  'kanban build', 'dashboard polish', 'nightly eval', 'nixos rebase', 'log triage',
  'proxy load test', 'tokenizer bench', 'docs pass', 'flake cleanup', 'review: leases',
  'embed backfill', 'vision smoke', 'queue metrics', 'backup verify', 'prompt sweep',
];
const DESCRIPTIONS = [
  'summarising the last 200 audit lines',
  'rerunning the failing protocol test',
  'embedding 4k docs for the index',
  'drafting the release notes',
  'classifying inbound support mail',
  'generating the hero image',
  'comparing two tokenizer configs',
  'reading the grafana snapshot',
  'replaying yesterday traffic',
  'checking the fifo invariant',
];

function hex(rng, count) {
  let out = '';
  for (let i = 0; i < count; i += 1) out += Math.floor(rng() * 16).toString(16);
  return out;
}

/** uuid-shaped identifier, so the dashboard's shortId() renders it like a real one. */
function uuid(rng) {
  return `${hex(rng, 8)}-${hex(rng, 4)}-${hex(rng, 4)}-${hex(rng, 4)}-${hex(rng, 12)}`;
}

function identityString(info) {
  return `${info.harness}/${info.instance}#${info.pid}@${info.host}`;
}

/**
 * Create a simulator.
 *
 * @param {object} [options]
 * @param {Array<{id:string, limit:number|null, unlimited?:boolean, models?:string[]}>} [options.queues]
 * @param {number} [options.seed] fixed seed => reproducible frames
 * @param {number} [options.now] the wall clock the world starts at (ms)
 * @param {number} [options.uptimeMs] how long the simulated daemon has been up at `now`
 * @param {string} [options.version] version string echoed in frames
 * @param {number} [options.identities] size of the connected-client pool
 * @returns {{ tick: (t?: number) => object }}
 */
export function createSimulator(options = {}) {
  const rng = createRng(Number.isFinite(options.seed) ? options.seed : 0x5eed);
  const start = Number.isFinite(options.now) ? options.now : Date.now();
  // Deliberately under an hour: fmtMs() renders hour-scale uptimes as "5h 12m",
  // which only changes once a minute, and the point of the simulated feed is to
  // show the timers moving. A daemon that restarted this morning is plausible.
  const uptimeMs = Number.isFinite(options.uptimeMs) ? options.uptimeMs : 47 * 60 * 1000;
  const version = typeof options.version === 'string' ? options.version : '0.7.0-sim';
  const specs = Array.isArray(options.queues) && options.queues.length > 0
    ? options.queues
    : DEFAULT_QUEUES;
  const identityCount = Number.isFinite(options.identities) && options.identities > 0
    ? Math.floor(options.identities)
    : HARNESS_POOL.length;

  const rand = (min, max) => min + rng() * (max - min);
  const int = (min, max) => Math.floor(rand(min, max + 1));
  const pick = (list) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

  const startedAt = start - uptimeMs;

  const identities = [];
  for (let i = 0; i < identityCount; i += 1) {
    const pool = HARNESS_POOL[i % HARNESS_POOL.length];
    identities.push({
      identityId: uuid(rng),
      harness: pool.harness,
      instance: pool.instance,
      pid: int(1000, 98000),
      host: HOST,
      user: pool.user,
      version: pick(CLIENT_VERSIONS),
      capability: 'static',
      connectedAt: start - int(30, 5400) * 1000,
    });
  }

  const CALL_MS = [45, 240]; // simulated model-call duration range, seconds
  const GAP_MS = [4, 26]; // simulated inter-arrival range, seconds
  const PATIENCE_MS = [90, 600]; // how long a waiter waits before giving up

  function fields() {
    const who = pick(identities);
    return {
      identityId: who.identityId,
      identity: identityString(who),
      kind: pick(KINDS),
      description: pick(DESCRIPTIONS),
      session: hex(rng, 8),
      sessionTitle: pick(SESSION_TITLES),
      turn: int(1, 40),
      modality: pick(MODALITIES),
      meta: null,
    };
  }

  function makeLease(queue, at) {
    return {
      ...fields(),
      leaseId: uuid(rng),
      model: pick(queue.models),
      startedAt: at,
      waitedMs: 0,
      finishAt: at + int(CALL_MS[0], CALL_MS[1]) * 1000,
    };
  }

  function makeWaiter(queue, at) {
    return {
      ...fields(),
      waiterId: uuid(rng),
      model: pick(queue.models),
      enqueuedAt: at,
      giveUpAt: at + int(PATIENCE_MS[0], PATIENCE_MS[1]) * 1000,
    };
  }

  const queues = specs.map((spec) => {
    const unlimited = spec.unlimited === true || spec.limit === null || spec.limit === undefined;
    return {
      id: spec.id,
      limit: unlimited ? Infinity : Math.max(1, Number(spec.limit) || 1),
      models: Array.isArray(spec.models) && spec.models.length > 0 ? spec.models : [spec.id],
      active: [],
      waiters: [],
      nextArrivalAt: start + int(1, 9) * 1000,
      history: new Array(60).fill(0),
      historyAt: start,
    };
  });

  // Pre-populate so the very first frame already looks like a busy box: every
  // queue holds at least one call that started a while ago, and a limited queue
  // gets a short line so the graph and the queue section have something to show.
  queues.forEach((queue) => {
    const seats = queue.limit === Infinity ? 2 : queue.limit;
    for (let i = 0; i < seats; i += 1) {
      queue.active.push(makeLease(queue, start - int(5, 70) * 1000));
    }
    const line = queue.limit === Infinity ? 0 : int(1, 2);
    const ages = [];
    let ago = 0;
    for (let i = 0; i < line; i += 1) {
      ago += int(15, 60) * 1000;
      ages.push(ago);
    }
    // oldest in line first — the queue is FIFO from the very first frame
    ages.reverse().forEach((seconds) => queue.waiters.push(makeWaiter(queue, start - seconds)));
  });

  function advance(queue, now) {
    // busy history: one 0/1 slot per elapsed second, oldest first (daemon semantics)
    let steps = 0;
    while (queue.historyAt + 1000 <= now && steps < 60) {
      queue.historyAt += 1000;
      queue.history.shift();
      queue.history.push(queue.active.length > 0 ? 1 : 0);
      steps += 1;
    }
    if (queue.historyAt + 1000 <= now) queue.historyAt = now;

    // calls that finished leave, waiters that got tired of waiting give up
    queue.active = queue.active.filter((lease) => lease.finishAt > now);
    queue.waiters = queue.waiters.filter((waiter) => waiter.giveUpAt > now);

    // strict FIFO promotion: a freed slot goes to the head of the line, and the
    // promoted lease keeps the waiter's identity + model so the dashboard can
    // still recognise the promotion (no poof, card moves upstairs)
    while (queue.active.length < queue.limit && queue.waiters.length > 0) {
      const waiter = queue.waiters.shift();
      queue.active.push({
        ...waiter,
        leaseId: uuid(rng),
        startedAt: now,
        waitedMs: Math.max(0, now - waiter.enqueuedAt),
        finishAt: now + int(CALL_MS[0], CALL_MS[1]) * 1000,
      });
    }

    // new demand arrives on its own schedule
    let arrivals = 0;
    while (now >= queue.nextArrivalAt && arrivals < 25) {
      const at = queue.nextArrivalAt;
      if (queue.active.length < queue.limit) queue.active.push(makeLease(queue, at));
      else queue.waiters.push(makeWaiter(queue, at));
      queue.nextArrivalAt = at + int(GAP_MS[0], GAP_MS[1]) * 1000;
      arrivals += 1;
    }
    if (arrivals >= 25) queue.nextArrivalAt = now + int(GAP_MS[0], GAP_MS[1]) * 1000;
  }

  function frame(now) {
    let totalActive = 0;
    let totalWaiting = 0;
    const providers = queues.map((queue) => {
      const active = queue.active.map((lease) => ({
        leaseId: lease.leaseId,
        identityId: lease.identityId,
        identity: lease.identity,
        model: lease.model,
        kind: lease.kind,
        description: lease.description,
        session: lease.session,
        sessionTitle: lease.sessionTitle,
        turn: lease.turn,
        modality: lease.modality,
        meta: lease.meta,
        startedAt: lease.startedAt,
        elapsedMs: Math.max(0, now - lease.startedAt),
        waitedMs: Math.max(0, lease.waitedMs),
      }));
      const waiters = queue.waiters.map((waiter, index) => ({
        waiterId: waiter.waiterId,
        identityId: waiter.identityId,
        identity: waiter.identity,
        model: waiter.model,
        kind: waiter.kind,
        description: waiter.description,
        session: waiter.session,
        sessionTitle: waiter.sessionTitle,
        position: index + 1,
        enqueuedAt: waiter.enqueuedAt,
        waitedMs: Math.max(0, now - waiter.enqueuedAt),
      }));
      totalActive += active.length;
      totalWaiting += waiters.length;
      return {
        id: queue.id,
        limit: queue.limit === Infinity ? null : queue.limit,
        unlimited: queue.limit === Infinity,
        used: active.length,
        active,
        waiters,
        history60: queue.history.slice(),
      };
    });
    providers.sort((a, b) => a.id.localeCompare(b.id));

    const identityRows = identities.map((info) => {
      let leases = 0;
      let waiting = 0;
      providers.forEach((provider) => {
        provider.active.forEach((lease) => { if (lease.identityId === info.identityId) leases += 1; });
        provider.waiters.forEach((waiter) => { if (waiter.identityId === info.identityId) waiting += 1; });
      });
      return {
        identityId: info.identityId,
        identity: identityString(info),
        harness: info.harness,
        instance: info.instance,
        pid: info.pid,
        host: info.host,
        user: info.user,
        version: info.version,
        capability: info.capability,
        connectedAt: info.connectedAt,
        leases,
        waiters: waiting,
      };
    });
    identityRows.sort((a, b) => a.identity.localeCompare(b.identity));

    return {
      type: 'status',
      asOf: now,
      uptimeMs: Math.max(0, now - startedAt),
      version,
      totals: { active: totalActive, waiting: totalWaiting },
      queues: providers,
      identities: identityRows,
    };
  }

  let lastNow = start;

  /** Emit the world's frame at wall-clock `t` (defaults to Date.now()). */
  function tick(t) {
    const now = Number.isFinite(t) ? t : Date.now();
    // A backwards clock jump must not rewind the world; frames stay monotonic.
    const at = now > lastNow ? now : lastNow;
    lastNow = at;
    queues.forEach((queue) => advance(queue, at));
    return frame(at);
  }

  return { tick, version };
}

// Browser surface: dashboard/index.html loads this as a module script, and the
// classic-script app.js reaches it through window.TAN_SIM.
if (typeof window !== 'undefined') {
  window.TAN_SIM = { createSimulator, tickValue, createRng, DEFAULT_QUEUES };
}
