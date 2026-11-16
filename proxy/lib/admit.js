// take-a-number proxy: per-request admission decision. Pure logic — inject a
// TanClient (or a fake with the same surface: checkout/acquire/waitFor/cancel)
// and you get an `admit()` that returns the lease to forward a request under.
// No HTTP, no I/O: unit-testable with a fake client.
//
// Two entry classes share one FIFO queue:
//   - compliant: the client reserved a lease and SELF-IDENTIFIES via the
//     x-tan-client header (its instance name, e.g. "web" — not a secret).
//     `admit` checks that lease out (claims it by model + instance) so the
//     matching HTTP request forwards without a second acquire. The caller
//     releases the claimed lease when the request settles.
//   - hard: everyone else. `admit` acquires a lease under the proxy's identity
//     and long-polls until granted, honoring the caller's abort signal. The
//     caller releases the acquired lease when the request settles.
//
// A null leaseId (source 'degraded') means the daemon is unreachable: the
// caller forwards without queueing (fail-open) and releases nothing.

import { TanError } from '../../client/index.mjs';

export function createAdmitter({ client }) {
  return async function admit({ model, instance, signal } = {}) {
    if (signal?.aborted) throw new TanError('ABORTED', 'aborted before admitting');
    // Compliant path: claim a lease this (self-identified) client reserved.
    if (instance && model) {
      const claim = await client.checkout({ model, instance });
      if (claim?.leaseId) return { leaseId: claim.leaseId, source: 'checkout' };
      // No held lease (already claimed, or the request carried a name that
      // holds no reservation): fall through to the hard path, not double-acquire.
    }
    return hardAdmit(client, { model, signal });
  };
}

async function hardAdmit(client, { model, signal }) {
  const fields = {
    model: model ?? undefined,
    kind: 'proxy',
    description: model ? `proxy · ${model}` : 'proxy · unmapped',
  };
  const result = await client.acquire(fields);
  if (signal?.aborted) throw new TanError('ABORTED', 'aborted while admitting');
  if (result.status === 'degraded') return { leaseId: null, source: 'degraded' };
  if (result.status === 'granted' || result.status === 'unlimited') {
    return { leaseId: result.leaseId, source: result.status };
  }
  // Queued: long-poll until granted. An abort must interrupt the in-flight
  // long-poll (not just be noticed after it resolves), so each tick races the
  // wait against the signal — mirroring the client's withLease.
  const { waiterId, queue } = result;
  for (;;) {
    if (signal?.aborted) {
      client.cancel(waiterId);
      throw new TanError('ABORTED', 'aborted while queued');
    }
    let w;
    if (signal) {
      try {
        w = await Promise.race([
          client.waitFor({ waiterId }),
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new TanError('ABORTED', 'aborted while queued')), { once: true });
          }),
        ]);
      } catch (error) {
        if (error instanceof TanError && error.code === 'ABORTED') {
          client.cancel(waiterId);
          throw error;
        }
        throw error;
      }
    } else {
      w = await client.waitFor({ waiterId });
    }
    if (w.status === 'granted') return { leaseId: w.leaseId, source: 'acquire', queue };
    if (w.status === 'degraded') return { leaseId: null, source: 'degraded' };
    if (w.status === 'cancelled') throw new TanError('CANCELLED', 'waiter was cancelled');
    // 'still-queued': the long-poll expired; loop and keep waiting.
  }
}
