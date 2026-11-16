# opencode-take-a-number

opencode plugin that gates every model call through the [take-a-number](../../README.md)
queue. opencode 1.18+, plain JS, zero runtime dependencies.

## How it works

opencode 1.18.34 has no `http.*` hooks and no response hook, so a plugin can inject
request headers but cannot observe response completion. The design leans on that:

1. **`chat.headers` hook** (the only gate): for a model in the queue map, the plugin
   acquires a **dynamic** lease from the daemon (awaiting the grant) and sets
   `x-tan-client: <instance>` + `x-tan-claim: <one-time token>` on the outgoing
   request. Session attribution rides on the lease (`session`, `kind`, `description`).
2. **The admission proxy** checks the lease out via the claim token and **releases it
   when the forwarded response completes or aborts**. Release is proxy-owned; the
   plugin never releases a grant.
3. **Fail-open everywhere.** Unmapped model, daemon down, stale queue map, a grant
   without a token, or a plugin fault → no headers → the call proceeds (the proxy
   still gates it on the hard path). The queue is never a hard dependency for a model
   call.

The one leak path — a granted lease whose request never reaches the proxy (e.g. the
user interrupts inside the hook) — is bounded by the daemon's 30 s grant-TTL sweep.
`chat.headers` carries no abort signal, so an in-flight acquire cannot be cancelled by
a user interrupt; it is bounded by `acquireTimeoutMs` (default 10 min), after which
the waiter is cancelled and the call passes through (the proxy then hard-queues it).

## Configure

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "/path/to/take-a-number/plugins/opencode",
      {
        "instance": "opencode",
        "queues": [
          { "queue": "strix-apu", "models": ["small-dense", "big-moe", "small-moe", "image-gen"] },
          { "queue": "r9700-egpu", "models": ["medium-dense", "medium-moe"] }
        ]
      }
    ]
  ]
}
```

Options (all optional):

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | set `false` to load a no-op plugin |
| `instance` | `opencode` | the client's self-identity (shown in the daemon/dashboard) |
| `queues` | `[]` | mirror of the daemon's model→queue map; models absent here pass through with no daemon round-trip. A stale view degrades to pass-through, never to a brick. |
| `sock` | `/run/take-a-number/tan.sock` | daemon UDS |
| `tcp` | `127.0.0.1:4100` | daemon TCP fallback |
| `acquireTimeoutMs` | `600000` | bounded wait for a grant while queued |

The provider `baseURL` must point at the admission proxy (e.g.
`http://127.0.0.1:4140/v1`), not litellm directly — the proxy is what claims and
releases the lease.

## Tests

```sh
node --test plugins/opencode/test/*.test.js
```

`gate.test.js` is pure unit tests against a fake client; `integration.test.js` runs
the gate against a real UDS daemon (acquire → token → proxy-style checkout → release,
queueing behind a hold, grant-TTL sweep).
