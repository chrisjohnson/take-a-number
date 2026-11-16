# T6 — Prometheus /metrics on the daemon + Grafana dashboard

**Status:** not started
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

_(to be filled as work completes)_

## Review checklist

- [ ] Zero runtime dependencies; exposition rendered by hand.
- [ ] `Queues` state machine unchanged (metrics observe, never gate).
- [ ] Counters/histograms from the event stream; gauges from `snapshot()` at scrape time.
- [ ] `/metrics` loopback-only, token-exempt like the dashboard shell.
- [ ] Unit + e2e tests green; full suite green.
- [ ] Prometheus target `up`; Grafana dashboard renders live panels.
- [ ] Deployed through git only (take-a-number main + local-ai-machine `deploy.sh`).
