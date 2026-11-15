# T1 — Daemon, client, CLI, dashboard

**Status:** done
**Repo:** `chrisjohnson/take-a-number` (this repo)
**Depends on:** nothing

## Deliverable

A working, tested `take-a-number` in this repo:

1. `daemon/` — the gate daemon (Node 22, **zero npm dependencies**): FIFO queue per GPU,
   leases, per-connection identities, JSONL audit, UDS + TCP transports, JSON-line protocol
   (§Protocol below), HTTP server serving the dashboard at `GET /` and JSON at `/api/*`.
2. `client/` — `tan-client` (plain ESM, zero deps, no build): connect (UDS first, TCP
   fallback), register, acquire (long-poll wait loop), release, cancel, fail-open degraded
   mode, auto-reconnect.
3. `bin/tan` — tiny CLI on the client: `tan status`, `tan acquire --model X --kind Y [--desc Z]
   [--hold-ms N]`, `tan release <leaseId>`, `tan cancel <waiterId>`, `tan tail`.
4. `dashboard/` — the Phase-1 dashboard: **a port of the `dsh-model-capacity` Activity page**
   (the user's explicit starting point; see `dsh-plugins/packages/model-capacity/src/client.mjs`
   and its README "Panel" section for the behavior and visual language): header with live
   enforcing status, KPI cards (active / queued), one color-accented card per queue with
   capacity bar, active lease cards (identity, model, kind, **description**, session, elapsed —
   active cards breathe), waiter rows (identity, model, position, waited), per-queue 60 s
   busy-rate graph, green/yellow/red states, FLIP-animated list updates,
   `prefers-reduced-motion` respected, dark theme, live over the `events` NDJSON stream with a
   2 s poll fallback. Static files only (`index.html` + `app.js` + `style.css`), no framework,
   no build step, served by the daemon.
5. `README.md`, `AGENTS.md` (deploy rules + hard stops), `.github/workflows/ci.yml`
   (`node --test` over all test dirs, node 22).

## Protocol (authoritative)

Newline-delimited JSON over UDS **and** TCP (identical). Request
`{"id":<client string>,"type":...,...}` → response `{"id":<same>,"ok":true,...}` or
`{"id":...,"ok":false,"error":{"code","message"}}`. First request on a connection must be
`register`; anything else closes the connection.

```
register  {harness, instance, pid, host, user, version}
          → {identityId}

acquire   {identityId, model,
           kind?,            # open string; canonical: interactive-chat | set-title |
                             # compaction | subagent | judge | generate | image-gen | call
           description?,     # ≤160 chars, human-readable what-this-call-is, e.g.
                             # "interactive-chat · turn 7 · “Fix the deploy script”"
           session?, sessionTitle?, turn?, modality?,   # modality: text|image|embedding|other
           meta?}            # free-form object; stored, echoed in status, written to audit
          → {status:"granted", leaseId, queue}
          | {status:"queued",  waiterId, queue, position, active, limit}

wait      {identityId, waiterId, timeoutMs ≤ 25000}
          → {status:"granted", leaseId, queue, waitedMs}
          | {status:"still-queued", position, active, limit}
          | {status:"cancelled"}

release   {identityId, leaseId}            → {released: true|false}   (idempotent)
cancel    {identityId, waiterId}           → {cancelled: true|false}
force-release {leaseId}                    → {released: …}            (operator; audited)
status    {}                               → snapshot (§below)
events    {}                               → long-lived NDJSON stream:
                                             queued/granted/released/cancelled/force-release/
                                             identity-up/identity-down/config frames,
                                             coalesced ≤ 1/150 ms, 15 s keep-alive when idle
set-limits {queues: [{id, limit}], queueLimit?}
          → new snapshot                    (audited; also persisted to the config file)
```

**Identity lifetime = connection lifetime.** One identity per connection. On socket close the
daemon immediately releases all of that identity's leases, cancels its waiters, emits
`identity-down`, and audits it. **No TTL timers anywhere.**

**Queues & config** (`--config` file, JSON):

```json
{ "queues": [ { "id": "strix-apu", "limit": 1, "models": ["small-dense", "big-moe", "small-moe", "image-gen"] },
               { "id": "r9700-egpu", "limit": 1, "models": ["medium-dense", "medium-moe"] } ],
  "unmapped": "unlimited",
  "queueLimit": 1000 }
```

Model name (primary) / provider hint (secondary) resolves the queue. Unmapped model →
`unlimited` synthetic lease (recorded, not gated) when `unmapped: "unlimited"`. `queueLimit`
bounds waiters per queue; beyond it `acquire` returns error code `QUEUE_FULL`.

**Audit** (`--audit` dir, JSONL, one file per UTC day, 14-day retention pruned at startup):
`{at, event, queue?, identity?, model?, kind?, modality?, session?, sessionTitle?, turn?,
description?, meta?, leaseId?, waiterId?, position?, waitedMs?, runMs?, note?}`. Events:
`register`, `identity-down`, `queued`, `granted`, `released`, `cancelled`, `force-release`,
`config`. `runMs` filled on `released`.

**`status` snapshot:**

```json
{ "asOf", "uptimeSec", "version",
  "queues": [ { "id", "limit", "unlimited",
    "active":  [ { "leaseId", "identityId", "identity", "model", "kind", "description",
                   "session", "sessionTitle", "turn", "modality", "meta",
                   "startedAt", "elapsedMs", "waitedMs" } ],
    "waiters": [ { "waiterId", "identityId", "identity", "model", "kind", "description",
                   "session", "position", "enqueuedAt", "waitedMs" } ] } ],
  "identities": [ { "identityId", "harness", "instance", "pid", "host", "user",
                    "connectedAt", "leases", "waiters" } ],
  "totals": { "active", "waiting" } }
```

`identity` renders as `harness/instance#pid@host`.

**HTTP** (same TCP listener): `GET /` → dashboard files; `GET /api/status`;
`GET /api/audit?identity=&queue=&model=&kind=&modality=&from=&to=&limit=` →
`{lines, total, truncated}` (newest first); `POST /api/{release,cancel,force-release,set-limits}`
with JSON bodies; `GET /api/events` → NDJSON stream. Loopback-only bind. No auth (box posture).

## Work instructions

1. **`daemon/lib/queues.js`** — pure queue/lease/identity state machine, no I/O: buckets per
   queue (active Set + FIFO waiter array), `acquire` fast path (free and empty queue ⇒ grant
   synchronously), `wait` registration with timeout callback, `release`/`drain`, `cancel`,
   `forceRelease`, `identityDown(identityId)`, `snapshot()`, event emission callback. Port the
   semantics from `dsh-plugins/packages/model-capacity/src/semaphore.mjs` (read it first — the
   FIFO, drain, and abort-ordering details are already worked out there).
2. **`daemon/lib/protocol.js`** — connection handling: framing (newline-delimited), `register`
   gate, request dispatch, `events` subscription registry with 150 ms coalescing + 15 s
   keep-alive, connection-close ⇒ `identityDown` + audit.
3. **`daemon/lib/audit.js`** — daily JSONL writer, 14-day prune, best-effort after first write
   failure of a day (log and continue).
4. **`daemon/main.js`** — flags `--sock --tcp --config --audit --version`; UDS server (socket
   mode 0666) + TCP server (127.0.0.1:4100) + HTTP on the TCP port; config load (invalid config
   ⇒ exit 1 with a loud message); `SIGHUP` reload of config (Phase-2 auto-discovery hooks here
   later — for now SIGHUP just re-reads the file).
5. **`client/index.mjs`** — `class Tan` per PLAN.md §6: constructor
   `{harness, instance, sock='/run/take-a-number/tan.sock', url='http://127.0.0.1:4100'}`;
   `start()`; `acquire({model, kind, description, session, sessionTitle, turn, modality, meta,
   signal})` → `Lease {id, queue, waitedMs, release()}`; internal long-poll `wait` loop (25 s
   timeouts); `status()`; `onEvent(cb)`; **fail-open**: after 2 connect failures (~300 ms)
   `mode:'degraded'`, un-gated leases, background reconnect backoff 1→30 s; orphaned-lease
   no-op release on connection death.
6. **`bin/tan`** — `#!/usr/bin/env node`, arg parsing by hand (no deps). `acquire --hold-ms N`
   is the test hook: acquires, holds N ms, releases (default: hold 5000 ms). `tail` tails the
   audit via `/api/audit`.
7. **`dashboard/`** — port the model-capacity Activity page. Read
   `dsh-plugins/packages/model-capacity/src/client.mjs` + README "Panel" section first and copy
   its structure, states, and motion (KPI cards, per-queue cards + capacity bars, lease cards
   with identity/description, waiter rows, 60 s rate graph, green/yellow/red, breathing active
   cards, FLIP handover animation, reduced-motion off-switch). Data: `GET /api/status` +
   `GET /api/events` (poll fallback 2 s). No framework, no build.
8. **Tests** (`node --test`):
   - `daemon/test/queues.test.mjs` — FIFO across identities, position, queue bound, cancel,
     force-release, identityDown reclaims leases+waiters, unlimited pass-through, snapshot shape.
   - `daemon/test/protocol.test.mjs` — real UDS **and** real TCP: register gate, acquire→granted
     fast path, acquire→queued→wait→granted with `waitedMs`, release idempotence,
     connection-close ⇒ identity-down, events stream coalescing, audit lines written.
   - `client/test/client.test.mjs` — against an in-test real daemon: fail-open after daemon
     stop, reconnect after daemon start, abort ⇒ cancel, long-poll loop, degraded-mode leases.
   - `dashboard/test/dashboard.test.mjs` — structural: served at `/`, references `/api/status`,
     contains the queue-card/identity/description render hooks (DOM-free checks on the served
     HTML/JS source).
9. **README.md** — what it is, protocol summary, run instructions, dashboard screenshot note
   (no screenshot file — describe), config reference, failure semantics. **AGENTS.md** — repo
   rules: zero-dep constraint, direct-push-to-main, port/socket conventions, hard stops (no
   auth changes, no non-loopback bind without a token — that's a Phase-2 decision).
10. **CI** — `.github/workflows/ci.yml`: node 22, `node --test daemon/test client/test`.

## Verification (run all, paste results into Evidence)

```sh
cd /home/t3code/work/take-a-number
node --test daemon/test client/test dashboard/test        # all green
node daemon/main.js --sock /tmp/tan.sock --tcp 127.0.0.1:4199 \
     --config /tmp/tan-config.json --audit /tmp/tan-audit &  # test config: both queues, limit 1
tan status --sock /tmp/tan.sock                             # shows 2 queues at 0/1
tan acquire --sock /tmp/tan.sock --model medium-dense --kind interactive-chat --desc "test hold" --hold-ms 8000 &
tan acquire --sock /tmp/tan.sock --model medium-dense --kind set-title --desc "test waiter" --hold-ms 1000
# second acquire must print queued (position 1), then granted after ~8 s with waitedMs ≈ 8000
curl -s 127.0.0.1:4199/api/status | node -e '…'            # snapshot shape per spec
curl -s "127.0.0.1:4199/api/audit?limit=5"                 # register/queued/granted/released lines
kill %1                                                     # daemon dies; a third `tan status` then fails
tan acquire …                                               # client reports degraded/un-gated, no hang
```

## Review cycle (part of this ticket)

1. `git diff` self-review against this ticket's protocol table — every field, code, and
   response shape present; nothing extra.
2. Zero-dep check: `grep -r "require(\|from ['\"]" daemon client bin | grep -v "node:\|'\./\|\"\./"`
   shows no npm imports.
3. Run the full test suite twice in a row (flakiness check).
4. Security pass: socket 0666, TCP loopback-only, no auth (documented), audit never logs
   request bodies (metadata only — `description` is the only free text and it is client-supplied
   and truncated to 160 chars).
5. Mark this ticket `Status: done`, fill Evidence, commit, push to `main`.

## Evidence

- **Tests:** `node --test test/*.test.js` → `# tests 28 / # pass 28 / # fail 0 / # cancelled 0`
  (13 state-machine incl. the drain-promotion id-clobber and identityDown ordering
  regressions, 9 protocol over a real UDS server incl. the post-promotion `wait` race,
  6 client incl. crash-reclaim and fail-open, dashboard render verified separately via
  jsdom DOM execution — 14/14 assertions: queue cards, live/waiting states, metadata
  tags, KPIs, identity rows).
- **Live smoke (loopback daemon, port 4199):** `tan status` shows both queues; holder CLI
  `acquire --model medium-dense --hold-ms 5000` → second CLI queues at position 1 →
  releases on release (audit: `granted … waited 0ms`, `released … ran 5003ms`);
  crash (client close without release) reclaims the lease for the next waiter;
  daemon-down client degrades to pass-through in < 1 s; `/api/status`, `/api/audit`,
  `/api/events` (NDJSON stream), `/api/cancel`, `/api/force-release`, `/api/set-limits`
  all exercised; `GET /` + `/static/*` serve the dashboard (200s, CORS for loopback embeds).
- **Review:** zero runtime dependencies (package.json has none); state machine is pure
  (no I/O in `queues.js`); loopback bind enforced (`main.js` refuses non-127.0.0.1);
  no TTL timers; metadata stored/echoed/audited verbatim (description clamped to 160);
  audit is append-only daily JSONL with 14-day retention.
