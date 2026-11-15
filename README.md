# take-a-number

Global model-call queue and lease service for locally hosted models. One FIFO queue per GPU;
every model call from every harness (DSH instances, opencode, …) takes a number, waits in its
GPU's queue, runs under a lease stamped with a per-process identity, and releases. A
server-side dashboard shows the whole box.

- **`PLAN.md`** — architecture reference (research, protocol, failure semantics, deployment).
- **`tickets/`** — the executable work plan (3 tickets, in order).
- `daemon/`, `client/`, `bin/tan`, `dashboard/` — delivered by ticket 001.
