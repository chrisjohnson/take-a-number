# T5 — opencode dynamic path (gate opencode model calls through the queue)

**Status:** not started
**Repos:** `chrisjohnson/take-a-number` (new `plugins/opencode/`), `chrisjohnson/t3code-deploy`
(`agents/opencode.json`: register the plugin + point providers at the proxy)
**Depends on:** T1–T4 live (daemon + admission proxy + dsh plugin + box deploy). The
`models.local-ai-machine.johnsonlab.dev` Caddy hostname is live (→ `127.0.0.1:4140` proxy → litellm).

## Why

Every dsh instance is now a compliant queue client, but **opencode (the t3-owned agent harness) is
not**: its providers point straight at `http://127.0.0.1:4000/v1` (litellm), bypassing the
admission proxy. So the agent's own inference — the heaviest, most continuous load on the box —
tramples the GPU with no queueing, and shows up in the daemon only as an anonymous `tan-proxy`
hard-queued caller (no attribution). This ticket makes opencode a **compliant dynamic client**:
each model call reserves a turn in the daemon's queue and self-identifies, so the agent's
inference is queued, attributed (per session), and serialized fairly against dsh and everything
else.

The "dynamic" capability is the right fit for opencode: it reserves a lease **per request** and
presents a **one-time claim token** with the request, so overlapping calls (forks, steer,
concurrent sessions) each get their own grant without a shared `(model, instance)` correlation
colliding. That is exactly the dsh-compliant flow, adapted to a harness that can gate before the
request.

## What already exists (baseline — verify with the commands, then build on it)

- **Daemon** — dynamic capability + claim tokens are implemented and tested: a `dynamic`
  identity's grant mints a `randomUUID` claim token; `checkout { model, instance, token }`
  validates (present, unexpired, matching lease + instance) and **consumes** the token (one
  request per grant); `sweepStaleGrants` frees granted-but-never-claimed leases and lapsed tokens
  after the grant TTL. Baseline `node --test test/queues.test.js test/admit.test.js
  test/protocol.test.js` was **54 pass / 0 fail** (re-run to confirm before starting).
- **Client lib** (`client/index.mjs`) — `TanClient({ capability: 'dynamic', instance, harness, … })`
  and `checkout({ model, instance, token })`. Zero deps, ESM, UDS + TCP, fail-open.
- **Proxy** (`proxy/lib/admit.js`) — `admit({ model, instance, claimToken, signal })`: if the
  instance is `dynamic`, it calls `checkout` with the token; on a claimed lease it forwards and
  **releases on response completion/abort**; a missing/lapsed/wrong token falls through to the
  hard path. The release is **proxy-owned**, not client-owned.
- **`models.*` Caddy hostname** — live, → `:4140` proxy, LAN-gated.
- **NOT built:** the opencode plugin (`plugins/opencode/` does not exist yet).

## The opencode 1.18.34 plugin API — a discrepancy that reshapes the design (READ FIRST)

PLAN.md §8 was written against an assumed `ctx.session.hook('http.request' | 'http.response', …)`
surface. **Those hooks do not exist in opencode 1.18.34.** The real `Hooks` interface (verified
against `@opencode-ai/plugin/dist/index.d.ts` for 1.18.34) has **no `http.*` hooks**. The relevant
hook is:

```ts
"chat.headers"?: (
  input:  { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
  output: { headers: Record<string, string> },
) => Promise<void>;
```

It is **async** (the plugin may await a grant inside it before returning), and it is the one place
a plugin injects headers into the outgoing LLM request. There is **no response hook**, so a plugin
**cannot wrap the response body** to release a lease.

**Consequence (this is the whole design):** the opencode plugin does **not** release the lease. It
only (a) acquires a dynamic lease and (b) returns `x-tan-client` + `x-tan-claim` headers. The
**proxy** checks the lease out via the claim token and **releases it when the forwarded response
completes or aborts** — exactly the dsh model. This makes the plugin dramatically smaller than the
PLAN.md §8 design (no `wrapResponseBody`, no per-session FIFO pending list, no retry-reaping).

> Update PLAN.md §8 to reflect this once the plugin is built (the `http.*` design is obsolete for
> 1.18.34). Keep the PLAN's intent (per-session attribution via `kind`/`sessionID` rides on the
> lease `description`/`note` fields if the daemon surfaces them; otherwise the instance name
> carries the session).

## Design

### The plugin — `take-a-number/plugins/opencode/`

- `define`-style module per the 1.18.34 `PluginModule` shape: `{ server: (input, options) =>
  Promise<Hooks> }` (verify the exact export shape against `index.d.ts`; `@opencode-ai/plugin` is
  a devDependency, the plugin ships plain JS).
- One `TanClient` per process: `{ harness: 'opencode', instance: <name>, capability: 'dynamic',
  sock/tcp from config }`. Instance name: per-process (a short session suffix is fine for
  traceability; the **claim token**, not the instance name, is what disambiguates concurrent
  calls).
- **`chat.headers` hook** (the only gate):
  1. Model not in the daemon's queue map (unmapped) → `output.headers = {}` (pass through). The
     daemon is authoritative; a stale plugin view degrades to pass-through, never a brick.
  2. Mapped → `acquire({ model, kind/note for attribution })` and **await the grant** (with a
     bounded timeout so an abandoned call can't hang the turn forever). On grant, read the claim
     token off the lease and set `output.headers = { 'x-tan-client': instance, 'x-tan-claim':
     token }`.
  3. Degraded (daemon unreachable) → `output.headers = {}` (fail-open pass-through).
- **No release hook.** The proxy releases on response completion/abort. The only leak path is a
  granted lease whose request never reaches the proxy (client aborted inside `chat.headers`);
  that is bounded by the grant TTL sweep. Document it.
- Config (`options`): `enabled` (default true), `sock`/`tcp` (daemon, defaults
  `/run/take-a-number/tan.sock` / `127.0.0.1:4100`), `instance`.
- Zero runtime deps: import `client/index.mjs` as a git-tag dependency of the package (PLAN.md
  §10). `node --test` for the suite.
- **Abort nuance (known limitation):** `chat.headers` input carries no abort signal, so the plugin
  cannot cancel its in-flight `acquire` when the user interrupts. Mitigations: bounded acquire
  timeout + the proxy's abort handling + grant-TTL sweep. Accept and document; do not over-engineer.

### t3 opencode config — `t3code-deploy/agents/opencode.json`

- Point each provider's `options.baseURL` at the **proxy**: `http://127.0.0.1:4140/v1` (loopback,
  simplest; `https://models.local-ai-machine.johnsonlab.dev/v1` also works — loopback is preferred
  for the agent's own traffic).
- Register the plugin. Per the 1.18.34 `Config` type the key is
  `plugin?: Array<string | [string, PluginOptions]>` — add
  `plugin: [["<git spec for take-a-number plugins/opencode>", { instance: "opencode" }]]` (confirm
  the key + spec form against the installed opencode before committing).
- **Commit via `commit-settings.sh -m "…"`** (t3code-deploy is the live T3 home; never hand-edit
  `~/.config/opencode/opencode.json` — it symlinks into the repo).

## Safety constraints (this agent runs on the box)

- **Do NOT touch the t3-owned opencode config until every Phase-1 lab round passes.** The t3
  opencode is the harness running this and any agent session; a broken plugin or a misrouted
  baseURL bricks the agent. Phase 2 is gated on Phase 1.
- **Lab rounds use `big-moe` (APU queue), never `medium-dense` (eGPU)** — the agent's own
  inference runs on medium-dense; using it in a lab test would make the agent queue behind /
  trample its own calls.
- **Standalone lab opencode only** in Phase 1: a separate config (via `OPENCODE_CONFIG` or a
  project-dir `opencode.json`) and a separate instance. Never `~/.config/opencode/opencode.json`.
- Everything to the box goes through git. No hand edits. Scoped docker/systemctl surface only.
- The `LOCAL_AI_MACHINE_API_KEY` env var is the litellm key; the lab opencode needs it in its
  environment for the provider `env`.

## Phase 1 — standalone lab opencode (do NOT touch the t3 opencode)

**Set up the lab instance** (throwaway; under `/tmp`):
- `/tmp/tan-lab/opencode.json`: a `lab` provider (`big-moe`, `@ai-sdk/openai-compatible`,
  `baseURL` → the proxy `http://127.0.0.1:4140/v1`, `env: ["LOCAL_AI_MACHINE_API_KEY"]`) + the lab
  plugin (local path to `plugins/opencode`).
- Run with the lab config: `OPENCODE_CONFIG=/tmp/tan-lab/opencode.json opencode run -m lab/big-moe
  "say hi"` (verify `OPENCODE_CONFIG` is honored by 1.18.34; if not, run from a project dir
  containing the lab `opencode.json`).
- Daemon status/audit for assertions: `curl -sS 127.0.0.1:4100/…` (the daemon's status/audit
  surface) and the dashboard.

**Rounds — each must pass (paste evidence) before the next:**

1. **Fail-open (daemon down):** stop the daemon; lab opencode makes a `big-moe` call; it
   completes (no headers injected, straight to the proxy → litellm). Confirms the plugin degrades
   safely and never bricks opencode.
2. **Single call admitted (daemon up):** start the daemon; lab opencode makes a `big-moe` call; it
   appears in daemon status/audit as a **dynamic opencode identity**, gets a claim token, is
   granted, completes. Dashboard shows the opencode identity + lease.
3. **Queueing behind a hold:** hold the APU slot (a `tan` CLI lease on `big-moe`, or a second long
   lab call); start a lab opencode `big-moe` call; it **queues** (claim token minted at grant),
   waits, is granted when the hold releases, completes. Verify the APU slot stays held for the
   **whole generation** and is released on completion (not at time-to-first-token).
4. **One token per grant:** a second request reusing a consumed token **misses** and hard-queues;
   a fresh `acquire` yields a fresh working token. Confirms the token is consumed, not
   reusable.
5. **Abort while queued:** start a lab opencode call queuing behind a hold; interrupt it; the
   waiter is cancelled and the daemon returns to baseline (no leaked lease).
6. **Overlap (concurrent calls):** two concurrent lab opencode `big-moe` calls (two
   sessions/processes); both admitted in FIFO order, each with its own claim token, no
   double-admit, both complete.
7. **Cross-harness FIFO:** a dsh lab instance (or `tan` CLI) + a lab opencode call on `big-moe`;
   strict global FIFO; the dashboard names each lease by the correct identity; the audit shows the
   interleaving with waits.
8. **Stale-grant sweep:** acquire a lease, never send the request; verify `sweepStaleGrants` frees
   it after the grant TTL (no permanent leak).

## Phase 2 — configure the t3-owned opencode (ONLY after all Phase-1 rounds pass)

1. In `t3code-deploy/agents/opencode.json`: point all three provider `baseURL`s at the proxy
   (`http://127.0.0.1:4140/v1`); add the `plugin` entry.
2. `commit-settings.sh -m "opencode: gate model calls through take-a-number (dynamic)"`.
3. New T3 opencode sessions pick it up (config loads at opencode start). Verify a T3 opencode
   `big-moe` call appears in the daemon as a dynamic opencode identity, is admitted, completes.
4. Verify the agent's own `medium-dense` (eGPU) calls are now admitted as a compliant dynamic
   client — the agent no longer shows up as an anonymous `tan-proxy` hard-queued caller.

## Deliverables

1. `take-a-number/plugins/opencode/`: the `opencode-take-a-number` plugin (dynamic, `chat.headers`
   gate, proxy-side release), `package.json` (git-tag dep on the client), README. Release + git
   tag. (TUI status line is optional — see out of scope.)
2. Tests: `node --test` unit suite (stubbed gate + stubbed `chat.headers` input) — unmapped
   pass-through, mapped acquire + headers, degraded pass-through, bounded-timeout, one-token-per-
   grant.
3. `t3code-deploy/agents/opencode.json`: providers → proxy, plugin registered. Committed via
   `commit-settings.sh`.
4. Evidence: all 8 Phase-1 rounds + the Phase-2 t3 verification, pasted into this ticket's
   *Evidence* section.
5. PLAN.md §8 updated to the real 1.18.34 API.

## Out of scope

- TUI status line (nice-to-have; the daemon dashboard + audit already show opencode's leases and
  waits).
- Chat-log injection (deliberately not done — synthetic messages would enter model context;
  opencode offers no client-only turn annotation slot).
- Migrating other direct-litellm clients (`playsense-api`) — a separate decision.

## Evidence

_(to be filled as rounds complete)_

## Review checklist

- [ ] Plugin uses the real 1.18.34 `chat.headers` API — **not** the PLAN.md `http.*` design.
- [ ] Dynamic capability + claim token; **release is proxy-side** (no client release hook).
- [ ] All 8 Phase-1 lab rounds pass, evidence pasted.
- [ ] t3 opencode config changed **only after** every Phase-1 round passes.
- [ ] t3 opencode verified as a compliant dynamic client (agent no longer an anonymous
      `tan-proxy` caller).
- [ ] No hand edits on the box; t3code-deploy committed via `commit-settings.sh`.
- [ ] PLAN.md §8 updated to reflect the 1.18.34 API.
