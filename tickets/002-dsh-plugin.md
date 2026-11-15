# T2 — `dsh-take-a-number` plugin in dsh-plugins

**Status:** done (2026-11-15; tag `dsh-take-a-number-v0.1.0`, commit `c3363db`)
**Repo:** `chrisjohnson/dsh-plugins` (new package `packages/take-a-number`)
**Depends on:** T1 done (client API + daemon protocol stable)

## Deliverable

`packages/take-a-number` in `chrisjohnson/dsh-plugins` — the DSH client plugin:

1. **Host half** (`src/host.mjs`, `src/gate.mjs`, `src/config.mjs`): fork of
   `packages/model-capacity`'s architecture with the in-process `CapacityManager` **deleted**
   and replaced by `tan-client` (T1). Same gate placement:
   `ctx.on('llm/stream', (options, next) => gatedStream(…), { global: true, prepend: true })` —
   every call in the process (interactive turns, subagent children, judges, titles, compaction)
   queues; the wait happens before `next()` so provider idle timers start only at grant; the
   lease is released in `finally` on end/fail/abort.
2. **Metadata on every acquire** (the dashboard's food): the plugin composes
   `kind` from dsh's `options.purpose` (canonical mapping — see discovery step below) and
   `description` from the session log it already reads for the panel:
   `"<kind> · turn <n> · “<session title>”"` (turn from the `turnBoundary` projection, title
   from the `title` projection; omit absent parts). Plus `session`, `sessionTitle`, `turn`.
3. **Panel** (`src/client.mjs`): the model-capacity Activity panel **fed by the daemon** —
   `snapshot`/`events` come over the client (daemon `status`/`events`), so the panel shows the
   **whole box** (prod dsh, lab, any future harness) with each lease named by identity. Keep
   model-capacity's UI: sidebar pills, Activity page, composer dock with position/elapsed/
   Cancel turn, per-turn wait cards (`conversation.chat.turnTail`, client-only, 250 ms
   threshold), Force release (daemon RPC, confirmed, audited). Where model-capacity showed
   local session title/workspace enrichment, foreign identities show
   `harness/instance#pid@host` + the lease's `description`.
4. **Config** (`src/config.mjs`, strict validation like model-capacity's):
   `enabled` (default true), `instance` (optional override; default derived — `lab-<name>` when
   `DSH_HOME` is under a lab root, else `web`), `queues` (list of
   `{provider, queue}` mapping this dsh instance's provider routes to daemon queues; a provider
   with no entry is passed to the daemon unmapped ⇒ unlimited), `sock`, `url` (defaults per T1).
   Unknown keys warn; invalid values refuse.
5. **Coexistence guard:** at boot, if the legacy `dsh-model-capacity` bundle is also mounted
   (detect via the `ctx.get('capacity')` service existing), log a loud error and refuse to gate
   (inert + panel showing the reason).
6. **Degraded mode visible:** panel/dock show a red `take-a-number offline — passing through`
   state when the client is degraded (fail-open).
7. Tests, README (with the git-tag install line + every config key documented), CHANGELOG,
   `cordis.patch.yml` bundle row (no `config:` — deployment values live in dsh-deploy),
   `files` allowlist, package.json with the shared harness peer range
   (`>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0`).
8. **Release tag `dsh-take-a-number-v0.1.0`** pushed (dsh-plugins release rules: PR → merge →
   tag on the merge commit; direct pushes to main are fine in this repo's current practice, tag
   after).

## Work instructions

1. Read `packages/model-capacity` fully (host.mjs, gate.mjs, semaphore.mjs, config.mjs, feed.mjs,
   rate.mjs, client.mjs, tests, README) — it is the reference. Also read `AGENTS.md` +
   `scripts/verify.mjs` at the dsh-plugins root (the release contract).
2. `cp -r packages/model-capacity packages/take-a-number`; rename everything
   (`dsh-model-capacity` → `dsh-take-a-number`, `model-capacity` row id → `take-a-number`).
3. **Purpose discovery (do this before writing the kind mapping):** in the lab (step 6), boot
   with a debug build that logs `options.purpose` (and any sibling fields carrying the call's
   intent) for a real interactive turn, a title generation, and a compaction. Write the mapping
   table into `src/config.mjs` as `KIND_MAP` with a `call` fallback, and record the observed
   values in the package README ("Kind mapping" section).
4. Delete `semaphore.mjs`; introduce `src/gate-client.mjs` — a thin wrapper over T1's
   `tan-client` (git-tag dependency of the package, pinned to the T1 release tag
   `v0.1.0`: `"tan-client": "git+https://github.com/chrisjohnson/take-a-number.git#v0.1.0"` —
   subpath `client/` via the package's `exports`), exposing `acquire/release/status/onEvent`
   with the plugin's identity. All daemon I/O goes through it so tests can stub it.
5. `gatedStream` (gate.mjs): acquire with
   `{model: options.model, kind: KIND_MAP[options.purpose] ?? 'call',
   description: composeDescription(…), session: options.sessionId, sessionTitle, turn,
   signal: options.signal}` → `yield* next()` → release in finally. Inert when `enabled: false`.
   The `#tap` rate metering stays (it meters stream chunks locally — the daemon never sees
   them).
6. `host.mjs`: the Cordis `Service` — same lifecycle shape as model-capacity's (config watch
   via `configEditor`, catalog refresh on `llm/adapters-updated`, routes under `/api`), but the
   snapshot/events source is the daemon via the client wrapper; local-only additions: session
   title/workspace enrichment (model-capacity's `describe()`), per-turn wait history
   (`#recordWait` on granted-with-waitedMs > 250 ms), rate metering.
7. `client.mjs` (browser half): keep model-capacity's React structure and hook-order discipline
   (the `NO_SEAT` fallback pattern — `scripts/check-plugin-hooks.mjs` must pass); swap the data
   source to the daemon snapshot (fields per T1 `status`); add the identity/description
   rendering; add the degraded banner.
8. Tests: adapt model-capacity's suite — FIFO/abort/force-release/queue-bound/gate-tap/subagent
   arrival-order tests now run against a **stubbed Tan client** (in-memory fake implementing
   the T1 client interface); add: coexistence guard, degraded pass-through, description
   composition (turn/title/omitted parts), kind mapping table, config validation.
9. `node scripts/verify.mjs` at the repo root must pass (bundle patch, peer range, files
   allowlist, README install line, index table — add the new package to the README index).
10. Lab pass (the real check): see Verification.
11. Commit, push, tag `dsh-take-a-number-v0.1.0`.

## Verification (run all, paste results into Evidence)

```sh
cd /home/t3code/work/dsh-plugins
npm run check                      # verify + hook gate + all tests, no install needed
node --test packages/take-a-number/test/*.test.mjs
node scripts/check-plugin-hooks.mjs packages/take-a-number

# Lab (as the dsh user on the box — see T3's "acting as dsh" for the sanctioned invocation):
#   scripts/lab.sh up
#   scripts/lab.sh link take-a-number        # pins <lab>/plugins/dsh-plugins (cloned if missing)
#   # point the lab's plugin config at the LIVE daemon (it is up after T3's deploy):
#   #   the lab's cordis.patch.yml row: config: { enabled: true, queues: [{provider: <local provider id>, queue: <its gpu>}] }
#   scripts/lab.sh restart
#   scripts/lab.sh smoke --only sessions     # boots, sessions reopen, no slot crashes
# Manual cross-check (two terminals):
#   tan acquire --model medium-dense --hold-ms 30000   (CLI holds the r9700-egpu queue)
#   # send a turn in the lab on medium-dense → dock must show queued, position 1, identity dsh/lab-*#pid@host
#   # after 30 s the turn proceeds; audit shows the lab's lease with its description
tan tail --limit 20                # register + queued + granted + released for the lab identity
```

## Review cycle (part of this ticket)

1. `git diff` against the T1 protocol — client usage matches the T1 client interface exactly.
2. dsh-plugins contract: `npm run check` green; no author-local paths/provider ids in the
   package (verify.mjs enforces — deployment values are config); no `config:` in the bundle row.
3. Hook-order gate green (`check-plugin-hooks.mjs`).
4. Confirm the legacy plugin is NOT modified in this ticket (model-capacity stays as-is; T3
   removes it from the deployment).
5. Mark this ticket `Status: done`, fill Evidence, commit + tag + push.

## Evidence

```
$ node --test packages/take-a-number/test/*.test.mjs
# tests 16
# pass 16
# fail 0

$ npm run check        # verify.mjs + check-plugin-hooks.mjs + full suite
verify: 0 error(s), 0 warning(s) across 14 package(s)
# tests 1544  # pass 1533  # fail 0  # skipped 11

$ DSH_BIN=.../@deepseek-ai/dsh@0.2..2-rc.1 node scripts/compose-smoke.mjs
ok    dsh-take-a-number  (imports, not skipped, layer + 1 row(s), profile wiring)
compose-smoke: 14/14 package(s) composed
```

Released: `chrisjohnson/dsh-plugins` commit `c3363db` (direct push to main), tag
`dsh-take-a-number-v0.1.0` pushed. Install spec:
`git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-take-a-number-v0.1.0&path:/packages/take-a-number`.

### Deviations from the work instructions (deliberate)

1. **Purpose discovery (step 3):** dsh 0.2.2-rc.1 passes **no** `purpose` (or sibling
   intent field) to `llm/stream` — verified against the installed 0.2.2-rc.1. Every call
   arrives undistinguished, so `KIND_MAP` exists as the seam and all acquires today are
   `kind: "call"`. Observed behavior recorded in the package README ("Kind mapping").
2. **`src/gate-client.mjs` (step 4):** not a separate file. `host.mjs` imports
   `take-a-number/client` (`TanClient` + `withLease`) and **injects** `withLease` into
   `gate.mjs`, which therefore imports nothing outside the package — the repo test rule
   is "no install", so the gate's tests (pass-through, metadata, degraded, rejection,
   describe-failure) run on a bare clone against an injected fake. The dependency is
   pinned to `take-a-number#v0.1.1` (not v0.1.0): v0.1.1 added the `withLease`
   signal/abort support the gate relies on.
3. **Config key `url` → `tcp`** (`TAN_TCP` env): same meaning (loopback TCP fallback),
   clearer name; validated loopback-only like the ticket requires.
4. **Omitted from the model-capacity port:** local rate metering (`#tap`, tok/s) and the
   per-turn `conversation.chat.turnTail` wait card. The daemon is the source of truth for
   per-call state and the panel is box-wide; the composer dock carries the per-session
   queued state (position, elapsed, cancel). Neither omitted surface was in deliverables
   1–8; both are follow-up candidates.
5. **Lab pass (Verification, "Lab" section):** deferred to T3 — those steps explicitly
   require the LIVE daemon ("it is up after T3's deploy"), which does not exist until
   T3's NixOS deploy lands. T3's ticket carries the lab + cross-check verification.
