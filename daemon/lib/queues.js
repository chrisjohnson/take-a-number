// take-a-number daemon: pure queue/lease/identity state machine. No I/O.
//
// One bucket per queue (a queue is one GPU). A bucket holds active leases and FIFO
// waiters. `used = active.size`; a call is admitted only while `used < limit`. Every
// caller — any harness, any process, any machine — waits in the same queue for its GPU,
// in arrival order.
//
// There are NO timers here. The only bound on waiting work is queueLimit. Lease
// lifetime is tied to the client connection (the protocol layer calls identityDown
// when a connection closes), so a crashed process frees its leases immediately.

import { randomUUID } from 'node:crypto';

const nowMs = () => Date.now();

const DESC_MAX = 160;

function clampDescription(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > DESC_MAX ? `${trimmed.slice(0, DESC_MAX - 1)}…` : trimmed;
}

export class TanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TanError';
    this.code = code;
    this.details = details;
  }
}

export class Queues {
  /**
   * @param {object} options
   * @param {Array<{id:string, limit:number, models?:string[]}>} options.queues
   * @param {string} [options.unmapped] 'unlimited' (default) or 'reject'
   * @param {number} [options.queueLimit] bound on waiters per queue
   * @param {(type:string, payload:object)=>void} [options.onEvent]
   * @param {()=>number} [options.now]
   */
  constructor({ queues, unmapped = 'unlimited', queueLimit = 1000, onEvent = () => {}, now = nowMs } = {}) {
    this.unmapped = unmapped;
    this.queueLimit = queueLimit;
    this.onEvent = onEvent;
    this.now = now;
    this.buckets = new Map();
    this.leases = new Map();
    this.waiters = new Map();
    this.grants = new Map(); // waiterId -> {leaseId, queue, waitedMs, identityId}; survives promotion
    this.identities = new Map(); // identityId -> {harness, instance, pid, host, user, connectedAt}
    this.modelQueue = new Map();
    this.configure(queues ?? []);
  }

  configure(queues) {
    const next = new Map();
    const modelQueue = new Map();
    for (const entry of queues) {
      if (typeof entry.id !== 'string' || entry.id === '') throw new TanError('BAD_CONFIG', 'queue entry needs an id');
      const limit = entry.limit === Infinity ? Infinity : Number(entry.limit);
      if (!Number.isFinite(limit) || limit < 1) throw new TanError('BAD_CONFIG', `queue "${entry.id}" limit must be a number >= 1`);
      const bucket = this.buckets.get(entry.id) ?? {
        id: entry.id,
        limit,
        active: new Map(),
        waiters: [],
        // busy-rate history: seconds of busy-ness per 1 s bucket, last 60
        history: new Array(60).fill(0),
        historyIndex: 0,
        lastHistoryAt: null,
      };
      bucket.limit = limit;
      next.set(entry.id, bucket);
      for (const model of entry.models ?? []) modelQueue.set(model, entry.id);
    }
    for (const [id, bucket] of this.buckets) {
      if (!next.has(id)) {
        // Queue removed from config: release nothing (leases run to completion),
        // cancel its waiters (they would wait forever for a queue that no longer exists).
        for (const waiter of [...bucket.waiters]) this.cancel(waiter.id, 'queue_removed');
        bucket.active.clear();
        for (const leaseId of [...bucket.active.keys()]) this.leases.delete(leaseId);
      }
    }
    this.buckets = next;
    this.modelQueue = modelQueue;
    this.onEvent('config', { queues: [...this.buckets.values()].map((b) => ({ id: b.id, limit: b.limit === Infinity ? null : b.limit, unlimited: b.limit === Infinity })) });
  }

  registerIdentity(identityId, info) {
    this.identities.set(identityId, { ...info, connectedAt: this.now() });
    this.onEvent('identity_up', { identityId, ...info });
  }

  identityDown(identityId) {
    const info = this.identities.get(identityId);
    this.identities.delete(identityId);
    // Cancel this identity's waiters FIRST: releasing a lease drains the queue, and
    // a drain must never promote a waiter belonging to the identity we are tearing
    // down — that would mint a fresh lease out of a dead process.
    let cancelled = 0;
    for (const waiter of [...this.waiters.values()]) {
      if (waiter.identityId === identityId) {
        this.cancel(waiter.id, 'identity_down');
        cancelled += 1;
      }
    }
    let released = 0;
    for (const lease of [...this.leases.values()]) {
      if (lease.identityId === identityId) {
        this.release(lease.id, 'identity_down');
        released += 1;
      }
    }
    this.onEvent('identity_down', { identityId, ...(info ?? {}), released, cancelled });
    for (const [wid, grant] of this.grants) {
      if (grant.identityId === identityId) this.grants.delete(wid);
    }
    return { released, cancelled };
  }

  /** Which queue a model belongs to, or null when unmapped. */
  queueFor(model, provider) {
    if (typeof model === 'string' && this.modelQueue.has(model)) return this.modelQueue.get(model);
    if (typeof provider === 'string' && this.modelQueue.has(provider)) return this.modelQueue.get(provider);
    return null;
  }

  #bucket(id) {
    const bucket = this.buckets.get(id);
    if (bucket === undefined) throw new TanError('NO_SUCH_QUEUE', `unknown queue "${id}"`);
    return bucket;
  }

  isUnlimited(queueId) {
    const bucket = this.buckets.get(queueId);
    return bucket !== undefined && bucket.limit === Infinity;
  }

  used(queueId) {
    return this.#bucket(queueId).active.size;
  }

  limit(queueId) {
    return this.#bucket(queueId).limit;
  }

  #noteBusy(bucket) {
    const at = this.now();
    if (bucket.lastHistoryAt === null) {
      bucket.lastHistoryAt = at;
      return;
    }
    const elapsed = Math.floor((at - bucket.lastHistoryAt) / 1000);
    if (elapsed < 1) return;
    for (let i = 0; i < Math.min(elapsed, 60); i += 1) {
      bucket.historyIndex = (bucket.historyIndex + 1) % 60;
      bucket.history[bucket.historyIndex] = bucket.active.size > 0 ? 1 : 0;
    }
    bucket.lastHistoryAt = at - (at - bucket.lastHistoryAt) % 1000;
  }

  #lease(queueId, fields) {
    const id = randomUUID();
    const bucket = this.#bucket(queueId);
    this.#noteBusy(bucket);
    // Spread fields FIRST: on the drain path fields is the promoted waiter, and a
    // later spread would clobber `id` with the waiter's own id, desynchronizing the
    // lease from its map key (release-by-id would then silently no-op).
    const lease = {
      ...fields,
      id,
      queue: queueId,
      startedAt: this.now(),
      released: false,
      release: (reason) => this.release(id, reason),
    };
    delete lease.resolve;
    delete lease.reject;
    delete lease.enqueuedAt;
    bucket.active.set(id, lease);
    this.leases.set(id, lease);
    this.onEvent('granted', {
      leaseId: id,
      queue: queueId,
      identityId: lease.identityId,
      ...this.#idFields(lease.identityId),
      model: lease.model ?? null,
      kind: lease.kind ?? 'call',
      description: lease.description ?? null,
      session: lease.session ?? null,
      sessionTitle: lease.sessionTitle ?? null,
      turn: lease.turn ?? null,
      modality: lease.modality ?? null,
      meta: lease.meta ?? null,
      waitedMs: Math.max(0, Number(lease.waitedMs ?? 0)),
      active: bucket.active.size,
      limit: bucket.limit === Infinity ? null : bucket.limit,
    });
    return lease;
  }

  /**
   * Synchronous admission decision.
   * Returns {status:'granted', lease, queue} | {status:'queued', waiter, queue, position, active, limit}
   * | {status:'unlimited', lease, queue:null} (unmapped model with unmapped:'unlimited').
   * Throws TanError('QUEUE_FULL') / TanError('NO_SUCH_QUEUE') / TanError('UNMAPPED_REJECTED').
   */
  acquire(fields) {
    const { identityId, model = null, provider = null } = fields;
    if (typeof identityId !== 'string' || identityId === '') throw new TanError('BAD_REQUEST', 'acquire needs an identityId');
    const description = clampDescription(fields.description);
    const base = {
      identityId,
      model: typeof model === 'string' && model !== '' ? model : null,
      kind: typeof fields.kind === 'string' && fields.kind !== '' ? fields.kind : 'call',
      description,
      session: typeof fields.session === 'string' ? fields.session : null,
      sessionTitle: typeof fields.sessionTitle === 'string' ? fields.sessionTitle : null,
      turn: Number.isInteger(fields.turn) ? fields.turn : null,
      modality: typeof fields.modality === 'string' && fields.modality !== '' ? fields.modality : null,
      meta: fields.meta !== null && typeof fields.meta === 'object' && !Array.isArray(fields.meta) ? fields.meta : null,
    };
    const queueId = this.queueFor(base.model, provider);
    if (queueId === null) {
      if (this.unmapped === 'reject') {
        this.onEvent('rejected', { ...base, ...this.#idFields(identityId), reason: 'unmapped' });
        throw new TanError('UNMAPPED_REJECTED', `model "${base.model}" is not mapped to any queue`, { model: base.model });
      }
      // Unmapped model: a synthetic unlimited lease. Tracked (so release and
      // identityDown work, and the audit records it) but never counted against a queue.
      const lease = {
        ...base,
        id: randomUUID(),
        queue: null,
        unlimited: true,
        startedAt: this.now(),
        released: false,
      };
      lease.release = () => this.release(lease.id);
      this.leases.set(lease.id, lease);
      this.onEvent('granted', { ...this.#leaseFields(lease), queue: null, unlimited: true, active: 0, limit: null, waitedMs: 0 });
      return { status: 'unlimited', lease, queue: null };
    }
    const bucket = this.#bucket(queueId);
    if (bucket.limit === Infinity) {
      const lease = this.#lease(queueId, { ...base, unlimited: true });
      return { status: 'granted', lease, queue: queueId };
    }
    if (bucket.active.size < bucket.limit && bucket.waiters.length === 0) {
      const lease = this.#lease(queueId, base);
      return { status: 'granted', lease, queue: queueId };
    }
    if (bucket.waiters.length >= this.queueLimit) {
      this.onEvent('rejected', { ...base, ...this.#idFields(identityId), queue: queueId, reason: 'queue_full', waiting: bucket.waiters.length });
      throw new TanError('QUEUE_FULL', `queue "${queueId}" is full (${bucket.waiters.length} waiting)`, { queue: queueId, limit: bucket.limit, waiting: bucket.waiters.length });
    }
    const waiter = {
      id: randomUUID(),
      queue: queueId,
      enqueuedAt: this.now(),
      resolve: null,
      reject: null,
      ...base,
    };
    bucket.waiters.push(waiter);
    this.waiters.set(waiter.id, waiter);
    this.onEvent('queued', {
      waiterId: waiter.id,
      queue: queueId,
      identityId: waiter.identityId,
      ...this.#idFields(waiter.identityId),
      model: waiter.model,
      kind: waiter.kind,
      description: waiter.description,
      session: waiter.session,
      position: bucket.waiters.length,
      waiting: bucket.waiters.length,
      active: bucket.active.size,
      limit: bucket.limit,
    });
    return { status: 'queued', waiter, queue: queueId, position: bucket.waiters.length, active: bucket.active.size, limit: bucket.limit };
  }

  #leaseFields(lease) {
    return {
      leaseId: lease.id,
      identityId: lease.identityId,
      ...this.#idFields(lease.identityId),
      model: lease.model,
      kind: lease.kind,
      description: lease.description,
      session: lease.session,
      sessionTitle: lease.sessionTitle,
      turn: lease.turn,
      modality: lease.modality,
      meta: lease.meta,
    };
  }

  // Denormalize the identity onto lease/waiter audit events so the log answers
  // "who" without a join against the identity_up lines.
  #idFields(identityId) {
    const info = this.identities.get(identityId);
    return info ? { harness: info.harness, instance: info.instance, pid: info.pid, host: info.host, user: info.user } : {};
  }

  /**
   * Register interest in one waiter. Resolves {granted, lease, queue, waitedMs} when a
   * slot is granted; the protocol layer re-invokes on long-poll timeout (no timer lives
   * in this class).
   */
  attachWaiter(waiterId, { onGranted, onRejected }) {
    const waiter = this.waiters.get(waiterId);
    if (waiter === undefined) throw new TanError('NO_SUCH_WAITER', `unknown waiter "${waiterId}"`);
    waiter.resolve = onGranted;
    waiter.reject = onRejected;
    this.drain(waiter.queue);
  }

  cancel(waiterId, reason = 'cancelled') {
    const waiter = this.waiters.get(waiterId);
    if (waiter === undefined) return false;
    this.waiters.delete(waiterId);
    const bucket = this.#bucket(waiter.queue);
    const index = bucket.waiters.findIndex((item) => item.id === waiterId);
    if (index !== -1) bucket.waiters.splice(index, 1);
    this.onEvent('cancelled', {
      waiterId,
      queue: waiter.queue,
      identityId: waiter.identityId,
      ...this.#idFields(waiter.identityId),
      model: waiter.model,
      kind: waiter.kind,
      description: waiter.description,
      session: waiter.session,
      reason,
      waitedMs: Math.max(0, this.now() - waiter.enqueuedAt),
    });
    if (typeof waiter.reject === 'function') {
      try {
        waiter.reject(new TanError(reason === 'cancelled' ? 'CANCELLED' : 'WAITER_GONE', `waiter ${waiterId} was ${reason}`));
      } catch {
        // observer problem, not a state problem
      }
    }
    return true;
  }

  release(leaseId, reason = 'released') {
    const lease = this.leases.get(leaseId);
    if (lease === undefined || lease.released) return false;
    lease.released = true;
    this.leases.delete(leaseId);
    for (const [wid, grant] of this.grants) {
      if (grant.leaseId === leaseId) this.grants.delete(wid);
    }
    if (lease.queue !== null) {
      const bucket = this.#bucket(lease.queue);
      bucket.active.delete(leaseId);
      this.onEvent('released', {
        leaseId,
        queue: lease.queue,
        identityId: lease.identityId,
        ...this.#idFields(lease.identityId),
        model: lease.model,
        kind: lease.kind,
        description: lease.description,
        session: lease.session,
        runMs: Math.max(0, this.now() - lease.startedAt),
        waitedMs: Math.max(0, Number(lease.waitedMs ?? 0)),
        reason,
        active: bucket.active.size,
        limit: bucket.limit === Infinity ? null : bucket.limit,
      });
      this.drain(lease.queue);
    } else {
      this.onEvent('released', { ...this.#leaseFields(lease), queue: null, unlimited: true, runMs: Math.max(0, this.now() - lease.startedAt), reason, active: 0, limit: null });
    }
    return true;
  }

  forceRelease(leaseId) {
    return this.release(leaseId, 'force_release');
  }

  /**
   * Claim the lease a compliant client is holding for (model, instance) so the
   * admission proxy can forward the corresponding HTTP request without a second
   * acquire (which would double-count the slot and risk self-deadlock). The
   * `instance` is the client's SELF-IDENTITY (its registered identity's instance
   * name, e.g. "web" / "lab-foo") — not a secret. One checkout per lease: the
   * first claimant wins, later claims for the same lease miss. Returns {leaseId,
   * queue} or null when there is no matching held lease — the proxy then falls
   * back to hard queueing.
   */
  checkout({ model, instance } = {}) {
    if (typeof model !== 'string' || model === '') return null;
    if (typeof instance !== 'string' || instance === '') return null;
    let oldest = null;
    for (const lease of this.leases.values()) {
      if (lease.queue === null) continue; // unlimited (unmapped) leases are not proxy-claimed
      if (lease.model !== model) continue;
      if (this.identities.get(lease.identityId)?.instance !== instance) continue;
      if (lease.checkedOut) continue;
      if (oldest === null || lease.startedAt < oldest.startedAt) oldest = lease;
    }
    if (oldest === null) return null;
    oldest.checkedOut = true;
    return { leaseId: oldest.id, queue: oldest.queue };
  }

  drain(queueId) {
    const bucket = this.buckets.get(queueId);
    if (bucket === undefined) return;
    this.#noteBusy(bucket);
    while (bucket.active.size < bucket.limit && bucket.waiters.length > 0) {
      const waiter = bucket.waiters.shift();
      this.waiters.delete(waiter.id);
      const lease = this.#lease(queueId, { ...waiter, waitedMs: Math.max(0, this.now() - waiter.enqueuedAt) });
      // Remember the grant so a `wait` that arrives AFTER promotion can still
      // claim its lease (the waiter is already gone from the queue).
      this.grants.set(waiter.id, { leaseId: lease.id, queue: queueId, waitedMs: lease.waitedMs, identityId: waiter.identityId });
      const { resolve, ...rest } = waiter;
      void rest;
      if (typeof resolve === 'function') {
        try {
          resolve({ granted: true, lease, queue: queueId, waitedMs: lease.waitedMs });
        } catch {
          // observer problem
        }
      }
    }
  }

  /** Claim a grant made to a waiter that has already been promoted. One-shot. */
  takeGrant(waiterId) {
    const grant = this.grants.get(waiterId);
    if (grant === undefined) return undefined;
    this.grants.delete(waiterId);
    return grant;
  }

  waitersFor(identityId, queueId) {
    return [...this.waiters.values()].filter((waiter) => (identityId === undefined || waiter.identityId === identityId) && (queueId === undefined || waiter.queue === queueId));
  }

  /** Oldest-first busy history (0/1 per second) for one queue's 60 s graph. */
  history(queueId) {
    const bucket = this.buckets.get(queueId);
    if (bucket === undefined) return [];
    this.#noteBusy(bucket);
    const out = [];
    for (let i = 0; i < 60; i += 1) out.push(bucket.history[(bucket.historyIndex + 1 + i) % 60]);
    return out;
  }

  snapshot(now = this.now()) {
    const providers = [];
    let totalActive = 0;
    let totalWaiting = 0;
    for (const bucket of this.buckets.values()) {
      const active = [...bucket.active.values()].map((lease) => ({
        leaseId: lease.id,
        identityId: lease.identityId,
        identity: this.#identityString(lease.identityId),
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
        waitedMs: Math.max(0, Number(lease.waitedMs ?? 0)),
      }));
      const waiters = bucket.waiters.map((waiter, index) => ({
        waiterId: waiter.id,
        identityId: waiter.identityId,
        identity: this.#identityString(waiter.identityId),
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
      providers.push({
        id: bucket.id,
        limit: bucket.limit === Infinity ? null : bucket.limit,
        unlimited: bucket.limit === Infinity,
        used: active.length,
        active,
        waiters,
        history60: this.history(bucket.id),
      });
    }
    providers.sort((a, b) => a.id.localeCompare(b.id));
    const identities = [...this.identities.entries()].map(([identityId, info]) => ({
      identityId,
      identity: this.#identityString(identityId),
      ...info,
      leases: [...this.leases.values()].filter((lease) => lease.identityId === identityId).length,
      waiters: this.waitersFor(identityId).length,
    }));
    identities.sort((a, b) => a.identity.localeCompare(b.identity));
    return { asOf: now, totals: { active: totalActive, waiting: totalWaiting }, queues: providers, identities };
  }

  #identityString(identityId) {
    const info = this.identities.get(identityId);
    if (info === undefined) return 'unknown';
    return `${info.harness}/${info.instance}#${info.pid}@${info.host}`;
  }
}
