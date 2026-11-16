# take-a-number — global model-call queue and lease service

**Status:** DSH-first delivery in progress. The executable work plan is `tickets/` (three
tickets, each self-contained and workable without a human); this file is the architecture
reference they implement. Every open point has a chosen default.
**Date:** 2026-11-15
**Box:** local-ai-machine (192.168.1.21) — Strix Halo APU (gfx1151) + RX 9700 eGPU dock (gfx1201)
**Delivery order:** DSH first (mature landing zone): daemon → `dsh-take-a-number` plugin in
`dsh-plugins` → box deploy + dsh-deploy swap (removes `dsh-model-capacity`). The opencode plugin
(`plugins/opencode/`) is the next phase after the DSH path is live.

---

## 1. Summary

A small always-up daemon (**the gate**) owns one FIFO queue per GPU. Every model call from every
harness — every DSH instance (production *and* lab), every opencode session, any future harness or
machine — asks the gate for a **lease** on the GPU its model runs on, waits in that GPU's queue if
the GPU is busy, runs, and releases. Every lease is stamped with a **per-process identity**
(harness + instance + pid + host + user), so any call can be traced to exactly which process made
it. Wait times are visible in each harness, and the **dashboard is a first-class component of the
daemon itself** (§5.4) — the box-wide, always-current view of every queue, lease, and identity.

**Naming (deliberate).** Not an "LLM gateway": a *gateway* sits in the data path and proxies
inference traffic (LiteLLM is this box's gateway); this service never touches inference bytes —
it is a **queue/lease arbiter** for model calls, hence "gate". Not "LLM"-specific: Jev-class
small-MoE models are language models (LLMs, just small ones — the term fits them), but the gate
also covers the box's **image-generation** model (`image-gen` role) and any future modality, so
the name is model-neutral: **take-a-number**. Modality is a label on the lease/audit line (for
dashboard grouping), not a queue dimension — the GPU is the queue dimension.

Three components:

| Component | Lives in | What it is |
|---|---|---|
| `gate-daemon` | new repo `chrisjohnson/take-a-number` | Node 22, zero deps. UDS + TCP. Queues, leases, identities, audit log, **interactive dashboard** (served by the daemon). |
| `tan-client` | same repo, `client/` | Plain ESM, zero deps, no build. Connect/register/acquire/wait/release. Used by both plugins. |
| `dsh-take-a-number` plugin | `chrisjohnson/dsh-plugins` `packages/take-a-number` | Fork of `dsh-model-capacity`'s architecture; in-process `CapacityManager` replaced by `tan-client`. |
| `opencode-take-a-number` plugin | `chrisjohnson/take-a-number` `plugins/opencode/` | opencode 1.18 plugin; gates at the `session.http.request`/`http.response` hooks. |

Transport decision (measured, §3.1): **same JSON-line protocol over Unix domain socket (local,
default) and TCP (containers, future multi-machine).** Local RTT is ~15 µs on both; LAN adds
~0.5 ms mean. Latency is not a decision factor — transport is an operational choice, and this
design gets both.

---

## 2. Goals / non-goals

**Goals**
- Mutual exclusion (configurable N) per physical GPU across *all* harness processes and machines.
- Per-process identity on every lease and waiter; full audit trail (who called what, when, waited
  how long, ran how long).
- Queue position + elapsed wait visible in the harness (dsh: existing Activity panel + per-turn
  wait cards; opencode: TUI status line + daemon page).
- Zero bricking: gate daemon down ⇒ harnesses fail open, un-gated.
- Everything deployed through git per the box's one rule; no hand edits.

**Non-goals (Phase 1)**
- No scheduling intelligence (strict FIFO per queue; weights/priorities are Phase 2).
- No per-model sub-queue within a GPU (a GPU queue is one queue; models on the same GPU share it —
  same semantics as `dsh-model-capacity`'s provider buckets).
- No gating of non-interactive consumers (bench orchestrator, playsense, batch scripts) — they
  keep the existing accepted contention tradeoff (M-140). A `tan` CLI wrapper is Phase 2.
- No authentication on loopback (box trust posture, matches litellm/searxng/browserless).
- No state persistence across daemon restarts (in-memory, like `dsh-model-capacity`; the audit
  JSONL is the durable record).

---

## 3. Research findings

### 3.1 Transport latency (measured on this box, 2026-11-15, Node 22, 1000 iterations, ~230 B JSON request / ~90 B response)

| Path | Connect | RTT mean | p50 | p95 | p99 |
|---|---|---|---|---|---|
| Unix domain socket | 1.47 ms | **0.016 ms** | 0.012 ms | 0.019 ms | 0.116 ms |
| TCP 127.0.0.1 | 1.03 ms | **0.018 ms** | 0.016 ms | 0.026 ms | 0.058 ms |
| LAN 192.168.1.21 → 192.168.1.5 (ICMP, desktop) | — | **0.473 ms** | — | — | max 0.804 ms |

**Conclusion.** UDS and loopback TCP are statistically identical (~15 µs). The LAN is ~30× slower
than loopback but ~0.5 ms mean — 0.0017 % of a 30 s model call. The gate adds **1 RTT** per model
call on the fast path (immediate grant) and **2–3 RTTs** on the queued path (acquire + long-poll
wait + release; release is fire-and-forget and overlaps the next call). **The socket-vs-network
question has no meaningful latency answer; both are free.** Choose UDS locally (no port, no
firewall surface, no auth), keep the identical protocol on TCP for bridge containers and
multi-machine scale. This answers the open question with data: *yes, a network protocol is
affordable now; a UDS default is still the right local choice — so do both.*

### 3.2 Prior art on this box: the M-094/M-140 queue haproxies

`maxconn 1` haproxies fronting LiteLLM (:4001 strix-apu / :4002 r9700-egpu-dock) were retired in
M-140 (2026-09-03): opaque proxy-level serialization didn't deliver expected throughput, and the
memory-bandwidth-contention/OOM risk it guarded is a *known accepted tradeoff* today. This design
differs in the ways that matter:

- **Visibility:** every waiter and lease is named (identity, model, session, elapsed) — the
  haproxy was a black box.
- **Placement:** the gate is at the harness, so the *harness* knows it is waiting (status, cancel,
  per-turn wait cards) and the provider's idle timers don't start until a slot exists (exactly
  `dsh-model-capacity`'s "the wait happens before `next()` reaches the adapter" property).
- **Scope:** per-GPU queues with explicit concurrency limits, not one global pipe.
- **No proxy in the data path (v0.1–v0.2):** model traffic never touches the gate; only the
  small acquire/release control messages do. The inference stream goes straight to the model
  server as it does today.

  *Superseded in part by the admission proxy (T4, v0.3.0).* Making queueing opt-in per harness
  left a hole: any client that hits litellm directly (curl, another agent, a benchmark) tramples
  the GPU unqueued. The admission proxy (`proxy/`) closes it by fronting litellm and queueing
  **all** traffic. It is deliberately different from the retired haproxy: it is a **pure pipe**
  (bytes pass through unmodified, SSE included; it never buffers the inference stream or
  transforms the payload), it is **visible** (every hard-queued request is a named lease in the
  same audit/dashboard), and it is **fail-open** (daemon down → forward). Compliant clients still
  queue at the harness (they idle their loop); the proxy only adds the mandatory catch-all for
  everyone else via a `checkout` of their already-held lease.

### 3.3 The reference implementation: `dsh-model-capacity` (v0.4.0)

`/home/t3code/work/dsh-plugins/packages/model-capacity` — the behavior Chris wants, in-process:

- `src/semaphore.mjs` — `CapacityManager`: one bucket per provider (active lease set + FIFO
  waiter array), `acquire` (fast path when free and no waiters, else enqueue; bounded by
  `queueLimitPerProvider`), `release`/`drain`, `cancelWaiter`, `forceRelease`, `snapshot`. No
  timers. `waitedMs` recorded per lease.
- `src/gate.mjs` — `ctx.on('llm/stream', (options, next) => gatedStream(...), {global: true,
  prepend: true})`: *every* model call (interactive, subagent, judge, title, compaction) passes
  the same gate; lease released in `finally` on end/fail/abort.
- `src/host.mjs` — Cordis `Service`: config watch, provider catalog, HTTP routes
  (`/api/modelCapacity/{snapshot,stream,sessionWaits,cancelSession,cancelWaiter,forceRelease,setLimits}`),
  NDJSON push feed (150 ms coalescing, idle suppression), per-turn wait history rendered as a
  client-only `conversation.chat.turnTail` card ("Waited for capacity 24s — never written to the
  session log or model context"), token-rate metering.
- `src/config.mjs` — strict config validation; unknown keys warn, invalid limits refuse.
- `src/client.mjs` — React panel: Activity page (KPIs, per-provider cards, live session cards,
  throughput graphs), sidebar pills, composer dock with Cancel, Force release.

**What changes for `dsh-take-a-number`:** the `CapacityManager` is deleted; `tan-client` is the
semaphore. Everything else (gate placement, config shape, panel, wait cards) carries over, and the
panel becomes *better*: it now shows leases from other harnesses (opencode, lab) because the state
is central. The in-process gate is the thing that could never see across instances — production
dsh and a lab instance each had their own semaphore, which is exactly the hole this project fills.

### 3.4 opencode 1.18.34 plugin surface (verified against `anomalyco/opencode` `dev` source)

- Plugin API: `define({ id, setup(ctx) })`; promise-based domains (`ctx.aisdk`, `ctx.session`,
  `ctx.event`, `ctx.tool`, …). TUI plugins are a separate entry (`cli.json` `plugins`) with
  `@opentui/solid` JSX + durable `storage.store()`. Desktop plugins export `./gui-experimental`.
- **The interception point** — `packages/core/src/session/model-request.ts` builds *every* model
  request (kinds: `primary | compaction | title | generate`) and, when `http.request`/`http.response`
  hooks are registered, wraps the transport:
  - `session.hook('http.request', cb)` — async, fires **before** the HTTP request is sent, event
    carries `{sessionID, agent, model, kind, request}`. Awaiting inside the hook delays the
    request — this is the queue point.
  - `session.hook('http.response', cb)` — fires when the response arrives, event carries
    `{sessionID, agent, model, kind, request, response}`; the hook's returned `response` is the
    one used — so the body stream can be wrapped to release the lease when the stream ends,
    errors, or is cancelled.
  - The comment in `model-request.ts` confirms scope: "HTTP hooks wrap every HTTP request,
    including the WebSocket fallback path. The route decides which transport actually carries the
    request, so both hook families are always offered." For AI-SDK providers (how LiteLLM's
    openai-compatible models run in opencode) the middleware is injected into the provider's
    `fetch` via `AsyncLocalStorage` (`packages/core/src/aisdk.ts` `prepareOptions` →
    `throughMiddleware`), so AI-SDK and native providers are both covered.
  - `session.hook('retry', cb)` — fires on failed attempts; used to reap the dangling lease of a
    failed request (see §8.4 leak paths).
- **Rejected alternative:** wrapping `LanguageModelV3` via `ctx.aisdk.hook('language', …)`. It is
  a real choke point (the language model is cached per model-config and every `doStream` flows
  through it), but it has **no per-call context** — no `sessionID`, no `kind` (the language model
  is shared across sessions and request kinds) — so leases could not be attributed to sessions.
  The `http.request` hook has the full scope and covers native providers too.
- **Chat-log injection:** `ctx.session.synthetic` admits a message into the session inbox with
  `delivery: "steer"` — i.e. *into the model's context*. Injecting queue-wait text there would
  perturb every subsequent turn. Rejected. opencode has no dsh-style client-only `turnTail` slot.
  The opencode visibility surface is therefore: TUI status line (TUI plugin), the daemon's web
  page, and the daemon's audit trail. This is a deliberate, documented scope difference from dsh.

### 3.5 Deployment pattern on the box

- dsh runs as a **native systemd service** (`systemd.services.dsh` in `local-ai-machine/
  configuration.nix`): dedicated user `dsh`, checkout at `/home/dsh/dsh-deploy`,
  `ExecStart=… node … bin.js`, `Restart=always`, `RestartSec=10` (the comment documents a real
  9.5 h outage that `on-failure` would not have restarted — copy `always`).
- Lab instances are a second dsh process (`scripts/lab.sh`, port 3099+, own `DSH_HOME`) — a
  separate identity, same queues.
- opencode runs under the T3 Code server as user `t3code` (user-level service via `t3 service
  install`); its config is git-owned by the `t3code-deploy` repo (knowledge
  `2026-11-11-opencode-config-owned-by-t3code-deploy.md`).
- Port conventions: 3000-series browser UIs, 4000 litellm, 8000–8012 vLLM, 8100–8199 llama.cpp,
  8091/8092 searxng/bench, 11434 ollama, 3100 browserless, 3773 t3. **4100 is free** and in the
  litellm-adjacent range — chosen for the gate's TCP listener.
- UDS convention: `/run/<service>/…` with tmpfiles rules.

---

## 4. Architecture

```
                        ┌────────────────────────────────────────────┐
                        │  gate-daemon  (systemd: take-a-number, user tan)│
                        │  UDS /run/take-a-number/tan.sock  (local, 0666) │
                        │  TCP 127.0.0.1:4100 (containers; LAN later)│
                        │                                            │
                        │  queues:  strix-apu [1]  r9700-egpu [1]    │
                        │  identities: per-connection                │
                        │  audit: /var/lib/take-a-number/audit/*.jsonl    │
                        │  dashboard: GET /  (interactive, §5.4)    │
                        └──────────────▲──────────────▲──────────────┘
                                       │ control only (JSON lines)
            ┌──────────────────────────┼──────────────────────────┐
            │                          │                          │
   ┌────────┴────────┐        ┌────────┴────────┐        ┌────────┴────────┐
   │ dsh (prod, web) │        │ dsh (lab :3099) │        │ opencode (t3code)│
   │ dsh-take-a-number  │        │ dsh-take-a-number  │        │ opencode-model-  │
   │ ctx.on(llm/     │        │ (same plugin)   │        │ gate: session.   │
   │   stream) gate  │        │                 │        │ http req/resp    │
   └────────┬────────┘        └────────┬────────┘        │ hooks            │
            │ inference (untouched)    │                 └────────┬─────────┘
            ▼                          ▼                          ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ LiteLLM :4000 → model builds (vLLM 8000s / llama.cpp 8100s / ollama) │
   │   strix-apu GPU                r9700-egpu GPU                        │
   └─────────────────────────────────────────────────────────────────────┘
```

Data path (inference) is untouched; only small control messages (register/acquire/wait/release,
tens of bytes) cross the gate.

---

## 5. gate-daemon

### 5.1 Process and files

- Node ≥ 22 (box has 22.x in `/run/current-system/sw/bin/node`), **zero npm dependencies**
  (`node:net`, `node:fs`, `node:crypto`, `node:http` only). Single file `daemon/main.js` +
  `daemon/lib/*.js` (queues, protocol, audit, web) + `daemon/test/*.test.mjs` (`node --test`).
- Runs as system user `gate` (new, `NixOS` `users.users.tan`, system account), checkout at
  `/home/tan/take-a-number` (git, pulled by an activation step — see §10), `Restart=always`,
  `RestartSec=10`, `After=network.target`.
- State: in-memory. Durable: audit JSONL at `/var/lib/take-a-number/audit/` (tmpfiles-created,
  `tan:tan 0750`), one file per UTC day, 14 days retained (daemon prunes at startup).
- Socket dir `/run/take-a-number` (tmpfiles `d /run/take-a-number 0755 gate gate -`), socket mode `0666`
  (box trust posture: every local user is a first-class harness host).

### 5.2 Protocol

Newline-delimited JSON over UDS or TCP. Request `{ "id": <client-chosen string>, "type": …, … }`;
response `{ "id": <same>, "ok": true, … }` or `{ "id": …, "ok": false, "error": { "code", "message" } }`.
Server push only on an explicit `events` subscription (NDJSON stream, 150 ms coalescing, same
discipline as `dsh-model-capacity`'s feed).

| type | payload | response |
|---|---|---|
| `register` | `{harness, instance, pid, host, user, version}` | `{identityId}` |
| `acquire` | `{identityId, model, provider?, kind?, session?, turn?, modality?, note?}` (`modality` ∈ `text\|image\|embedding\|other`, client hint, default `text` — a dashboard label, never a queue dimension) | `{status:"granted", leaseId, queue}` **or** `{status:"queued", waiterId, queue, position, active, limit}` |
| `wait` | `{identityId, waiterId, timeoutMs ≤ 25000}` | `{status:"granted", leaseId, queue, waitedMs}` **or** `{status:"still-queued", position, active, limit}` **or** `{status:"cancelled"}` |
| `release` | `{identityId, leaseId}` | `{released: true\|false}` (idempotent) |
| `cancel` | `{identityId, waiterId}` | `{cancelled: true\|false}` |
| `force-release` | `{leaseId}` (operator; also from the dashboard) | `{released: …}` — audited |
| `status` | `{}` | full snapshot (§5.5) |
| `events` | `{}` | long-lived NDJSON: `queued/granted/released/cancelled/force-release/identity-up/identity-down/config` frames, coalesced ≤ 1/150 ms, 15 s keep-alive when idle |
| `set-limits` | `{queues: [{id, limit}], queueLimit?}` | new snapshot — audited |

Long-poll `wait` (not server push) is the deliberate choice: it is stateless from the client's
view, re-issuable after any network hiccup, and works identically over UDS and TCP. A client that
drops its connection while queued **loses its position and re-queues** (no reattach — simpler and
honest; positions are cheap).

**Identity lifetime = connection lifetime.** One identity per connection, assigned at `register`
(the first request on a connection must be `register`; anything else closes the connection). When
the socket closes — process crash, kill, daemon-side restart — the daemon immediately: releases
every lease of that identity, cancels every waiter of that identity, emits `identity-down`, and
audits it. This is the crash-recovery mechanism; there are **no TTL timers** (same semantics as
`dsh-model-capacity`: no clock-based expiry, operator `force-release` is the escape for a hung
live process).

### 5.3 Queues and config

`/etc/take-a-number/config.json` (git-managed via the local-ai-machine repo, `environment.etc`):

```json
{
  "queues": [
    { "id": "strix-apu",   "limit": 1, "models": [ "medium-dense", "small-dense" ] },
    { "id": "r9700-egpu",  "limit": 1, "models": [ "medium-moe", "big-moe", "small-moe", "image-gen" ] }
  ],
  "unmapped": "unlimited",
  "queueLimit": 1000
}
```

- `models` are the **LiteLLM model names** (the names harnesses request: `medium-dense`,
  `coder`, `judge`, …). A `provider` hint from the client is a secondary match key; the model
  name is primary because that is what every harness knows.
- `unmapped: "unlimited"` — a model not in any queue passes through with a synthetic unlimited
  lease (recorded, not gated). A new model therefore can never brick a harness. (Default chosen;
  `unmapped: "reject"` exists for the paranoid and is a one-word config change.)
- Role aliases (`coder`, `judge`) resolve to the same queue as the build they currently point at:
  the daemon config lists aliases explicitly next to their concrete models. **Implementation
  step (no human input):** seed the initial `models` lists by reading the live role table —
  `curl -s http://127.0.0.1:4000/v1/models` plus the current role→build mapping from
  `strix-halo-r9700-llm-builds` build compose files (the same source `scripts/set-role.sh`
  reads) — and commit the resulting config. If a role is mid-swap, the alias's queue is the
  *destination* build's GPU (the alias is about to point there).
- `set-limits` rewrites `limit` values at runtime (and is persisted back to the config file by the
  daemon, so a restart doesn't revert an operator change — the file is git-tracked; the daemon
  writes it and the drift shows in git, same pattern as dsh rewriting `cordis.patch.yml`).
- **Phase 2:** auto-discovery — the daemon re-derives the model→queue map from the build catalog
  on `SIGHUP`, making role swaps self-updating.

### 5.4 Dashboard — a first-class component of the daemon

**The dashboard lives in the server, not in any client.** The daemon is the single source of
truth for all queue/lease/identity state; the dashboard is a product surface of that daemon, the
way the bench orchestrator's web queue is a surface of the orchestrator. Consequences:

- One implementation, maintained in one repo, always current with the daemon's state — no
  client can drift into showing a stale or partial view.
- Every consumer reads the *same* data: humans in a browser, the dsh Activity panel (thin client
  of `status`/`events`), the opencode TUI line, the `tan` CLI. The dsh panel stays a native
  in-harness widget (not an iframe of this page) — the dashboard is the **box-level** view, the
  panel is the **session-level** view.
- It survives any harness: kill every dsh instance and the dashboard still shows opencode's
  leases; the reverse is true too. No in-process UI can do that.

**Served by the daemon** at `GET 127.0.0.1:4100/` (root path; `/api/*` for the JSON the page
uses). Same loopback-no-auth posture as the rest of the box's local UIs; reachable off-box only
through the existing Caddy/SSH-tunnel paths.

**Design direction.** The target is a *pretty, visual, interactive* dashboard in the family of
modern inference-gateway dashboards (the NVIDIA LLM Gateway product UI is the reference point:
dark theme, per-model/per-GPU card tiles, live throughput charts, request/queue tables) fused
with the visual language of the existing `dsh-model-capacity` Activity page that this project
generalizes (KPI cards, per-queue capacity bars, color states — green = free, yellow = at
capacity, red = queued — live session/lease cards, 60 s rate graphs, animated handovers). The
gate's data maps onto that language directly: GPU ↔ provider card, lease ↔ session card,
identity ↔ the card's title line.

**Phase 1 — the model-activity UI, server-side, as is.** Port the model-capacity Activity page
to the daemon verbatim in layout and behavior: header with live enforcing status, KPI cards
(active / queued), one color-accented card per GPU queue with its capacity bar, each active lease
a card (identity `harness/instance#pid@host`, model, kind, session, elapsed — active cards
breathe), each waiter a row (identity, model, position, waited), per-queue 60 s busy-rate graph
(lease-seconds, the only rate the gate truly knows — output tokens are invisible to it),
FLIP-animated list handovers, `prefers-reduced-motion` respected. Live updates over the
`events` NDJSON stream (150 ms coalescing, 15 s keep-alive, polling fallback every 2 s if the
stream can't be held). Implementation stays zero-dependency: the `dashboard/` static files
(`index.html` + `app.js` + `style.css`, ~1.5–2 klines) — the animation and card language port
fine in vanilla JS.

**Phase 2 — the polished interactive dashboard** (same page, grown):

- **Identity table** — every connected harness process (harness, instance, host, pid, connected
  since, live leases, live waiters, cumulative waited/ran time from the audit), filterable.
- **Audit explorer** — the JSONL made browsable: filter by identity / queue / model / modality /
  time range, aggregate views (total waited per identity per day, longest waits, force-release
  history), raw-line view. This is where "which call came from which identity" gets answered
  visually.
- **Interactive operations** — click any lease/waiter card → detail drawer with its full event
  history; **Cancel** a waiter, **Force release** a lease (confirmed, audited), **Adjust limit**
  per queue (writes through `set-limits`, persisted to the config file).
- **Per-queue history charts** — busy fraction over 1 h / 24 h from audit aggregates; per-modality
  breakdown (text vs image calls) on each GPU card.
- **Dark theme by default**, light via `prefers-color-scheme`; responsive down to phone width
  (the box is a laptop; the dashboard will be looked at in a tunnel).
- If vanilla JS stops being enough for the chart/animation work, the fallback is a single
  prebuilt bundle committed to the repo (no build step at deploy time) — the default is to stay
  dependency-free.

### 5.5 `status` snapshot shape

```json
{
  "asOf": 1763…, "uptimeSec": 812, "version": "0.1.0",
  "queues": [{
    "id": "strix-apu", "limit": 1, "unlimited": false,
    "active": [{ "leaseId", "identityId", "identity": "dsh/web#1234@local-ai-machine",
                 "model", "kind", "session", "startedAt", "elapsedMs", "waitedMs" }],
    "waiters": [{ "waiterId", "identityId", "identity", "model", "position", "enqueuedAt", "waitedMs" }]
  }],
  "identities": [{ "identityId", "harness", "instance", "pid", "host", "user", "connectedAt", "leases": 1, "waiters": 0 }],
  "totals": { "active": 2, "waiting": 1 }
}
```

### 5.6 Audit log

Append-only JSONL, one line per event: `register`, `identity-down`, `queued`, `granted`,
`released`, `cancelled`, `force-release`, `config`. Each line: `{at, event, queue?, identity?,
model?, kind?, modality?, session?, leaseId?, waitedMs?, runMs?, note?}`. `runMs` is filled on
`released` (grant→release delta). This is the traceability deliverable: any call, any identity,
any wait, queryable with `jq` after the fact. 14-day retention. The daemon also serves the audit
over HTTP for the dashboard's audit explorer: `GET /api/audit?identity=&queue=&model=&modality=
&from=&to=&limit=` → `{lines: […], total, truncated}` (read-only, paged, newest-first).

### 5.7 Failure semantics (daemon side)

| Event | Behavior |
|---|---|
| Daemon restart | All connections drop ⇒ every client sees a disconnect, re-registers. Queued callers re-queue (lose position). In-flight model calls keep streaming — the daemon never owned the data path; their releases become no-ops. Audit records the gap. |
| Client crash / kill | Connection close ⇒ leases released, waiters cancelled, audited. GPU freed immediately. |
| Hung live client (stream stalled) | Lease held (correct: we cannot know the GPU is free). Escape: `force-release` from the dashboard / `tan` CLI / dsh panel, audited. Phase 2 adds an evidence-based watchdog (no chunks for 5 min ⇒ force-release + audit flag). |
| Config file invalid on startup | Daemon refuses to start (loud journal line) — systemd `Restart=always` keeps retrying the last-good binary with the broken config; operator fixes the file. (Deliberate: a half-applied queue config is worse than a down gate, and clients fail open while it's down.) |
| Audit disk full | Daemon logs and continues serving (audit is best-effort after the first write failure of a day). |

---

## 6. tan-client (shared library)

`client/index.mjs` — plain ESM, zero deps, importable from dsh plugins and opencode plugins alike.

```js
import { Gate } from 'tan-client'
const gate = new Gate({
  harness: 'dsh',            // identity
  instance: 'web',           // identity (profile / instance name)
  sock: process.env.TAN_SOCK ?? '/run/take-a-number/tan.sock',
  url:  process.env.TAN_URL  ?? 'http://127.0.0.1:4100',
})
await gate.start()                       // connect (UDS first, TCP fallback), register, auto-reconnect
const lease = await gate.acquire({       // fast path 1 RTT; queued path long-polls internally
  model: 'medium-dense', kind: 'call', session: 'ses_…', turn: 7,
  signal: abortSignal,
})
// … run the model …
lease.release()                          // idempotent, fire-and-forget
```

Behavior contract:

- **Transport:** UDS first; if the socket file is absent/unconnectable, TCP to `url`. On
  reconnect, transport preference is re-evaluated (a daemon restart may leave a stale socket
  file — connect failure on UDS falls through to TCP).
- **Identity:** `pid`/`host`/`user` read from `process`/`os`; `harness`/`instance` from
  constructor. Re-registered on every reconnect (new identityId — old one is dead to the daemon).
- **Acquire:** `acquire` → if `granted`, return lease. If `queued`, loop `wait` with 25 s
  long-polls until granted. `signal` abort ⇒ `cancel` the waiter, reject with `GateAbortedError`.
  `waitedMs` is carried on the lease (daemon-computed, authoritative).
- **Fail-open:** if the daemon is unreachable (connect refused on both transports) the client
  enters `degraded` after 2 attempts (~300 ms) and returns **un-gated leases** (no queueing, no
  rejection) while retrying the connection in the background (1 s, 2 s, 5 s, … 30 s cap).
  `gate.status` exposes `{mode: 'live' | 'degraded', since}`. A model call is never blocked by a
  dead gate. (Chosen default; fail-closed would make every harness on the box unusable during a
  daemon hiccup — wrong for a dev box.)
- **Release on dropped connection:** a lease whose connection dies mid-call is unreleasable; the
  client marks it `orphaned` (no-op release). The daemon already reclaims it via
  connection-liveness, so nothing leaks on the daemon side.
- **Telemetry hook:** `gate.onEvent(cb)` — the client surfaces `queued/granted/released/degraded`
  events so plugins can render waits (dsh turn cards) without polling.
- **No timers in the normal path.** The only timer is the reconnect backoff.

Tests: `node --test` with an in-process fake daemon (real UDS + real TCP): FIFO order across
identities, abort ⇒ cancel, reconnect after daemon death, fail-open after both transports die,
long-poll timeout loop, idempotent release.

---

## 7. dsh plugin: `dsh-take-a-number` (in `chrisjohnson/dsh-plugins`, `packages/take-a-number`)

Same release mechanics as its siblings (git tag `dsh-take-a-number-vX.Y.Z`, `dsh.bundle.patch`,
peer ranges, `scripts/verify.mjs` contract, plain ESM, no build).

**What carries over from `dsh-model-capacity` (v0.4.0):**
- Gate placement: `ctx.on('llm/stream', (options, next) => gatedStream(…), { global: true, prepend: true })`
  — every call in the process (interactive, subagent children, judges, titles, compaction) queues;
  the wait happens before `next()`, so provider idle timers start only at grant.
- `gatedStream` shape: acquire → `yield* next()` → release in `finally` (abort/error included).
- Config shape: `enabled`, `defaultQueue: "strix-apu"`, `limits: [{provider, queue, maxConcurrent?}]`
  (the provider→queue map for *this dsh instance's* providers), `queueLimit` (passed to the daemon
  at register as a hint; the daemon's value wins), `enabled: false` = inert gate, panel stays.
- The panel: Activity page, sidebar pills, composer dock with position/elapsed/Cancel turn,
  per-turn wait cards (`conversation.chat.turnTail`, client-only, 250 ms threshold) — **now fed
  by the daemon's `status`/`events`**, so the panel shows *the whole box*: dsh prod, dsh lab,
  and opencode all in the same queue view, each lease named by identity. The old in-process-only
  card data (session title, workspace) is enriched locally as before; foreign identities show
  `harness/instance#pid@host`.
- Controls: Cancel turn (aborts the waiter), Cancel a queued call, Force release (daemon RPC,
  confirmed, audited).

**What changes:**
- `src/semaphore.mjs` is deleted. The `CapacityManager` import sites become `tan-client` calls.
  The `#tap` rate metering stays local (it meters stream chunks, which the daemon never sees).
- Identity: `harness: 'dsh'`, `instance: <profile name>` (prod `web`; lab instances derive
  `lab-<name>` from `DSH_HOME` being under a lab root), `pid`, `host`, `user` from the process.
- **Coexistence guard:** at boot, if the legacy `dsh-model-capacity` row is also mounted in the
  same profile, log a loud error and refuse to gate (two gates = double queueing). The dsh-deploy
  swap (§10.3) removes the old row in the same commit, so this is belt-and-braces.
- Degraded mode: the dock/panel show a red `gate offline — passing through` state (the fail-open
  contract made visible).

Tests: the model-capacity test suite, re-pointed at a stubbed `Gate` (FIFO admission, abort,
force-release, queue bound, gate tap, subagent arrival order — all preserved) plus new:
coexistence guard, degraded-mode pass-through, identity fields.

---

## 8. opencode plugin: `opencode-take-a-number` (in `chrisjohnson/take-a-number`, `plugins/opencode/`)

> **Rewritten for opencode 1.18.34 (v0.5.0).** The original design assumed
> `ctx.session.hook('http.request' | 'http.response', …)` — **those hooks do not exist in
> 1.18.34.** The real `Hooks` interface has no `http.*` hooks and no response hook, so a plugin
> cannot wrap the response body. The design below is the as-built one (see ticket 005).

Plain JS, zero runtime deps. Module shape (verified against `@opencode-ai/plugin@1.18.34`
`index.d.ts`): default export `{ id, server }` where `server = (input, options) =>
Promise<Hooks>`; path plugins must export `id`. Config key is `plugin: [spec, options]` tuples.

### 8.1 The gate — `chat.headers` only

The single hook:

```ts
"chat.headers"?: (
  input:  { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
  output: { headers: Record<string, string> },
) => Promise<void>;
```

It is async, so the plugin **awaits the grant inside the hook** before returning:

```js
'chat.headers': async (hookInput, output) => {
  const headers = await gate({ model: hookInput.model.id, sessionID: hookInput.sessionID, agent: hookInput.agent })
  output.headers = { ...output.headers, ...headers }   // {} = pass through
}
```

`gate` (pure, in `gate.mjs`, unit-testable with a fake client):

1. Model absent from the plugin's `queues` mirror → `{}` (no daemon round-trip).
2. `acquire({ model, kind: 'opencode', session, description })`:
   - `degraded` → `{}` (fail-open).
   - `unlimited` (stale map) → release the synthetic lease at once + `{}`.
   - `granted` → `{ 'x-tan-client': instance, 'x-tan-claim': claimToken }`.
   - `queued` → `waitFor` loop, bounded by `acquireTimeoutMs` (default 10 min); on expiry
     `cancel(waiterId)` + `{}` (the call then hard-queues at the proxy — still gated,
     unattributed).
3. A grant without a claim token → `{}` (never half-identify).
4. Any fault → `{}`. The plugin **never releases a grant**: the admission proxy checks the
   lease out via the claim token and **releases it when the forwarded response completes or
   aborts** (proxy-owned, exactly the dsh model). The one leak path — a granted lease whose
   request never reaches the proxy — is bounded by the daemon's 30 s grant-TTL sweep.

### 8.2 Abort (known limitation)

`chat.headers` input carries **no abort signal**, so the plugin cannot cancel its in-flight
`acquire` when the user interrupts. Mitigations, in order: bounded acquire timeout; the proxy's
abort handling for in-flight requests; the grant-TTL sweep for abandoned grants; and
invariant 1 (process death ⇒ `identityDown` ⇒ waiters cancelled, leases released) for a hard
kill. Accepted and documented; not over-engineered.

### 8.3 Attribution

`session` (the opencode `sessionID`), `kind: 'opencode'`, and `description: 'opencode ·
<agent>'` ride on the lease (invariant 7: stored, echoed in `status`, audited verbatim). The
instance name is per-process config (e.g. `opencode`, `lab-opencode`); the **claim token**, not
the instance name, disambiguates concurrent calls from the same process.

### 8.4 Visibility in opencode

- **Daemon dashboard + audit:** the full cross-harness view and history (§5.4, §5.6).
- **TUI status line: out of scope** (the dashboard already shows opencode's leases and waits).
- **Chat-log injection: deliberately not done** (synthetic messages would enter model context;
  opencode offers no client-only turn annotation slot).

### 8.5 Tests

`node --test plugins/opencode/test/*.test.js`:

- `gate.test.js` — pure unit tests against a fake client: unmapped pass-through, immediate
  grant headers, queued→granted token, still-queued ticks, bounded-timeout cancel, degraded,
  unlimited→release, null-token defense, acquire-refusal fail-open, cancelled waiter.
- `integration.test.js` — gate against a real UDS daemon: acquire → claim token → proxy-style
  `checkout` (one-time token), queueing behind a held slot, grant-TTL sweep of an unclaimed
  grant.

Lab rounds (ticket 005, Phase 1): standalone opencode on `big-moe` through the live proxy —
fail-open, single admit, queueing behind a hold with whole-generation slot hold,
one-token-per-grant, abort-while-queued, concurrent overlap, cross-harness FIFO, stale-grant
sweep.

---

## 9. Identity and traceability (the requirement, end to end)

1. Each harness **process** registers one identity per connection:
   `{harness: dsh|opencode|…, instance, pid, host, user}` → `identityId`.
2. Every `acquire` names its identity; every lease and waiter in `status` renders
   `harness/instance#pid@host`.
3. The audit JSONL records the full lifecycle per call: `queued → granted → released` with
   `waitedMs`/`runMs`, plus identity up/down events.
4. Queries the system answers: *Who is running on the eGPU right now?* (dashboard / `status`).
   *What was dsh-lab doing to the APU at 14:32?* (audit `jq`). *How long did opencode session
   X wait in total today?* (audit sum by identity+session). *Which process leaked a lease?*
   (`identity-down` audit lines).

---

## 10. Deployment (all through git; no hand edits)

### 10.1 New repo `github.com/chrisjohnson/take-a-number`

```
take-a-number/
├── AGENTS.md                  # deploy rules, port/socket conventions, hard stops
├── README.md
├── daemon/
│   ├── main.js  lib/{queues,protocol,audit,http}.js
│   └── test/*.test.mjs
├── dashboard/                 # first-class server component (§5.4): static, zero-dep
│   ├── index.html  app.js  style.css    # served by the daemon at GET /
│   └── test/*.test.mjs                    # DOM-level tests (node, no browser needed)
├── client/
│   ├── index.mjs  package.json (name: tan-client)  test/*.test.mjs
├── plugins/opencode/
│   ├── index.mjs  cli.mjs (TUI)  package.json  README.md  test/*.test.mjs
└── bin/tan                     # tiny CLI: status / release / cancel / tail (uses client)
```

CI: GitHub Actions running `node --test` for daemon, client, plugin (node 22). Direct pushes to
`main` (Chris's standing authorization pattern for these repos). Tags `vX.Y.Z` for the client
consumed by the plugins.

### 10.2 `local-ai-machine` repo (one PR → main → `deploy.sh`)

- `users.users.tan` — system user, no home shell login needed (`shell = /usr/sbin/nologin` is
  *not* right — the activation step pulls git as `tan`; use `shell = pkgs.bash`, `createHome =
  true`, no sudo).
- `systemd.services.take-a-number` — pattern-copied from `dsh.service`:
  `User=tan`, `WorkingDirectory=/home/tan/take-a-number`,
  `ExecStart=/run/current-system/sw/bin/node /home/tan/take-a-number/daemon/main.js --sock /run/take-a-number/tan.sock --tcp 127.0.0.1:4100 --config /etc/take-a-number/config.json --audit /var/lib/take-a-number/audit`,
  `Restart=always`, `RestartSec=10`, `After=network.target`.
- `systemd.tmpfiles.rules` — `d /run/take-a-number 0755 gate gate -`,
  `d /var/lib/take-a-number/audit 0750 gate gate -`.
- `environment.etc."take-a-number/config.json".source` — the queue config from the repo
  (`etc/take-a-number/config.json`), seeded per §5.3's implementation step.
- `systemd.services.take-a-number-checkout` (oneshot, `User=tan`) — `git pull --ff-only` in
  `/home/tan/take-a-number` before the service starts (same shape as the dsh deploy pattern; the
  checkout is created by an activation script on first switch, `git clone` from github with the
  box's existing GitHub auth).
- Firewall: nothing new (loopback bind only; 4100 is not added to `allowedTCPPorts`).

### 10.3 `dsh-deploy` repo (one PR → main → pull on box + planned restart window)

- `package.json` (root **and** `.dsh/profiles/web/`): add
  `"dsh-take-a-number": "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-take-a-number-v0.1.0&path:/packages/take-a-number"`.
- `.dsh/profiles/web/cordis.patch.yml`: remove the `model-capacity` row; add a `take-a-number` row
  with `config: { enabled: true, limits: [{provider: <this box's local provider id>, queue: …}] }`
  (provider id read from the live profile at implementation time — `dsh --dump-config`).
- `pnpm install` in **both** trees (the root-only-install trap is documented in dsh-deploy's
  AGENTS.md), `pnpm run check`.
- **The one policy-mandated pause:** restarting `dsh.service` ends all its live sessions
  (dsh-deploy's own rule: say so, let Chris pick the window). The plan is complete without it;
  the swap takes effect at the next planned restart. Until then, production dsh keeps running on
  `model-capacity` (in-process) — the coexistence guard means the two never double-gate, because
  the new plugin isn't mounted until the restart with the new config.

### 10.4 `t3code-deploy` repo (opencode plugin registration)

- Add the plugin to opencode's global config (the t3code-owned `opencode.json` flow,
  `commit-settings.sh`): `plugins: ["…git spec for take-a-number plugins/opencode…"]` + `cli.json`
  entry for the TUI status line. Config is loaded at opencode start — new T3 sessions pick it up
  at next server restart (`systemctl --user restart t3code` as t3code; the hard-stop list says
  restart the T3 service only after committing/pushing — this step *is* after).

### 10.5 Rollout order (each step verifiable before the next)

1. **take-a-number repo** — implement daemon + client + `tan` CLI; CI green; local run by hand
   (`node daemon/main.js …` in a terminal), exercise with the `tan` CLI: two terminals, one
   queue, watch FIFO + audit lines.
2. **local-ai-machine PR** — unit + tmpfiles + config; `deploy.sh`; verify:
   `systemctl status take-a-number`, `gate status` over UDS as `t3code`, dashboard at
   `127.0.0.1:4100/` (model-activity layout, live updates), daemon survives `systemctl restart`
   with clients reconnecting.
3. **dsh-plugins + dsh-deploy PRs** — release `dsh-take-a-number-v0.1.0`; lab-first:
   `scripts/lab.sh up && link take-a-number`, point the lab at the live daemon, verify the lab's
   calls queue behind a manual `tan` CLI hold; then the dsh-deploy pin + config swap; restart in
   the planned window; verify production dsh's Activity panel shows the daemon's queues.
4. **t3code-deploy PR** — opencode plugin live; **the money test:** start a dsh lab session and
   a T3/opencode session on the same model; both must serialize on the same queue, each showing
   the other's identity in its UI, audit logging both.
5. **Docs** — `knowledge/` entries in local-ai-machine (decision: gate architecture +
   transport-measurement research file, per that repo's format), READMEs in take-a-number.

---

## 11. Testing plan (acceptance criteria)

| # | Test | Pass when |
|---|---|---|
| 1 | Daemon FIFO, multi-identity | 3 fake clients, limit-1 queue: grants strictly in arrival order across identities; `position` correct; `queueLimit` rejects at bound |
| 2 | Crash reclamation | Kill a client mid-lease: daemon releases its lease within one event loop, waiter cancelled, `identity-down` audited |
| 3 | Daemon restart | Clients auto-reconnect + re-register; queued caller re-queues; in-flight stream unaffected |
| 4 | Fail-open | Stop daemon: client degrades in < 1 s, model calls pass through un-gated, no error to the harness; restart daemon: client recovers, `mode: live` |
| 5 | Long-poll | Granted while waiting: exactly one `granted` frame, `waitedMs` ≈ elapsed; timeout: `still-queued` and loop continues |
| 6 | dsh gate | model-capacity's suite (adapted) green against stubbed gate; lab smoke module green |
| 7 | opencode wrap | Release fires exactly once on close/cancel/error; no release without a grant; unmapped model bypasses |
| 8 | **Cross-harness** | dsh lab + opencode + `tan` CLI all on one queue: strict global FIFO, every lease in the dashboard named by the right identity, audit shows the full interleaving with waits |
| 9 | Perf overhead | 1000 gated no-op acquires: < 50 ms total added (measured RTT × 2 ⇒ expect ~30 ms worst case incl. long-poll setup) — i.e. < 0.2 % of a 30 s call |
| 10 | Deploy hygiene | `deploy.sh` ends `VERIFY OK`; no firewall rule added; `tan` CLI works as `t3code`, `dsh`, and from a `br-localai` container over TCP |

---

## 12. Failure-mode table (system view)

| Failure | Effect | Recovery |
|---|---|---|
| Gate daemon down | All harnesses fail open (un-gated) after ~300 ms; panels show offline | systemd `Restart=always`; clients auto-reconnect |
| Harness process crash | Its leases released, waiters cancelled by the daemon | None needed |
| Harness hangs mid-stream | Lease held (GPU may be busy — correct) | `force-release` (dashboard / CLI / dsh panel), audited |
| Gate TCP port busy at boot | Daemon logs, exits, systemd retries | First-boot port collision only (4100 verified free) |
| Config drift (role swap) | A model briefly queues on the wrong GPU's queue (still serialized — no correctness loss, minor fairness) | Re-seed config (§5.3); Phase 2 auto-discovery |
| Both gates mounted in one dsh profile | New plugin refuses to gate, loud log | Unmount legacy row (same PR does this) |
| Audit disk full | Serving continues; audit degrades | Prune (14-day retention is automatic) |

---

## 13. Phase 2 (after rollout, each independently shippable)

1. **Dashboard polish pass** (§5.4 Phase 2) — the pretty/visual/interactive treatment: identity
   table, audit explorer, interactive operations, history charts, dark theme.
2. **Prometheus `/metrics`** on the daemon (queue depth, active leases, wait-time histogram,
   per-identity call counts) + scrape target + Grafana dashboard JSON in local-ai-machine
   (Grafana stays for long-history/remote viewing; the in-daemon dashboard is the live box view).
3. **Model→queue auto-discovery** from the `strix-halo-r9700-llm-builds` catalog on `SIGHUP`
   (replaces manual re-seeding on role swaps).
4. **LAN mode:** bind 0.0.0.0:4100 behind a shared token (secret in `/etc/nixos/secrets`,
   referenced by path) for a second machine's harnesses; Caddy route optional. Measured LAN RTT
   (§3.1) says this is performance-fine.
5. **Per-identity weights / priorities** in the FIFO (audit data already supports the policy).
6. **Evidence-based lease watchdog** (no stream chunks for 5 min ⇒ force-release + audit flag).
7. **`tan` CLI adoption by scripts** (bench orchestrator preflight, modelctl) — extends
   serialization to batch workloads.
8. **opencode Desktop panel** (`gui-experimental`) — likely collapses into embedding/ linking the
   server dashboard once it lands; keep only if a native in-app view proves wanted.

---

## 14. Chosen defaults for every open point (no human input needed)

| Open point | Chosen default | Why |
|---|---|---|
| Name | `take-a-number` (not "llm-gateway") | Not a gateway (no data path — it's a queue/lease arbiter); not LLM-only (covers image-gen + future modalities; Jev-class small MoEs are LLMs, but the scope is broader). Model-neutral + "gate" = the semaphore semantics |
| Dashboard location | In the daemon (server), `GET 127.0.0.1:4100/` | Single source of truth; one maintained view of all harnesses; survives any client; dsh panel + opencode TUI + CLI all read the same data |
| Dashboard Phase 1 | Port of the model-capacity Activity page, server-side | Familiar visual language, zero new design risk; polish is Phase 2 |
| Transport | UDS default + TCP 127.0.0.1:4100, same protocol | §3.1: no latency difference that matters; UDS = less surface locally |
| Port | 4100 | Free per box conventions, litellm-adjacent |
| Repo layout | `take-a-number` (daemon+client+opencode plugin) + `dsh-plugins/packages/take-a-number` | dsh plugin source must live in dsh-plugins (that repo's rule) |
| Daemon user | new `gate` system user | Box pattern: one user per service; no sudo |
| Queue limits | 1 per GPU | The point is serialization; `set-limits` raises it if a GPU shares cleanly |
| Unmapped models | `unlimited` (pass through, recorded) | A new model must never brick a harness |
| Gate down | Fail open | Harness availability > serialization on a dev box |
| Lease expiry | None; connection-liveness + operator force-release | Matches model-capacity semantics; no clock can know the GPU is free |
| Queueing style | Strict FIFO | model-capacity's proven semantics; weights are Phase 2 |
| opencode chat-log injection | Not done (context pollution); TUI line + dashboard + audit instead | `synthetic` enters model context; no client-only slot exists |
| Multi-machine | Designed for (protocol + TCP), not enabled | LAN measured at ~0.5 ms; enable in Phase 2 behind a token |
| dsh production restart | Planned window, announced in the final message (dsh-deploy rule) | Repo policy, not a plan gap |

---

## Appendix A — key source references (verified 2026-11-15)

- `dsh-plugins/packages/model-capacity/{src/semaphore.mjs, src/gate.mjs, src/host.mjs, src/config.mjs, README.md}` — reference implementation.
- `anomalyco/opencode` (dev, v1.18.34-era): `packages/core/src/session/model-request.ts` (http.request/http.response hook wiring, kinds, "both hook families are always offered"), `packages/core/src/aisdk.ts` (ALS middleware into AI-SDK fetch; `streamLanguage`), `packages/plugin/src/promise/plugin.ts` + `packages/plugin/src/effect/session.ts` (plugin API, `SessionRequestKind`, hook specs), `packages/plugin/src/tui/` (TUI plugin surface).
- `local-ai-machine`: `docker/docker-compose.yml` (M-094/M-140 history in comments), `configuration.nix` (`dsh.service` pattern, sudo scoping, port conventions), `README.md` (role aliases, gateway).
- `dsh-deploy/AGENTS.md` (plugin pin-in-both-trees rule, lab workflow, restart-window rule).
