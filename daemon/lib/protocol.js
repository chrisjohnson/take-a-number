// take-a-number daemon: connection protocol. Newline-delimited JSON over UDS or
// TCP. The first request on a connection must be `register`; identity lifetime is
// the connection's lifetime (close ⇒ identityDown ⇒ leases released, waiters
// cancelled). `events` turns the connection into an NDJSON push stream.

import { randomUUID } from 'node:crypto';

const MAX_FRAME = 64 * 1024;
const COALESCE_MS = 150;
const KEEPALIVE_MS = 15000;

export class EventFeed {
  constructor() {
    this.subscribers = new Set();
    this.dirty = false;
    this.timer = null;
    this.frameBuilder = null; // () => object; the current frame payload
  }

  setFrameBuilder(fn) {
    this.frameBuilder = fn;
  }

  notify() {
    this.dirty = true;
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, COALESCE_MS);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.subscribers.size === 0 || this.frameBuilder === null) return;
    let line;
    try {
      const frame = this.frameBuilder();
      if (frame === null) return;
      line = JSON.stringify(frame) + '\n';
    } catch {
      return;
    }
    for (const sub of this.subscribers) {
      try {
        sub.write(line);
        sub.last = Date.now();
      } catch {
        // socket gone; cleanup happens on close
      }
    }
  }

  /** Returns an unsubscribe function. */
  subscribe(write) {
    const sub = { write, last: Date.now() };
    this.subscribers.add(sub);
    // Initial snapshot: subscribers see the current state immediately instead
    // of waiting for the next event — a quiet machine must not render a
    // blank dashboard until something happens.
    if (this.frameBuilder !== null) {
      try {
        const frame = this.frameBuilder();
        if (frame !== null) {
          write(JSON.stringify(frame) + '\n');
          sub.last = Date.now();
        }
      } catch {
        // a builder failure surfaces on the next flush
      }
    }
    const keepAlive = setInterval(() => {
      if (Date.now() - sub.last >= KEEPALIVE_MS) {
        try {
          write(`${JSON.stringify({ type: 'keepalive', at: Date.now() })}\n`);
          sub.last = Date.now();
        } catch {
          // gone
        }
      }
    }, KEEPALIVE_MS);
    if (typeof keepAlive.unref === 'function') keepAlive.unref();
    sub.keepAlive = keepAlive;
    return () => {
      this.subscribers.delete(sub);
      clearInterval(keepAlive);
    };
  }

  close() {
    for (const sub of this.subscribers) clearInterval(sub.keepAlive);
    this.subscribers.clear();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Wire one queues event to the audit log + event feed, with a frame builder.
 * `frame` is the serialized snapshot-ish payload subscribers receive.
 */
export function connectEvents(queues, feed, audit) {
  queues.onEvent = (type, payload) => {
    audit.record({ event: type, ...payload });
    feed.notify();
  };
}

export function handleConnection(socket, deps, initialData) {
  const { queues, audit, feed, version, uptimeMs, persistConfig } = deps;
  let identityId = null;
  let registered = false;
  let mode = 'request'; // 'request' | 'events'
  let unsubscribeEvents = null;
  let buffer = '';
  const pendingWaits = new Map(); // waiterId -> {respond, timer}

  const send = (obj) => {
    try {
      socket.write(JSON.stringify(obj) + '\n');
    } catch {
      // close will clean up
    }
  };

  const respond = (id, ok, extra = {}) => send({ id, ok, ...extra });

  const fail = (id, code, message, details) =>
    respond(id, false, { error: { code, message, ...(details === undefined ? {} : { details }) } });

  const positionOf = (waiterId) => {
    for (const queue of queues.snapshot().queues) {
      const index = queue.waiters.findIndex((waiter) => waiter.waiterId === waiterId);
      if (index !== -1) return index + 1;
    }
    return 0;
  };

  const clearPendingWaits = (reason) => {
    for (const [waiterId, pending] of pendingWaits) {
      clearTimeout(pending.timer);
      pendingWaits.delete(waiterId);
      pending.respond({ id: pending.id, ok: true, status: 'cancelled' });
      void waiterId;
      void reason;
    }
  };

  const onGranted = (waiterId, pending) => (result) => {
    const entry = pendingWaits.get(waiterId);
    if (entry === undefined || entry !== pending) return;
    clearTimeout(pending.timer);
    pendingWaits.delete(waiterId);
    respond(pending.id, true, { status: 'granted', leaseId: result.lease.id, queue: result.queue, waitedMs: result.waitedMs });
  };

  const onRejected = (waiterId, pending) => () => {
    const entry = pendingWaits.get(waiterId);
    if (entry === undefined || entry !== pending) return;
    clearTimeout(pending.timer);
    pendingWaits.delete(waiterId);
    respond(pending.id, true, { status: 'cancelled' });
  };

  const dispatch = (msg) => {
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      return fail(msg?.id ?? null, 'BAD_FRAME', 'frame must be a JSON object');
    }
    const { id, type } = msg;
    if (typeof id !== 'string' || id === '' || typeof type !== 'string') {
      return fail(id ?? null, 'BAD_FRAME', 'frame needs string id and type');
    }
    // An events subscription may open a connection anonymously: subscribers
    // hold no leases, so they take no identity (and no identity_up/_down audit
    // churn) — panels re-subscribe their stream periodically.
    if (!registered && type !== 'register' && type !== 'events') {
      fail(id, 'NOT_REGISTERED', 'the first request on a connection must be register');
      socket.destroy();
      return;
    }
    try {
      switch (type) {
        case 'register': {
          if (registered) return fail(id, 'ALREADY_REGISTERED', 'connection already registered');
          const { harness, instance, pid, host, user, version: clientVersion } = msg;
          if (typeof harness !== 'string' || harness === '') return fail(id, 'BAD_REQUEST', 'register needs a harness');
          identityId = randomUUID();
          const info = {
            harness,
            instance: typeof instance === 'string' && instance !== '' ? instance : 'default',
            pid: Number.isInteger(pid) ? pid : null,
            host: typeof host === 'string' ? host : 'unknown',
            user: typeof user === 'string' ? user : 'unknown',
            version: typeof clientVersion === 'string' ? clientVersion : null,
          };
          queues.registerIdentity(identityId, info);
          registered = true;
          respond(id, true, { identityId });
          return;
        }
        case 'acquire': {
          if (!registered) return fail(id, 'NOT_REGISTERED', 'register first');
          const result = queues.acquire({ identityId, ...pick(msg, ['model', 'provider', 'kind', 'description', 'session', 'sessionTitle', 'turn', 'modality', 'meta']) });
          if (result.status === 'queued') {
            return respond(id, true, {
              status: 'queued',
              waiterId: result.waiter.id,
              queue: result.queue,
              position: result.position,
              active: result.active,
              limit: result.limit,
            });
          }
          return respond(id, true, { status: result.status, leaseId: result.lease.id, queue: result.queue });
        }
        case 'wait': {
          if (!registered) return fail(id, 'NOT_REGISTERED', 'register first');
          const { waiterId, timeoutMs } = msg;
          if (typeof waiterId !== 'string') return fail(id, 'BAD_REQUEST', 'wait needs a waiterId');
          if (queues.waiters.get(waiterId) === undefined) {
            const grant = queues.takeGrant(waiterId);
            if (grant) {
              return respond(id, true, { status: 'granted', leaseId: grant.leaseId, queue: grant.queue, waitedMs: grant.waitedMs });
            }
            return fail(id, 'NO_SUCH_WAITER', `unknown waiter "${waiterId}"`);
          }
          const timeout = Math.min(Math.max(Number(timeoutMs) || 25000, 1000), 25000);
          const pending = { id, respond, timer: null };
          pendingWaits.set(waiterId, pending);
          queues.attachWaiter(waiterId, { onGranted: onGranted(waiterId, pending), onRejected: onRejected(waiterId, pending) });
          // The waiter may have been drained synchronously by attachWaiter (slot free).
          if (pendingWaits.get(waiterId) === pending) {
            pending.timer = setTimeout(() => {
              if (pendingWaits.get(waiterId) !== pending) return;
              pendingWaits.delete(waiterId);
              const snapshot = queues.snapshot();
              const queue = snapshot.queues.find((q) => q.waiters.some((w) => w.waiterId === waiterId));
              respond(id, true, {
                status: 'still-queued',
                position: queue ? queue.waiters.find((w) => w.waiterId === waiterId).position : 0,
                active: queue ? queue.used : 0,
                limit: queue ? queue.limit : null,
              });
            }, timeout);
            if (typeof pending.timer.unref === 'function') pending.timer.unref();
          }
          return;
        }
        case 'release': {
          const { leaseId } = msg;
          if (typeof leaseId !== 'string') return fail(id, 'BAD_REQUEST', 'release needs a leaseId');
          const released = queues.release(leaseId);
          return respond(id, true, { released });
        }
        case 'cancel': {
          const { waiterId } = msg;
          if (typeof waiterId !== 'string') return fail(id, 'BAD_REQUEST', 'cancel needs a waiterId');
          const cancelled = queues.cancel(waiterId);
          return respond(id, true, { cancelled });
        }
        case 'force-release': {
          const { leaseId } = msg;
          if (typeof leaseId !== 'string') return fail(id, 'BAD_REQUEST', 'force-release needs a leaseId');
          const released = queues.forceRelease(leaseId);
          return respond(id, true, { released });
        }
        case 'status': {
          const snap = queues.snapshot();
          return respond(id, true, { ...snap, uptimeMs: uptimeMs(), version });
        }
        case 'events': {
          if (mode !== 'request') return fail(id, 'BAD_STATE', 'connection already in events mode');
          mode = 'events';
          respond(id, true, { streaming: true });
          unsubscribeEvents = feed.subscribe((line) => socket.write(line));
          return;
        }
        case 'set-limits': {
          const { queues: nextQueues, queueLimit } = msg;
          if (!Array.isArray(nextQueues)) return fail(id, 'BAD_REQUEST', 'set-limits needs a queues array');
          try {
            queues.configure(nextQueues.map((entry) => ({ ...entry, limit: entry.unlimited === true ? Infinity : entry.limit })));
            if (Number.isInteger(queueLimit) && queueLimit >= 1) queues.queueLimit = queueLimit;
          } catch (error) {
            return fail(id, 'BAD_CONFIG', String(error?.message ?? error));
          }
          if (typeof persistConfig === 'function') {
            try {
              persistConfig();
            } catch {
              // persistence is best-effort; the in-memory change stands
            }
          }
          return respond(id, true, { ...queues.snapshot(), uptimeMs: uptimeMs(), version });
        }
        default:
          return fail(id, 'UNKNOWN_TYPE', `unknown type "${type}"`);
      }
    } catch (error) {
      const code = error?.code ?? 'INTERNAL';
      return fail(id, code, String(error?.message ?? error), error?.details);
    }
  };

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > MAX_FRAME) {
      fail(null, 'FRAME_TOO_LARGE', 'frame exceeds 64 KiB');
      socket.destroy();
      return;
    }
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(null, 'BAD_JSON', 'frame is not valid JSON');
        continue;
      }
      if (mode === 'events') continue; // an events stream takes no more requests
      dispatch(msg);
    }
  });

  const cleanup = () => {
    if (unsubscribeEvents !== null) {
      try {
        unsubscribeEvents();
      } catch {
        // already gone
      }
      unsubscribeEvents = null;
    }
    clearPendingWaits('connection_closed');
    if (registered && identityId !== null) {
      const result = queues.identityDown(identityId);
      audit.record({ event: 'connection_closed', identityId, ...result });
      registered = false;
    }
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);

  if (initialData !== undefined && initialData.length > 0) socket.emit('data', initialData);
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}
