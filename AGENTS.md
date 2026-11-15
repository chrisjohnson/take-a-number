# AGENTS.md — take-a-number

## What this repo is

The daemon + client + CLI + dashboard for the global model-call queue on
local-ai-machine. Zero runtime dependencies everywhere (daemon, client, CLI, dashboard) —
that is a hard constraint, not an aspiration. Node 20+ (developed on 22), ESM.

## Develop and test

```sh
node --test test/*.test.js
```

Four suites: `queues.test.js` (pure state machine), `protocol.test.js` (real UDS server,
raw-socket client), `client.test.js` (TanClient against a real server), plus the dashboard
render verified via jsdom in a scratch dir (not committed). A live smoke run:
`node daemon/main.js --sock /tmp/tan.sock --tcp 127.0.0.1:4100 --config <cfg> --audit <dir>`,
then `TAN_TCP=127.0.0.1:4100 node bin/tan status`.

## Invariants — do not break these

1. **Identity lifetime = connection lifetime.** Close ⇒ `identityDown` ⇒ leases released,
   waiters cancelled. No TTL timers anywhere in the state machine. A crashed process must
   free its slots without a clock.
2. **Fail-open.** The client degrades to pass-through when the daemon is down (~300 ms).
   The queue must never be a hard dependency for a model call.
3. **Strict FIFO per queue.** No preemption, no priorities (yet). `drain` only promotes the
   head of the line.
4. **The lease id must survive promotion.** When a waiter is promoted by `drain`, the new
   lease's `id` must not be clobbered by the waiter's own `id` (regression-tested:
   "a drain-promoted lease can be released by its own id").
5. **`identityDown` cancels waiters before releasing leases.** Releasing drains the queue;
   a drain must never re-promote the identity being torn down (regression-tested).
6. **Loopback only.** The daemon refuses any TCP bind that is not 127.0.0.1/localhost.
7. **Metadata is verbatim.** `kind`/`description`/`session`/`sessionTitle`/`turn`/`modality`/
   `meta` are stored, echoed in `status`, and audited as given (description clamped to 160
   chars). The daemon does not interpret them.

## Protocol changes

The protocol table in `README.md` and `tickets/001` is the contract. Clients in other repos
(`dsh-plugins/packages/take-a-number` pins this repo by git tag) depend on field names.
Adding fields is fine; renaming or removing them is a breaking change — bump the version,
retag, and update the pins.

## Deployment

This repo is consumed by:
- **local-ai-machine** (`/home/tan/take-a-number` checkout, systemd `take-a-number` unit,
  `/etc/take-a-number/config.json`) — changes deploy via that repo's `deploy.sh`.
- **dsh-plugins** (`packages/take-a-number` depends on this repo by git tag, subpath
  `client/`).

Deploying a new daemon version to the box: push to main → the box's checkout
`git pull`s (see local-ai-machine's `take-a-number-checkout` unit) → `systemctl restart
take-a-number`. Bumping what dsh uses: retag this repo, bump the pin in dsh-plugins,
re-tag the plugin, bump the pin in dsh-deploy.

## Hard stops

- No runtime dependencies. Dev-only tooling (jsdom for dashboard DOM tests) stays out of
  `package.json` dependencies.
- No non-loopback binds, no auth (loopback-only is the security model).
- The audit directory is append-only per day; never rewrite past days.
