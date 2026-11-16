// take-a-number opencode plugin: the queue gate. Pure logic — inject a
// TanClient (or a fake with the same surface: acquire/waitFor/release/cancel)
// and you get a `gate()` that returns the headers for one outgoing LLM
// request. No opencode imports, no I/O: unit-testable.
//
// The gate ACQUIRES a dynamic lease and returns x-tan-client + x-tan-claim
// headers; the admission proxy checks the lease out via the claim token and
// RELEASES it when the forwarded response completes or aborts. The plugin
// never releases a grant — opencode 1.18.34 has no response hook, so release
// is proxy-owned. The one leak path (a granted lease whose request never
// reaches the proxy) is bounded by the daemon's grant-TTL sweep.

const DEFAULT_ACQUIRE_TIMEOUT_MS = 600_000;

export function createGate({ tan, instance, queues = [], acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS, now = Date.now } = {}) {
  if (!tan) throw new Error('createGate needs a tan client');
  if (typeof instance !== 'string' || instance === '') throw new Error('createGate needs an instance name');
  // Plugin-side view of the daemon's queue map. The daemon stays authoritative:
  // a model absent here passes through with no round-trip, and a model present
  // here but absent there comes back `unlimited` and degrades to pass-through.
  const mapped = new Set();
  for (const q of queues) for (const m of q?.models ?? []) if (typeof m === 'string' && m !== '') mapped.add(m);

  function claimHeaders(grant) {
    // A grant without a claim token cannot be claimed at the proxy; passing it
    // through (no headers) is the only safe move — never half-identify.
    return grant?.claimToken ? { 'x-tan-client': instance, 'x-tan-claim': grant.claimToken } : {};
  }

  async function gate({ model, sessionID, agent } = {}) {
    if (typeof model !== 'string' || model === '') return {};
    if (!mapped.has(model)) return {};
    const fields = { model, kind: 'opencode' };
    if (typeof sessionID === 'string' && sessionID !== '') fields.session = sessionID;
    fields.description = typeof agent === 'string' && agent !== '' ? `opencode · ${agent}` : 'opencode';
    let result;
    try {
      result = await tan.acquire(fields);
    } catch {
      // Daemon refused (queue full, reject mode, protocol): fail open. The
      // proxy's hard path is the backstop for admission policy.
      return {};
    }
    if (result.status === 'degraded') return {};
    if (result.status === 'unlimited') {
      // Stale plugin map: the daemon says unmapped. Pass through and release
      // the synthetic lease at once (it counts against nothing).
      tan.release(result.leaseId);
      return {};
    }
    if (result.status === 'granted') return claimHeaders(result);
    // Queued: long-poll to the grant, bounded so an abandoned call cannot hang
    // the turn forever (chat.headers carries no abort signal). On timeout:
    // cancel the waiter and pass through — the request then hard-queues at the
    // proxy (still gated, just unattributed).
    const deadline = now() + acquireTimeoutMs;
    const { waiterId } = result;
    for (;;) {
      if (now() >= deadline) {
        tan.cancel(waiterId);
        return {};
      }
      let w;
      try {
        w = await tan.waitFor({ waiterId });
      } catch {
        return {};
      }
      if (w.status === 'granted') return claimHeaders(w);
      if (w.status === 'degraded') {
        tan.cancel(waiterId);
        return {};
      }
      if (w.status === 'cancelled') return {};
      // 'still-queued': the long-poll expired; loop.
    }
  }

  return { gate };
}
