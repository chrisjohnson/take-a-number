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
 dsh (web) ─┐
 dsh (lab) ─┤  tan-client (ESM lib)     ┌─ UDS  /run/take-a-number/tan.sock
 opencode ──┼──────────────────────────►├─ TCP  127.0.0.1:4100  (protocol + HTTP + dashboard)
 tan CLI ───┘                            └─ daemon (node, zero deps)
                                                 │
                                   queues per GPU (FIFO) · leases · identities · audit
```

- **`daemon/`** — the service. Pure state machine (`lib/queues.js`), protocol
  (`lib/protocol.js`), JSONL audit (`lib/audit.js`), entrypoint (`main.js`).
- **`client/index.mjs`** — `TanClient` + `withLease()`. Plain ESM, zero runtime
  dependencies, runs on Node 20+ and Bun.
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
| `register`     | `{ identityId }` — first message on a connection                        |
| `acquire`      | `{ status: 'granted', leaseId, queue }` / `{ status: 'queued', waiterId, queue, position }` / `{ status: 'unlimited' }` |
| `wait`         | long-poll ≤ 25 s: `{ status: 'granted', leaseId, queue, waitedMs }` / `{ status: 'still-queued', position }` / `{ status: 'cancelled' }` |
| `release`      | `{ released }`                                                          |
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

## Deployment on local-ai-machine

The daemon runs as system user `tan` (systemd `take-a-number`), config at
`/etc/take-a-number/config.json`, audit at `/var/lib/take-a-number/audit`, dashboard at
`http://127.0.0.1:4100/`. The queue config maps live LiteLLM model names to GPU queues
(`strix-apu` = APU, `r9700-egpu` = eGPU); the seed comes from `modelctl list` + LiteLLM
`/model/info`. The dsh harness gates via the `dsh-take-a-number` plugin
(`chrisjohnson/dsh-plugins` → `packages/take-a-number`), pinned in `dsh-deploy`.
See `tickets/` for the deploy plan and `PLAN.md` for the full architecture reference.

## Files

| path                 | what                                                        |
| -------------------- | ----------------------------------------------------------- |
| `daemon/lib/queues.js` | pure queue/lease/identity state machine (no I/O)           |
| `daemon/lib/protocol.js` | connection protocol, long-polls, event feed               |
| `daemon/lib/audit.js`  | append-only JSONL audit, 14-day retention                   |
| `daemon/main.js`       | entrypoint: UDS + TCP/HTTP + dashboard                      |
| `client/index.mjs`     | TanClient, withLease (zero deps)                            |
| `bin/tan`              | CLI                                                         |
| `dashboard/`           | index.html, style.css, app.js (zero deps)                   |
| `test/`                | node:test suites                                            |
| `tickets/`             | the 3-ticket work plan                                      |
| `PLAN.md`              | architecture reference                                      |
