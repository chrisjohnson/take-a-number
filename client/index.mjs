// take-a-number client: plain ESM, zero runtime dependencies. Runs on Node 20+
// and Bun. Connects over UDS (preferred) with TCP fallback, speaks the
// newline-delimited JSON protocol, and is fail-open: when the daemon is down,
// `acquire` degrades to an un-gated pass-through after ~300 ms instead of
// blocking.

import { connect as netConnect } from 'node:net';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';

export const VERSION = '0.3.0';

export class TanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TanError';
    this.code = code;
  }
}

const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 16000, 30000];

export class TanClient {
  /**
   * @param {object} opts
   * @param {string} [opts.sock] UDS path (default /run/take-a-number/tan.sock)
   * @param {string} [opts.tcp]  TCP host:port (default 127.0.0.1:4100)
   * @param {string} opts.harness  'dsh' | 'opencode' | …
   * @param {string} [opts.instance] 'web' | 'lab-<name>' | …
   * @param {string} [opts.user]
   * @param {number} [opts.degradedAfterMs] flip to fail-open after this long unreachable (default 300)
   */
  constructor({
    sock = '/run/take-a-number/tan.sock',
    tcp = '127.0.0.1:4100',
    harness,
    instance = 'default',
    user = (typeof userInfo === 'function' && userInfo().username) || 'unknown',
    degradedAfterMs = 300,
  } = {}) {
    if (!harness) throw new TanError('BAD_CONFIG', 'TanClient needs a harness');
    this.sock = sock;
    this.tcp = tcp;
    this.identity = { harness, instance, pid: process.pid, host: hostname(), user, version: VERSION };
    this.degradedAfterMs = degradedAfterMs;

    this.socket = null;
    this.identityId = null;
    this.buffer = '';
    this.pending = new Map(); // id -> {resolve, reject}
    this.connected = false;
    this.registered = false;
    this.closing = false;
    this.backoffIndex = 0;
    this.reconnectTimer = null;
    this.degradedTimer = null;
    this.degraded = false;
    this.udsDenied = false; // a UDS connect we may not be allowed to make (EACCES)
    this.listeners = new Map(); // event -> Set<fn>
    this.eventSub = null; // socket used for events streaming
    this.eventCb = null;
    this.waiterQueue = new Map(); // waiterId -> fields (for re-enqueue after daemon restart)
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(cb);
    return () => this.listeners.get(event)?.delete(cb);
  }

  #emit(event, payload) {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        cb(payload);
      } catch {
        // listener problem
      }
    }
  }

  #setDegraded(value) {
    if (this.degraded === value) return;
    this.degraded = value;
    this.#emit(value ? 'degraded' : 'restored', { degraded: value });
  }

  #scheduleReconnect() {
    if (this.closing) return;
    const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)];
    this.backoffIndex += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
    if (!this.connected) this.#armDegradedTimer();
  }

  #armDegradedTimer() {
    if (this.degradedTimer !== null) return;
    this.degradedTimer = setTimeout(() => {
      this.degradedTimer = null;
      if (!this.closing) this.#setDegraded(true);
    }, this.degradedAfterMs);
    if (typeof this.degradedTimer.unref === 'function') this.degradedTimer.unref();
  }

  #clearDegradedTimer() {
    if (this.degradedTimer !== null) {
      clearTimeout(this.degradedTimer);
      this.degradedTimer = null;
    }
  }

  #connect() {
    if (this.closing || this.socket !== null) return;
    // A socket file we cannot write to (EACCES) is not "daemon down" — it is
    // "use the TCP fallback". Remember the denial so every subsequent
    // reconnect goes straight to TCP instead of burning a backoff cycle.
    const useUds = existsSync(this.sock) && !this.udsDenied;
    let socket;
    try {
      if (useUds) {
        this.transport = { kind: 'uds', path: this.sock };
        socket = netConnect({ path: this.sock });
      } else {
        const [host, port] = this.tcp.split(':');
        this.transport = { kind: 'tcp', host, port: Number(port) };
        socket = netConnect(Number(port), host);
      }
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.buffer = '';
    let connectedOnce = false;
    socket.on('connect', () => {
      connectedOnce = true;
      this.connected = true;
      this.backoffIndex = 0;
      this.#clearDegradedTimer();
      this.#setDegraded(false);
      this.#send({ type: 'register', ...this.identity }).then((res) => {
        this.identityId = res.identityId;
        this.registered = true;
        this.#emit('registered', { identityId: this.identityId });
        this.#requeueAfterRestart();
      }).catch(() => {});
    });
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let index;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line === '') continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const pending = this.pending.get(msg.id);
        if (pending === undefined) continue;
        this.pending.delete(msg.id);
        if (msg.ok) pending.resolve(msg);
        else pending.reject(new TanError(msg.error?.code ?? 'PROTOCOL', msg.error?.message ?? 'request failed'));
      }
    });
    const onDeath = () => {
      this.connected = false;
      this.registered = false;
      this.identityId = null;
      this.socket = null;
      for (const pending of this.pending.values()) {
        pending.reject(new TanError('DISCONNECTED', 'connection closed'));
      }
      this.pending.clear();
      if (this.eventCb !== null) {
        this.eventCb = null;
      }
      this.#setDegraded(true);
      this.#scheduleReconnect();
    };
    socket.on('close', onDeath);
    socket.on('error', (error) => {
      if (!connectedOnce) {
        if (this.transport.kind === 'uds' && (error?.code === 'EACCES' || error?.code === 'EPERM')) {
          this.udsDenied = true;
        }
        // connect failed; schedule retry
        socket.destroy();
      } else {
        socket.destroy();
      }
      void error;
    });
  }

  async connect() {
    if (this.socket !== null || this.closing) return;
    this.#connect();
    // Give the first attempt a moment; do not block the caller forever.
    // Deliberately NOT unref'd: in a short-lived process (the CLI) this timer
    // is the only ref'd handle while the first connect is failing over, and an
    // unref'd timer lets the event loop drain and the process exit with the
    // caller's await still pending.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      this.on('registered', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #send(msg) {
    return new Promise((resolve, reject) => {
      if (this.socket === null || !this.connected) {
        reject(new TanError('NOT_CONNECTED', 'no daemon connection'));
        return;
      }
      const id = randomUUID();
      msg.id = id;
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new TanError('TIMEOUT', 'request timed out'));
      }, 30000);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        this.socket.write(JSON.stringify(msg) + '\n');
      } catch (error) {
        this.pending.delete(id);
        reject(new TanError('WRITE_FAILED', String(error?.message ?? error)));
      }
    });
  }

  #requeueAfterRestart() {
    // After a daemon restart, waiters are gone. Re-acquire each tracked waiter.
    for (const [waiterId, fields] of [...this.waiterQueue]) {
      this.waiterQueue.delete(waiterId);
      this.acquire(fields).catch(() => {});
    }
  }

  /**
   * Gate one model call.
   * @returns {Promise<{status:'granted', leaseId:string, queue:string} | {status:'queued', waiterId:string, queue:string, position:number} | {status:'degraded', leaseId:null, queue:string|null}>}
   */
  async acquire(fields = {}) {
    if (this.degraded || this.socket === null) {
      return { status: 'degraded', leaseId: null, queue: fields.model ?? null };
    }
    try {
      const res = await this.#send({ type: 'acquire', ...fields });
      if (res.status === 'queued') this.waiterQueue.set(res.waiterId, fields);
      return res;
    } catch (error) {
      if (error instanceof TanError && (error.code === 'NOT_CONNECTED' || error.code === 'DISCONNECTED' || error.code === 'TIMEOUT')) {
        this.#armDegradedTimer();
        return { status: 'degraded', leaseId: null, queue: fields.model ?? null };
      }
      throw error;
    }
  }

  /**
   * Long-poll one waiter. Resolves when granted, still-queued (long-poll expired),
   * cancelled, or degraded (daemon unreachable — the waiter position is kept in
   * this.waiterQueue and re-established on reconnect).
   */
  async waitFor({ waiterId, timeoutMs = 25000 } = {}) {
    if (this.degraded || this.socket === null) return { status: 'degraded' };
    try {
      const res = await this.#send({ type: 'wait', waiterId, timeoutMs });
      if (res.status === 'granted' || res.status === 'cancelled') this.waiterQueue.delete(waiterId);
      return res;
    } catch (error) {
      if (error instanceof TanError && (error.code === 'NOT_CONNECTED' || error.code === 'DISCONNECTED' || error.code === 'TIMEOUT')) {
        this.#armDegradedTimer();
        return { status: 'degraded' };
      }
      throw error;
    }
  }

  release(leaseId) {
    if (leaseId === null || leaseId === undefined) return;
    this.#send({ type: 'release', leaseId }).catch(() => {});
  }

  cancel(waiterId) {
    this.waiterQueue.delete(waiterId);
    return this.#send({ type: 'cancel', waiterId }).catch(() => ({ cancelled: false }));
  }

  forceRelease(leaseId) {
    return this.#send({ type: 'force-release', leaseId }).catch(() => ({ released: false }));
  }

  /**
   * Claim the lease this client is holding for (model, clientToken) so an
   * admission proxy can forward the matching HTTP request without a second
   * acquire. Resolves {leaseId, queue}; {leaseId: null} when there is no held
   * lease to claim or the daemon is unreachable (the proxy then hard-queues).
   */
  async checkout({ model, clientToken } = {}) {
    if (this.degraded || this.socket === null) return { leaseId: null, queue: null };
    try {
      const res = await this.#send({ type: 'checkout', model, clientToken });
      return { leaseId: res.leaseId ?? null, queue: res.queue ?? null };
    } catch (error) {
      if (error instanceof TanError && (error.code === 'NOT_CONNECTED' || error.code === 'DISCONNECTED' || error.code === 'TIMEOUT')) {
        this.#armDegradedTimer();
        return { leaseId: null, queue: null };
      }
      throw error;
    }
  }

  status() {
    return this.#send({ type: 'status' }).catch(() => null);
  }

  setLimits(payload) {
    return this.#send({ type: 'set-limits', ...payload }).catch(() => null);
  }

  /**
   * Subscribe to live status frames (NDJSON over a dedicated connection).
   * @param {(frame:object)=>void} cb
   * @returns {()=>void} unsubscribe
   */
  events(cb) {
    if (this.eventCb !== null) this.events(); // drop the previous subscription
    this.eventCb = cb;
    if (this.transport === undefined) return () => {
      this.eventCb = null;
    };
    const dedicated = this.transport.kind === 'uds'
      ? netConnect({ path: this.transport.path })
      : netConnect(this.transport.port, this.transport.host);
    this.eventSub = dedicated;
    let buffer = '';
    dedicated.on('connect', () => {
      // Anonymous subscription: no register, so the daemon takes no identity
      // for the stream and its periodic re-subscription is audit-quiet.
      dedicated.write(JSON.stringify({ id: randomUUID(), type: 'events' }) + '\n');
      dedicated.write(JSON.stringify({ id: randomUUID(), type: 'events' }) + '\n');
    });
    dedicated.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line === '') continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'status' && this.eventCb !== null) {
          try {
            this.eventCb(msg);
          } catch {
            // listener problem
          }
        }
      }
    });
    const cleanup = () => dedicated.destroy();
    dedicated.on('close', () => {
      if (this.eventSub === dedicated) {
        this.eventSub = null;
        this.eventCb = null;
        // reconnect the stream with the main socket's backoff
        setTimeout(() => {
          if (!this.closing && this.eventCb !== null) this.events(cb);
        }, 1000).unref?.();
      }
    });
    return () => {
      cleanup();
      if (this.eventSub === dedicated) this.eventSub = null;
      this.eventCb = null;
    };
  }

  close() {
    this.closing = true;
    this.#clearDegradedTimer();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.eventSub !== null) this.eventSub.destroy();
    if (this.socket !== null) this.socket.end();
  }
}

/**
 * Convenience: gate one model call end-to-end (acquire → wait → run → release).
 * `fn(leaseId | null)` — null means degraded pass-through.
 *
 * `{ signal }` — aborting while queued cancels the waiter and rejects with an
 * AbortError; aborting while running is up to `fn` (the stream does it).
 * `{ onWait(info) }` — called on queue entry and each long-poll tick with
 * `{ waiterId, queue, position }`.
 */
export async function withLease(tan, fields, fn, { signal, onWait = () => {} } = {}) {
  const result = await tan.acquire(fields);
  if (signal?.aborted) throw new TanError('ABORTED', 'aborted before acquiring');
  if (result.status === 'degraded') return fn(null);
  if (result.status === 'granted') {
    try {
      return await fn(result.leaseId);
    } finally {
      tan.release(result.leaseId);
    }
  }
  onWait({ waiterId: result.waiterId, queue: result.queue, position: result.position });
  let granted = null;
  for (;;) {
    if (signal?.aborted) {
      tan.cancel(result.waiterId);
      throw new TanError('ABORTED', 'aborted while queued');
    }
    let w;
    if (signal) {
      try {
        w = await Promise.race([
          tan.waitFor({ waiterId: result.waiterId }),
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new TanError('ABORTED', 'aborted while queued')), { once: true });
          }),
        ]);
      } catch (error) {
        if (error instanceof TanError && error.code === 'ABORTED') {
          tan.cancel(result.waiterId);
          throw error;
        }
        throw error;
      }
    } else {
      w = await tan.waitFor({ waiterId: result.waiterId });
    }
    if (w.status === 'granted') {
      granted = w.leaseId;
      break;
    }
    if (w.status === 'degraded') return fn(null);
    if (w.status === 'cancelled') {
      throw new TanError('CANCELLED', 'waiter was cancelled');
    }
    onWait({ waiterId: result.waiterId, queue: result.queue, position: w.position });
  }
  if (signal?.aborted) {
    tan.release(granted);
    throw new TanError('ABORTED', 'aborted at grant');
  }
  try {
    return await fn(granted);
  } finally {
    tan.release(granted);
  }
}
