# take-a-number

Global model-call queue and lease service for locally hosted models. Every model call from
every harness — DSH instances, opencode, anything else — takes a number, waits in its GPU's
FIFO queue, runs under a lease stamped with a per-process identity, and releases. One daemon
owns all queues; a server-side dashboard shows the whole box.

Named after the deli counter: you take a number, you wait, you get called. The counter is a
GPU; the food is a model slot.

## Why

Local models are a shared, scarce resource. Before this, each harness tracked its own calls
in its own process memory: dsh-model-capacity serialized within one dsh process, opencode had
nothing, and nothing coordinated across them. Two processes hitting the same GPU at once is a
race; a queue that only one process can see is not a queue. take-a-number moves the
serialization point out of the harnesses and into one small daemon that owns the truth.

## Architecture

```
                    ┌────────────────────────── take-a-number daemon ──────────────────────────┐
 dsh (web) ─┐       │  UDS  /run/take-a-number/tan.sock                                        │
 dsh (lab) ─┼ tan-  ├─ TCP  127.0.0.1:4100  (protocol + HTTP + dashboard)                      │
 opencode ──┼ client┤                                                                         │
 tan CLI ───┘ (ESM) └──────────────────────────────────────────────────────────────────────────┘
                          │
                          │  queues per GPU (FIFO) · leases · identities · audit
                          ▲
                          │  acquire / checkout / release (UDS)
                          │
            ┌─────────────┴─────────────┐
            │   admission proxy          │   pipes bytes unmodified (SSE included)
 any HTTP ─►│   (proxy/main.js)          ├──►  litellm / any OpenAI-compatible upstream
 client ───►│   compliant → checkout     │
 (curl,     │   everyone else → hard     │
  agents,   │   queue, request held      │
  benches)  └────────────────────────────┘
```

- **`daemon/`** — the service. Pure state machine (`lib/queues.js`), protocol
  (`lib/protocol.js`), JSONL audit (`lib/audit.js`), entrypoint (`main.js`).
- **`client/index.mjs`** — `TanClient` + `withLease()`. Plain ESM, zero runtime
  dependencies, runs on Node 20+ and Bun.
- **`proxy/`** — the admission gate in front of litellm. `main.js` is the HTTP
  server; `lib/admit.js` is the pure per-request admission decision (unit-testable
  with a fake client). See [Admission proxy](#admission-proxy).
- **`bin/tan`** — CLI: `status`, `acquire`, `tail`, `force-release`, `version`.
- **`dashboard/`** — static, zero-dependency dashboard served by the daemon at `GET /`.
  Visual language ported from dsh-model-capacity's Activity UI (KPI cards, per-queue
  capacity bars, 60 s busy graphs, breathing live cards, enter/poof/FLIP animations,
  reduced-motion support, light + dark).

## Protocol

Newline-delimited JSON over UDS (preferred) and TCP (same protocol, plus HTTP on the TCP
port). The first request on a connection must be `register`; **identity lifetime is
connection lifetime** — when a connection dies, its leases are released and its waiters
cancelled, immediately. No TTL timers: a crashed process cannot hold a slot.

| request        | response (when ok)                                                     |
| -------------- | ---------------------------------------------------------------------- |
| `register`     | `{ identityId }` — first message on a connection; carries `capability` (`static` default \| `dynamic`) |
| `acquire`      | `{ status: 'granted', leaseId, queue, claimToken? }` / `{ status: 'queued', waiterId, queue, position }` / `{ status: 'unlimited' }` |
| `wait`         | long-poll ≤ 25 s: `{ status: 'granted', leaseId, queue, waitedMs, claimToken? }` / `{ status: 'still-queued', position }` / `{ status: 'cancelled' }` |
| `release`      | `{ released }` (idempotent — a second release is a no-op); optional `reason` string is audited verbatim (default `released`; the proxy sends `watchdog` for a hung generation) |
| `checkout`     | `{ leaseId, queue }` / `{ leaseId: null }` — admit a request by (model, instance[, token]) |
| `cancel`       | `{ cancelled }` (one waiter)                                            |
| `force-release`| `{ released }` (ops)                                                    |
| `status`       | full snapshot: queues, active leases, waiters, identities, history60    |
| `events`       | connection becomes an NDJSON status stream (150 ms coalesced, keep-alive) |
| `set-limits`   | reconfigure queues live (+ persist to config file)                      |

`acquire` carries call metadata, stored and surfaced verbatim: `kind` (open string:
`interactive-chat`, `set-title`, `compaction`, `subagent`, `judge`, `generate`,
`image-gen`, `call`), `description` (≤ 160 chars, e.g. `interactive-chat · turn 7 · "Fix
the deploy script"`), `session`, `sessionTitle`, `turn`, `modality`
(`text`/`image`/`embedding`/`other`), `meta` (free-form object).

**Fail-open:** when the daemon is unreachable, `acquire` degrades to an un-gated
pass-through after ~300 ms instead of blocking. Harnesses keep working; the queue is an
optimization, not a dependency.

**Unmapped models** (cloud models, anything not in a queue's `models` list) pass through
unlimited by default (`unmapped: "unlimited"`); `"reject"` is available.

## Quickstart (development)

```sh
node --test test/*.test.js            # full suite: state machine, protocol, client, dashboard DOM
node daemon/main.js --sock /tmp/tan.sock --tcp 127.0.0.1:4100 --config config.json --audit /tmp/tan-audit
# config.json:
# { "queues": [
#     { "id": "strix-apu", "limit": 1, "models": ["small-dense", "big-moe", "small-moe", "image-gen"] },
#     { "id": "r9700-egpu", "limit": 1, "models": ["medium-dense", "medium-moe"] }
#   ], "unmapped": "unlimited", "queueLimit": 1000 }

tan status                                          # live queues, leases, waiters, identities
tan acquire --model medium-dense --kind interactive-chat --desc "e2e" --hold-ms 60000
tan tail --limit 20                                 # recent audit events
open http://127.0.0.1:4100/                          # dashboard
```

## Using the client

```js
import { TanClient, withLease } from 'take-a-number/client';

const tan = new TanClient({ harness: 'dsh', instance: 'web' });
await tan.connect();

// One-shot gate: waits in line if needed, runs fn under the lease, always releases.
const result = await withLease(
  tan,
  { model: 'medium-dense', kind: 'interactive-chat', description: 'turn 7 · "Fix the deploy script"', session: 'sess_1', sessionTitle: 'Fix the deploy script', turn: 7 },
  (leaseId) => callModel(leaseId), // leaseId === null means degraded pass-through
);
```

## Admission proxy

The plugin makes queueing **opt-in per harness**: dsh queues its own calls, but anything
else that hits litellm directly (a raw curl, another agent, a benchmark) tramples the GPU
unqueued. The admission proxy closes that gap by sitting in front of litellm and making
queueing **mandatory for all traffic**, while preserving two entry postures that share one
FIFO queue:

- **Compliant clients** already reserved their turn in the daemon (they idle their own loop
  while they wait). Their request carries a static `x-tan-client: <token>` header; the proxy
  `checkout`s the matching held lease and forwards it straight through — no second acquire,
  no double-count.
- **Non-compliant clients** send a normal request. The proxy `acquire`s a lease on their
  behalf and **holds the HTTP request open** until their turn, then forwards. Standard
  "long request" concurrency; the client just sees a slow response.

The proxy is a **gate, not a transformer**: it pipes request and response bytes unmodified
(SSE token streams included) and adds one local round-trip to the daemon per request. Model
traffic is KB/s, so data-path overhead is negligible.

```sh
node proxy/main.js --upstream 127.0.0.1:4000 --listen 127.0.0.1:4140 \
  --sock /run/take-a-number/tan.sock --instance tan-proxy
```

| flag         | default                     | meaning                              |
| ------------ | --------------------------- | ------------------------------------ |
| `--upstream` | `127.0.0.1:4000`            | the litellm (OpenAI-compatible) target |
| `--listen`   | `127.0.0.1:4140`            | where the proxy accepts model traffic |
| `--sock`     | `/run/take-a-number/tan.sock` | daemon UDS                         |
| `--tcp`      | `127.0.0.1:4100`            | daemon TCP fallback                  |
| `--instance` | `tan-proxy`                 | the proxy's identity instance name   |

Behavior:

- **Model selection** — the `model` field of the (buffered, ≤ 64 MB) JSON body selects the
  queue, using the daemon's own model→queue map. Unparseable/absent model = unmapped.
- **Compliant** — `x-tan-client: <instance-name>` (+ `x-tan-claim: <token>` for dynamic
  clients) + mapped model → `checkout { model, instance, token? }`. The instance name is the
  client's **self-identity** (the name it registered with the daemon — `web`, `lab-foo`, …) —
  not a secret. How it's admitted depends on the identity's registered **capability**:
  - **static** (e.g. dsh, which can't inject a per-call header): admitted by identity alone,
    **one request per grant** — the first request claims the held lease, a second falls to the
    hard queue. A name-spoofing skew is possible (visible in the audit) but not a security hole:
    litellm is still the API-key layer.
  - **dynamic** (e.g. opencode/curl, which can present a header): the daemon mints a **one-time
    claim token** at grant (returned on `acquire`/`wait`), valid for a 30 s TTL. The client
    presents it via `x-tan-claim`; the daemon validates and **consumes** it. A missing, lapsed,
    or wrong token falls to the hard queue.
- **Grant TTL** — a granted slot not claimed within 30 s is freed back to the queue (a static
  client that never sent its request, or a dynamic client whose token lapsed). In-flight
  (checked-out) leases and unlimited leases are exempt.
- **Hard / unmapped** — `acquire` (real lease for a mapped model, unlimited lease for
  unmapped), long-poll until grant, forward, release on settle.
- **Fail-open** — daemon unreachable → forward without queueing (logged). The box's models
  stay up even if the queue brain is down.
- **Abort** — a client that goes away while queued cancels its waiter and frees the line;
  while forwarding, the upstream leg is destroyed and the lease released.
- **Watchdog** — a held lease whose response produces **no bytes for 15 min** is a hung
  generation (wedged worker, client stuck mid-stream). The proxy kills the upstream leg
  (frees the GPU), ends the client's response cleanly, and releases the lease with the
  auditable reason `watchdog`. The threshold is *no-bytes*, not *total-duration*, so a long
  generation is never touched; tune it with `--stall-ms` (0 disables).
- **`/healthz`** — 200 for healthchecks, never queued.

`release` is idempotent, so split release-ownership is safe: the proxy releases when the
forwarded request settles and a compliant client may also release its own lease — whichever
fires second is a no-op.

On local-ai-machine the proxy fronts the `models.*` Caddy hostname, so queueing is mandatory
for that traffic; loopback harnesses (dsh, opencode, the CLI) point at it directly.

### Proxy latency

The proxy adds one local daemon round-trip per request (admission) plus the HTTP hop.
`test/proxy-perf.test.js` benchmarks a tight sequential inference loop (direct vs. the
compliant reserve→checkout→release flow vs. the hard queue) on every `node --test` and asserts
the compliant overhead stays under a generous bound, so a regression is caught as it lands.
On this box the measured overhead is **~0.4 ms per call** — negligible next to a model call.

## Metrics (Prometheus)

The daemon serves `GET /metrics` on its HTTP port (`127.0.0.1:4100` by default) in the
Prometheus text exposition format, rendered by hand (no client library — the
zero-runtime-dependency constraint). It is open like the dashboard shell: it exposes
nothing the dashboard already shows, and the port is loopback-only by invariant.

- **Gauges** (from a live `snapshot()` at scrape time): `tan_up{version}`,
  `tan_uptime_seconds`, `tan_identities`, `tan_queue_depth{queue}`,
  `tan_queue_limit{queue}` (0 = unlimited), `tan_queue_active{queue}`,
  `tan_queue_longest_wait_seconds{queue}`,
  `tan_queue_longest_lease_age_seconds{queue}`, `tan_identity_leases{identity}`,
  `tan_identity_waiters{identity}`.
- **Counters** (accumulated from the event stream; reset on daemon restart — query with
  `increase()`/`rate()`): `tan_grants_total{queue,identity}`,
  `tan_releases_total{queue,reason}`, `tan_cancellations_total{queue,reason}`,
  `tan_rejections_total{queue,reason}`, `tan_identity_ups_total`. `queue` is `unmapped`
  for unmapped-model traffic; `identity` is the instance name.
- **Histograms**: `tan_wait_seconds{queue}` (time queued before a grant) and
  `tan_run_seconds{queue}` (time a held lease ran).

A minimal Prometheus scrape job:

```yaml
  - job_name: "take-a-number"
    metrics_path: "/metrics"
    static_configs:
      - targets: ["localhost:4100"]
```

## Running as a container

```sh
docker run --rm -it \
  -p 127.0.0.1:4100:4100 \
  -v /run/take-a-number:/run/take-a-number \
  -v /var/lib/take-a-number/audit:/var/lib/take-a-number/audit \
  -v /etc/take-a-number/config.json:/etc/take-a-number/config.json \
  ghcr.io/chrisjohnson/take-a-number:latest
```

The same image runs the admission proxy with a command override (it shares the daemon's
socket and audit volumes):

```sh
docker run --rm -it \
  -p 127.0.0.1:4140:4140 \
  -v /run/take-a-number:/run/take-a-number \
  ghcr.io/chrisjohnson/take-a-number:latest \
  node proxy/main.js --upstream 127.0.0.1:4000 --listen 0.0.0.0:4140
```

The daemon's defaults are the container's contract: UDS at
`/run/take-a-number/tan.sock`, TCP (protocol + HTTP + dashboard) on
`127.0.0.1:4100`, config at `/etc/take-a-number/config.json`, audit JSONL under
`/var/lib/take-a-number/audit`. The container binds loopback inside itself, so
publish the port to the host loopback (`127.0.0.1:HOSTPORT:4100`) and front it
with your own reverse proxy for external access.

- The daemon's native default binds `127.0.0.1` only (it refuses anything
  else). The container image overrides this: it binds `0.0.0.0:4100` inside
  the container with `--allow-non-loopback`, because docker port publishing
  forwards to the container's bridge IP, which a loopback bind never sees.
  The isolation is the host-side publish (`127.0.0.1:HOSTPORT:4100`) plus the
  container's network namespace.
- Run the container as the uid that owns the mounted socket/audit dirs (the
  image defaults to the `node` user; set `user:` to your own uid:gid).
- `TAN_AUTH_TOKEN` (env or `--auth-token`): when set, every `/api/*` route
  requires `?token=…` — open the dashboard as `http://host:4100/?token=…` and
  the page carries the token on all API calls. Unset = open (local dev).
- A stale UDS file from a previous run is unlinked on start and on shutdown, so
  container restarts are clean.

Images are built by CI on push to `main` (`ghcr.io/chrisjohnson/take-a-number:<sha>` plus
`:latest`), so the always-fresh image tracks the default branch.

## Deployment on local-ai-machine

The box runs the daemon as a compose container in `chrisjohnson/local-ai-machine`
(`docker/docker-compose.yml`, image pinned there), as system user `tan`, with the
queue config at `/etc/take-a-number/config.json`, audit at
`/var/lib/take-a-number/audit`, and the dashboard behind Caddy at
`https://take-a-number.local-ai-machine.johnsonlab.dev` (token-gated). The queue config maps
live LiteLLM model names to GPU queues (`strix-apu` = APU, `r9700-egpu` = eGPU);
the seed comes from `modelctl list` + LiteLLM `/model/info`. A second compose service
(`tan-proxy`, same image) runs the admission proxy on `127.0.0.1:4140` in front of
litellm. The dsh harness gates via the `dsh-take-a-number` plugin
(`chrisjohnson/dsh-plugins` → `packages/take-a-number`), pinned in `dsh-deploy`, and
carries a per-instance `x-tan-client` token so its calls take the compliant path. See
`tickets/` for the deploy plan and `PLAN.md` for the full architecture reference.

## Files

| path                 | what                                                        |
| -------------------- | ----------------------------------------------------------- |
| `daemon/lib/queues.js` | pure queue/lease/identity state machine (no I/O)           |
| `daemon/lib/protocol.js` | connection protocol, long-polls, event feed               |
| `daemon/lib/http.js`   | HTTP surface: dashboard + JSON API, optional token auth   |
| `daemon/lib/audit.js`  | append-only JSONL audit, 14-day retention                   |
| `daemon/main.js`       | entrypoint: UDS + TCP (protocol/HTTP routing), lifecycle  |
| `client/index.mjs`     | TanClient, withLease, checkout (zero deps)                  |
| `proxy/main.js`        | admission proxy HTTP entrypoint                             |
| `proxy/lib/admit.js`   | pure per-request admission decision (unit-testable)         |
| `bin/tan`              | CLI                                                         |
| `dashboard/`           | index.html, style.css, app.js (zero deps)                   |
| `test/`                | node:test suites                                            |
| `tickets/`             | the 3-ticket work plan                                      |
| `PLAN.md`              | architecture reference                                      |
