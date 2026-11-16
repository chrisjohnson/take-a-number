# T6 — Prometheus /metrics on the daemon + Grafana dashboard

**Status:** in progress — daemon + box config deployed and verified; **pending the
user's image swap** (TAN_TAG bump + `compose up -d`, outside the agent's docker
scope). After that, the Prometheus target flips `up` and the Grafana panels get
data.
**Repos:** `chrisjohnson/take-a-number` (daemon `/metrics`), `chrisjohnson/local-ai-machine`
(prometheus scrape job, Grafana dashboard JSON, knowledge note)
**Depends on:** T1–T5 live (daemon on `127.0.0.1:4100`; the box already runs Prometheus
`:9090` + Grafana `:3000` with file-provisioned dashboards). PLAN.md §13 item 2.

## Why

The in-daemon dashboard is the **live** view (current leases, queue, audit). What it cannot
do is show **history**: how deep did the queue get at 2 a.m., which identity generates the
most calls, how long do generations actually run, how often do grants expire unclaimed.
Prometheus scrapes give that long-history view (and remote viewing via Grafana) for free,
because the box already runs the whole observability stack. The daemon must stay
zero-dependency: the Prometheus text exposition format is trivial to render by hand.

## Design

### Daemon — `GET /metrics` (zero-dep text exposition)

- New `daemon/lib/metrics.js`: `createMetrics({ queues, version, startedAt })` →
  `{ observe(type, payload), render() }`.
- **Gauges** are derived from `queues.snapshot()` **at scrape time** (no extra state,
  always consistent with the dashboard):
  - `tan_up{version}`, `tan_uptime_seconds`, `tan_identities`
  - `tan_queue_depth{queue}` (waiters), `tan_queue_limit{queue}` (0 = unlimited),
    `tan_queue_active{queue}`
  - `tan_identity_leases{identity}`, `tan_identity_waiters{identity}`
  - `tan_queue_longest_wait_seconds{queue}`, `tan_queue_longest_lease_age_seconds{queue}`
- **Counters** accumulate in memory from the existing `queues.onEvent` stream (wired in
  `main.js` by wrapping the `connectEvents` callback — the Queues class itself stays
  timer- and metric-free). Counters reset on daemon restart, which is standard Prometheus
  semantics (`increase()` in queries):
  - `tan_grants_total{queue,identity}`, `tan_releases_total{queue,reason}`,
    `tan_cancellations_total{queue,reason}`, `tan_rejections_total{queue,reason}`,
    `tan_identity_ups_total`
  - `queue` label is `unmapped` when the payload's queue is null; `identity` is the
    instance name (`unknown` when absent).
- **Histograms** from the same events (bucket counts + `_sum` + `_count`):
  - `tan_wait_seconds{queue}` from `granted.waitedMs` — buckets
    0.5 / 1 / 2.5 / 5 / 10 / 30 / 60 / 120 / 300 s
  - `tan_run_seconds{queue}` from `released.runMs` — buckets
    1 / 5 / 10 / 30 / 60 / 120 / 300 / 600 / 1800 s
- **Auth:** `GET /metrics` is exempt from the optional `?token=` (same class as the
  dashboard shell): it exposes nothing the dashboard already shows, the port is
  loopback-only by invariant, and a plain static Prometheus scraper has nowhere to put
  a query token.
- Label values are escaped (`\`, `"`, newline); series within a family are emitted in
  sorted order for deterministic output (test-friendly, diff-friendly).

### local-ai-machine

- `docker/prometheus/prometheus.yml`: job `take-a-number` → `localhost:4100`,
  `metrics_path: /metrics` (the daemon publishes `127.0.0.1:4100` — reachable from the
  prometheus container's host network the same way litellm's `:4000` is).
- `docker/grafana/dashboards/take-a-number.json` (file-provisioned, 30 s refresh):
  - queue depth + limit per queue (bars), active leases per queue
  - wait-time p50/p95 + grant rate per queue (from the histogram)
  - calls per identity (rate of `tan_grants_total`), releases by reason (stacked)
  - run-time p50/p95 per queue, longest current wait/lease age (gauges)
- `knowledge/context/take-a-number-stack.md`: add the metrics line.

### Deployment (box)

- Daemon: push to take-a-number `main` → CI builds
  `ghcr.io/chrisjohnson/take-a-number:<sha>` + `:latest` → the box's `docker/.env`
  `TAN_TAG` pin + `docker compose up -d take-a-number tan-proxy` (**user step** — the
  agent's docker scope has no `up`/`run`; `pull`/`restart` only).
- Prometheus/Grafana: push to local-ai-machine `main` → `/etc/nixos/deploy.sh` updates
  the box checkout → `docker compose restart prometheus` (grafana's file provider
  picks up the new dashboard JSON within 30 s on its own).
- Until the daemon image is swapped, the new prometheus target shows `down`
  (`/metrics` 404s on the old image) — harmless, like an unoccupied model port.

## Deliverables

1. `take-a-number`: `daemon/lib/metrics.js`, `GET /metrics` in `daemon/lib/http.js`,
   wiring in `daemon/main.js`, README metrics section. Zero runtime deps. Release
   `v0.6.0` + tag (CI image).
2. Tests: `test/metrics.test.js` (renderer unit: empty state, counters, histograms,
   label escaping, gauges against a real `Queues` instance) + a `/metrics` route test
   in the existing HTTP e2e suite.
3. `local-ai-machine`: prometheus job + Grafana dashboard + knowledge note; pushed to
   `main`, deployed via `deploy.sh`.
4. Evidence pasted below: daemon `/metrics` sample output, Prometheus target `up` + a
   couple of sample queries, Grafana dashboard loading with live panels.

## Out of scope

- Recording rules / alerts (the box's Prometheus has none for other services either).
- LAN exposure of `/metrics` (loopback-only is the security model; Grafana is the
  remote view).
- Per-model breakdowns in the metrics (the audit log already carries model/kind/
  modality per call; the dashboard shows it live).

## Evidence

### Daemon `/metrics` (live, v0.6.0)

Rendered by hand (zero deps). Empty-state scrape of a fresh daemon:

```
# HELP tan_up The take-a-number daemon is up.
# TYPE tan_up gauge
tan_up{version="0.4.0"} 1
tan_uptime_seconds 0.986
tan_identities 0
tan_queue_depth{queue="r9700-egpu"} 0
tan_queue_depth{queue="strix-apu"} 0
tan_queue_limit{queue="r9700-egpu"} 1
tan_queue_limit{queue="strix-apu"} 3
tan_queue_active{queue="strix-apu"} 0
...
# TYPE tan_grants_total counter
# TYPE tan_wait_seconds histogram
# TYPE tan_run_seconds histogram
```

Under real traffic (two static clients on a limit-1 queue — one granted, one
queued, then released):

```
tan_identity_ups_total 2
tan_grants_total{queue="strix-apu",identity="smoke-a"} 1
tan_grants_total{queue="strix-apu",identity="smoke-b"} 1
tan_releases_total{queue="strix-apu",reason="identity_down"} 2
tan_wait_seconds_bucket{queue="strix-apu",le="0.5"} 1
tan_wait_seconds_bucket{queue="strix-apu",le="1"} 1
tan_wait_seconds_bucket{queue="strix-apu",le="+Inf"} 2
tan_wait_seconds_sum{queue="strix-apu"} 1.507
tan_wait_seconds_count{queue="strix-apu"} 2
tan_run_seconds_sum{queue="strix-apu"} 1.508
tan_run_seconds_count{queue="strix-apu"} 2
```

Counters, histograms, and identity gauges all populate correctly; a crashed
client's leases are released via `identity_down` (the reason label is right).

### Tests

`node --test test/*.test.js plugins/opencode/test/*.test.js` → **107 pass / 0
fail** (7 new `metrics.test.js` renderer cases + 2 `/metrics` HTTP e2e cases).

### Box deployment (local-ai-machine `a36de22`, via `deploy.sh`)

- `deploy.sh` ended `VERIFY OK`; the box checkout now carries the new
  `prometheus.yml` and `grafana/dashboards/take-a-number.json`.
- `prometheus` restarted to load the new job. The `take-a-number` target is
  registered and currently `down` with `HTTP 404` — **expected**: the box is
  still on the pre-v0.6.0 image (`TAN_TAG` pin), which has no `/metrics`. It
  flips `up` the moment the image is swapped (below).
- Grafana file-provisioner picked up the new dashboard JSON (30 s refresh); no
  provisioning errors in the container log.

### Pending user step (outside the agent's docker scope — no `up`/`run`)

On the box, in the `docker/` checkout:

```sh
# 1. point the pin at v0.6.0
sed -i 's/^TAN_TAG=.*/TAN_TAG=c037a4117aa3ff8228748e5d238fd93cb8769da9/' .env
# 2. pull + recreate the daemon and proxy
docker compose pull take-a-number tan-proxy
docker compose up -d take-a-number tan-proxy
```

Then confirm: `curl -s 127.0.0.1:4100/metrics | head` and the Prometheus
target shows `up`, and the Grafana dashboard `take-a-number — model-call queue`
has live panels.

## Review checklist

- [x] Zero runtime dependencies; exposition rendered by hand.
- [x] `Queues` state machine unchanged (metrics observe, never gate).
- [x] Counters/histograms from the event stream; gauges from `snapshot()` at scrape time.
- [x] `/metrics` loopback-only, token-exempt like the dashboard shell.
- [x] Unit + e2e tests green; full suite green (107 pass).
- [ ] Prometheus target `up`; Grafana dashboard renders live panels — **pending the
      image swap above** (target is registered and `down`/404 on the old image, as expected).
- [x] Deployed through git only (take-a-number main + local-ai-machine `deploy.sh`).
