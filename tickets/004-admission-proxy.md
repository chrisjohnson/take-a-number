# T4 — Admission proxy in front of litellm (soft + hard entry)

**Status:** in progress
**Repos:** `chrisjohnson/take-a-number` (proxy + daemon `checkout`), `chrisjohnson/dsh-plugins`
(plugin: instance token + lease-aware gate), `chrisjohnson/dsh-deploy` (pin + provider header),
`chrisjohnson/local-ai-machine` (compose service for the proxy, new port)
**Depends on:** T1/T2/T3 done (daemon, plugin, box deploy all live)

## Why

T3 made the queue **opt-in per harness**: dsh (via the plugin) queues its own calls, but anything
else that hits litellm directly — a raw curl, another agent, a benchmark, a future harness —
tramples the GPU with no queueing at all. The fix is an **admission proxy** that sits in front of
litellm and makes queueing **mandatory for all traffic** while preserving the two entry postures:

- **Compliant clients** (dsh via the plugin) already reserved their turn in the daemon's queue.
  They idle their own action loop while they wait, then send the real request. The proxy
  recognizes the request belongs to an already-held lease and lets it straight through — no second
  queueing, no double-count.
- **Non-compliant clients** (everything else) send a normal request. The proxy acquires a lease on
  their behalf and **holds the HTTP request open** while it waits its turn — the standard
  "long request" concurrency behavior. On grant it forwards; on completion/abort it releases.

Both entry classes enter the **same FIFO queue**, so order is fair; the only difference is *how*
the client waits (idle loop vs. held socket). The proxy is a **gate, not a data transformer**: it
pipes bytes (including SSE token streams) unmodified and adds one local UDS round-trip to the
daemon. Model traffic is KB/s, so the data-path overhead is negligible.

## The dsh constraint that shaped the design

The naive design was a per-call `x-tan-lease: <leaseId>` header the plugin injects. **That is not
possible in dsh 0.2.2**: the `llm/stream` waterfall hands the plugin `GenerateOptions`
(`dsh-llm/lib/types/types.d.ts`), which has **no `headers` field** — only provider, model,
messages, system, tools, temperature, maxTokens, stop, signal, sessionId, purpose. The plugin
cannot put a per-call value into dsh's outgoing HTTP request.

What dsh *does* allow is a **static** `headers` map in the provider config
(`dsh-llm-pi-ai/lib/index.js` `headers: z.dict(z.string())`, spread into every wire request).
So the compliant marker is a **per-instance identity token**, set once in dsh's provider config as
a static `x-tan-client: <token>` header, and per-call correlation is done **in the daemon** by
`(model, clientToken) → lease checkout`. The token is a light per-instance secret: it
disambiguates multiple dsh instances and prevents a non-compliant client from piggybacking on a
compliant client's held lease (a rogue curl can't forge a token it doesn't have).

## Protocol additions (daemon)

1. `acquire` accepts an optional `clientToken` (string). It is stored on the resulting lease
   (`lease.clientToken`) so the proxy can correlate. Purely additive; existing clients unaffected.
2. New op **`checkout { model, clientToken }`** → `{ leaseId } | { leaseId: null }`.
   - Finds the oldest lease in `active` with `lease.model === model` && `lease.clientToken ===
     clientToken` && `!lease.checkedOut` && `lease.queue !== null`.
   - Marks it `lease.checkedOut = true` (one request per lease) and returns its id.
   - Returns `null` when there is no matching held lease (client sent a request without a
     reservation, or it was already claimed) — the proxy then falls back to hard queueing.
3. `release` stays **idempotent** (it already is: a second release is a no-op returning `false`).
   That idempotency is what makes split release-ownership safe: the proxy releases when the
   forwarded request completes, and the plugin releases when its `next()` settles; whichever fires
   second is a harmless no-op.

## Proxy design (`proxy/main.js`)

```
node proxy/main.js --upstream 127.0.0.1:4000 --listen 127.0.0.1:4140 \
  --sock /run/take-a-number/tan.sock --instance tan-proxy
```

Per request:
1. Buffer the request body (cap ~64 MB); parse `model` from the JSON (chat/completions shape).
   Unparseable / no model → treat as unmapped.
2. **Compliant path** — request carries `x-tan-client: <token>` and the model is mapped:
   - `checkout { model, clientToken }`.
     - `leaseId` returned → forward the request as-is; on response finish/abort
       `release(leaseId, 'proxy_forwarded')`.
     - `null` → no held lease → fall through to the hard path.
3. **Hard path** (non-compliant, or compliant-without-lease): `acquire { model, identityId:
   <proxy> }` (real lease for a mapped model, unlimited lease for unmapped). If `queued`, long-poll
   `wait` until grant, honoring client abort → `cancel` the waiter and destroy the socket. On
   grant, forward; on finish/abort `release`.
4. **Fail-open**: if the daemon is unreachable, forward without queueing and log it (consistent
   with the daemon's own fail-open philosophy). The box's models stay up even if the queue brain
   is down.
5. Pipe the upstream response (status, headers, body — SSE included) to the client unmodified.
   No request/response transformation; `Authorization` and all client headers pass through so
   litellm's own key auth is untouched.
6. `/healthz` → 200 for compose healthchecks (never queued).

Ownership/liveness edges:
- **Client abort while queued** → `cancel(waiter)` + destroy socket; no lease leak.
- **Upstream 5xx** → release the lease, pipe the error response to the client.
- **Proxy crash** → `identityDown` releases all proxy-held leases; the forwarded sockets die with
  the process, so freeing the slots is correct.
- **Reserved-but-never-forwarded** (client granted, then crashes before the request arrives) →
  `identityDown` on the client frees it. A granted lease with no matching request is a transient
  state bounded by the client's own release-on-abort.

## Box deployment (option port first, caddy switch later)

- New compose service `tan-proxy` from the **same** `take-a-number` image, `command: node
  proxy/main.js …`, publishing `127.0.0.1:4140:4140`, sharing the daemon's socket + audit volumes.
- **For now the proxy is an option**: it listens on `4140`; clients opt in by pointing there.
  litellm stays on `4000` and is the proxy's upstream. The planned end state is to point litellm's
  Caddy route at the proxy (proxy then fronts `4000`), making queueing mandatory for all external
  traffic — that switch is a follow-up, not part of this ticket.
- dsh's provider base URL is pointed at the proxy (`4140`) to prove the compliant + non-compliant
  flows end to end before any Caddy change.

## Safety constraints (this agent runs on the box)

- This agent runs as **medium-dense** via opencode → t3code → litellm `:4000`. Tests and manual
  exercise must use **big-moe** (APU queue), never medium-dense, so the agent doesn't queue or
  trample its own inference.
- When dsh is cut over to the proxy, the agent's own client (opencode/t3code) will show up as a
  **non-compliant** hard-queued caller until its config is also made compliant. Expected, not a bug.
- Do **not** touch the t3code user's main opencode config. The opencode proof uses a separate lab
  config + standalone opencode instances.

## Deliverables

1. **take-a-number**: daemon `clientToken` on `acquire` + `checkout` op + tests; `proxy/main.js`
   + a thorough e2e test suite (compliant pass-through, hard queue behind a hold, abort-while-
   queued, unmapped forward, fail-open, SSE pipe, health, body integrity, idempotent release);
   repo polished for publication (README proxy section, package.json, tidy). Release `v0.3.0` + image.
2. **dsh-plugins** `take-a-number`: plugin carries a per-instance `clientToken` (config), passes
   it to `acquire`, and relies on proxy release (idempotent) instead of assuming sole ownership.
   Release `v0.1.3`.
3. **dsh-deploy**: bump the plugin pin; add the static `x-tan-client` header to dsh's litellm
   provider config; point dsh's litellm base URL at the proxy port.
4. **local-ai-machine**: `tan-proxy` compose service on `4140` (option port); deploy.
5. **Proofs**: compliant flow (dsh turn on big-moe queued behind a CLI hold, then granted +
   released); non-compliant flow (raw curl to the proxy hard-queued behind the same hold);
   dashboard shows both identities and the queue draining smoothly; multiple review rounds.
6. **Opencode lab**: standalone lab config + standalone opencode instance against the proxy
   (non-compliant hard-queue proof), main t3code opencode config untouched.

## Out of scope (follow-ups)

- Pointing litellm's Caddy route at the proxy (mandatory queueing for all external traffic).
- Making opencode/t3code a compliant client (per-call reservation in opencode's provider path).
- Per-call key attribution for non-compliant clients (shared litellm key today; the proxy records
  one `tan-proxy` identity for all hard-queued traffic).
