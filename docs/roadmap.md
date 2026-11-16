# Roadmap — post-rollout work

This directory is the home for **planning documents**: forward-looking design,
trade-off analysis, and the backlog that isn't a ticket yet. Executable,
scoped work lives in [`tickets/`](../tickets/); the original architecture plan
lives in [`PLAN.md`](../PLAN.md). This file is the living **Phase-2 roadmap** —
the "after rollout" items from PLAN.md §13, each independently shippable, with
status and the reasoning behind each.

Legend: **done** · **in progress** · **pending** · **deferred**.

## Status snapshot (2026-11-16)

| # | Item | Status |
|---|------|--------|
| 1 | Dashboard polish pass | pending |
| 2 | Prometheus `/metrics` + Grafana | **done** (ticket 006) |
| 3 | Model→queue auto-discovery | pending |
| 4 | LAN mode (second machine) | pending |
| 5 | Per-identity weights / priorities | deferred |
| 6 | Lease watchdog | **in progress** (15 min threshold) |
| 7 | `tan` CLI adoption by scripts | pending |
| 8 | opencode Desktop panel | pending |

Plus one already-shipped follow-up that PLAN.md §13 did not list:

| — | Caddy `models.*` route → proxy | **done** (queueing mandatory for the hostname; see below) |

---

## 2. Prometheus `/metrics` + Grafana — done

The daemon serves `GET /metrics` (Prometheus text exposition, rendered by hand
— zero runtime deps). Gauges come from a live `snapshot()` at scrape time;
counters and the wait/run histograms accumulate from the event stream and reset
on restart (normal Prometheus semantics). The box scrapes it as the
`take-a-number` Prometheus job, and a Grafana dashboard
(`take-a-number — model-call queue`) shows queue depth, active leases,
wait/run percentiles, grant rate by identity, and releases by reason.

The in-daemon dashboard stays the **live** view; Grafana is the **long-history**
view. See ticket 006 for evidence.

## 6. Lease watchdog — in progress (15 min)

**Problem.** A *crashed* process frees its GPU slot instantly (identity
lifetime = connection lifetime). A *hung* one does not: a live connection whose
model stream stalls (wedged worker, a client stuck mid-stream) holds its slot
**forever**. Before this, the only remedy was a manual `force-release` from the
dashboard/CLI.

**Design.** The proxy owns the response bytes, so it owns the watchdog: while
forwarding, a resettable silence timer watches the response stream. If **no
byte arrives for 15 minutes**, the generation is declared hung — the proxy
destroys the upstream leg (frees the GPU), ends the client's response cleanly,
and releases the lease with the distinct, auditable reason **`watchdog`**.

**Why 15 min, not 5.** The threshold is *no-bytes-for-N*, not *total-duration* —
a long generation is never touched, only a silent one. 15 minutes of silence is
far beyond any cold start, which keeps the false-positive rate (aborting a
legitimate slow stream) negligible. It is tunable at deploy time via
`--stall-ms`.

**Auditability.** The release reason rides the `release` protocol message (an
added, non-breaking field) so the audit log and the `tan_releases_total{reason}`
metric can tell a watchdog kill from a normal settle, a `grant_expired` sweep,
an `identity_down`, or an operator `force_release`.

## Caddy `models.*` route → proxy — done (already shipped)

The `models.local-ai-machine.johnsonlab.dev` hostname is routed through the
admission proxy (`:4140`), which fronts litellm (`:4000`) — so **every model
call through the hostname is queue-gated**, LAN-gated like the dashboard. This
replaced the old `litellm.*` hostname that hit `:4000` directly and bypassed
the queue. Loopback harnesses (dsh, opencode, the CLI) point at `:4140`
directly. The only remaining bypass is a *local box process* that points straight
at `:4000` — that is `playsense-api` (out of scope) and any ad-hoc local script.
Non-model paths (health checks, `/v1/models`) still traverse the proxy but take
an **unlimited** lease, so they never consume a GPU slot.

## 1. Dashboard polish pass — pending

The in-daemon dashboard is a functional Phase-1 port of the model-capacity
Activity page. This is the visual/interactive treatment: an identity table, an
audit explorer, interactive operations, history charts, and a dark theme. Pure
frontend, zero protocol risk. Now that Grafana owns *history*, the in-daemon
view's job sharpens to a **live operational glance** — polish is about quick
usability, not long-term charts.

## 3. Model→queue auto-discovery — pending

Today the model→queue map is static config (`/etc/take-a-number/config.json`),
re-seeded by hand when a model changes GPU/role. Auto-discovery reads the
`strix-halo-r9700-llm-builds` catalog on `SIGHUP` and rebuilds the map, so a
role swap self-heals. It removes the **config-drift** failure mode (a model
briefly queueing on the wrong GPU — still serialized, so no correctness loss,
just a fairness blip). High value-per-effort; self-contained.

## 4. LAN mode (second machine) — pending

The daemon is loopback-only today (a security invariant). LAN mode binds
`0.0.0.0:4100` **behind a shared token** (a secret in `/etc/nixos/secrets`,
referenced by path) so a second machine's harnesses (e.g. `desktop`) can queue.
LAN RTT is ~0.5 ms, so it is performance-fine. The protocol already supports
TCP + identity, so this is mostly: token auth on the protocol path + a Caddy
route + the secret. It **deliberately relaxes** the loopback-only model, behind
a token — a real security decision, not a freebie.

## 5. Per-identity weights / priorities — deferred

Strict FIFO is a core invariant. Weights would let, e.g., interactive dsh turns
jump ahead of a batch workload. The audit data already supports deciding the
policy (you can see who is who and who waits). This is the **biggest design item**
on the list — it changes queue semantics — so it is deferred until the audit
data has had time to show who actually needs priority, rather than designing it
speculatively.

## 7. `tan` CLI adoption by scripts — pending

Point the bench-orchestrator preflight and `modelctl` at the queue, extending
serialization to **batch workloads**, not just the interactive harnesses. Small,
and it rounds out the "global" in global model-call queue.

## 8. opencode Desktop panel — pending

An in-app queue view for opencode's `gui-experimental`. Most likely collapses
into embedding/linking the server dashboard once it lands; keep a native view
only if it proves wanted.
