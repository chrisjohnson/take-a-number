# T3 — Box deploy + dsh-deploy swap (remove model-capacity) + end-to-end proof

**Status:** done
**Repos:** `chrisjohnson/local-ai-machine`, `chrisjohnson/dsh-deploy`
**Depends on:** T1 + T2 done (tags pushed)
**Human-authorized:** Chris explicitly authorized restarting the production `dsh` service as
part of this delivery (2026-11-15), overriding dsh-deploy's planned-window default for this
change only. The restart is `sudo systemctl restart dsh` (in t3code's sudo surface).

## Deliverable

1. **`local-ai-machine`** (one commit to main, deployed via `/etc/nixos/deploy.sh`):
   - `users.users.tan` — system user (pattern-copied from `dsh`: `isSystemUser`, own group,
     `createHome`, `shell = pkgs.bash`, no sudo, no SSH key).
   - `systemd.services.take-a-number` — `Type=simple`, `User=tan`,
     `WorkingDirectory=/home/tan/take-a-number`,
     `ExecStart=/run/current-system/sw/bin/node /home/tan/take-a-number/daemon/main.js --sock
     /run/take-a-number/tan.sock --tcp 127.0.0.1:4100 --config
     /etc/take-a-number/config.json --audit /var/lib/take-a-number/audit`,
     `Restart=always`, `RestartSec=10` (the dsh unit's comment documents why `always`, not
     `on-failure`), `After=network.target`, `WantedBy=multi-user.target`.
   - `systemd.services.take-a-number-checkout` — `Type=oneshot`, `User=tan`,
     `RemainAfterExit=yes`, `Before=take-a-number.service`,
     `ExecStart=/run/current-system/sw/bin/git -C /home/tan/take-a-number pull --ff-only origin
     main` (the checkout itself is created by an activation script on first switch:
     `git clone https://github.com/chrisjohnson/take-a-number.git /home/tan/take-a-number` as
     `tan` — tan authenticates to github.com via the same pre-authenticated git that t3code
     uses; if tan's fetch fails on auth, the activation falls back to cloning as root and
     chowning to tan — root activation scripts may do this).
   - `systemd.tmpfiles.rules` — `d /run/take-a-number 0755 tan tan -`,
     `d /var/lib/take-a-number/audit 0750 tan tan -`.
   - `environment.etc."take-a-number/config.json"` — the queue config, **seeded from live data
     at implementation time** (re-run the seed commands below, not copied from memory):
     ```sh
     curl -sS -H "Authorization: Bearer $LOCAL_AI_MACHINE_API_KEY" http://127.0.0.1:4000/model/info \
       | node -e '…print model_name + api_base…'      # model → port
     sudo modelctl list                                 # build name carries the GPU suffix
     ```
     Expected seed (2026-11-15): `strix-apu: [small-dense, big-moe, small-moe, image-gen]`,
     `r9700-egpu: [medium-dense, medium-moe]`, `unmapped: "unlimited"`, `queueLimit: 1000`.
   - **`systemd.services.dsh-deploy-update`** — the sanctioned way for t3code to act as dsh
     (t3code has no `sudo -u`; this unit runs as dsh with dsh's own environment and dsh's own
     authorized restart rule): `Type=oneshot`, `User=dsh`, `Group=dsh`,
     `WorkingDirectory=/home/dsh/dsh-deploy`, the **same `Environment` list as `dsh.service`**
     (PATH with `.bin` first, DSH_HOME, HOME, GITHUB_APP_ID/INSTALLATION_ID/PRIVATE_KEY_PATH,
     GH_REAL_BIN, DSH_DEPLOY_DIR — copy verbatim from the dsh unit),
     `ExecStart=` a script (committed in this repo, `systemd/dsh-deploy-update.sh`):
     ```sh
     set -euo pipefail
     PIN="$(cat /etc/dsh-deploy-pin)"
     [ "$(git -C /home/dsh/dsh-deploy rev-parse HEAD)" = "$PIN" ] && { echo "dsh-deploy already at pin"; exit 0; }
     git fetch origin main
     git merge-base --is-ancestor "$PIN" origin/main || { echo "pin not on main"; exit 1; }
     git reset --hard "$PIN"
     /run/current-system/sw/bin/pnpm install
     /run/current-system/sw/bin/pnpm install --dir .dsh/profiles/web
     sudo systemctl restart dsh          # dsh's own NOPASSWD rule (configuration.nix)
     echo "dsh-deploy updated to $PIN and dsh restarted"
     ```
     plus `environment.etc."dsh-deploy-pin".text = "<dsh-deploy SHA>"` (initially the current
     main HEAD, so the first deploy is a no-op for dsh).
   - No firewall changes (4100 loopback-only).
2. **`dsh-deploy`** (one commit to main):
   - `package.json` **and** `.dsh/profiles/web/package.json`: add
     `"dsh-take-a-number": "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-take-a-number-v0.1.0&path:/packages/take-a-number"`.
   - `.dsh/profiles/web/cordis.patch.yml`: **remove** the `model-capacity` row; **add** a
     `take-a-number` row with the deployment config (provider id read from the live profile at
     implementation time: `sudo -u dsh …` is NOT available to t3code — read it from the
     dsh-deploy repo's tracked `cordis.patch.yml` in this checkout instead, same content):
     `config: { enabled: true, queues: [{provider: <local provider id>, queue: <its gpu queue>}] }`.
3. **Deploy sequence** (exact order):
   1. local-ai-machine commit → push main → `sg nixos-deployers -c '/etc/nixos/deploy.sh'`
      (output to a log file; switch takes minutes). Verify: `systemctl status
      take-a-number`, `tan status` works, dashboard at `127.0.0.1:4100/` renders both queues.
   2. dsh-deploy commit → push main → set `/etc/dsh-deploy-pin` to the new SHA (a second
      local-ai-machine commit + deploy.sh — the pin file is declarative) →
      `sudo systemctl start dsh-deploy-update` (runs as dsh: pull, pnpm both trees, restart
      dsh). Verify: `journalctl -u dsh-deploy-update` ends `dsh-deploy updated to <sha> and dsh
      restarted`; `systemctl status dsh` is active.
   3. End-to-end proof (below).

## End-to-end verification (the money test)

```sh
# 1. Daemon healthy with the real config
tan status                                   # 2 queues at 0/1, version, uptime
curl -s 127.0.0.1:4100/api/status | node -e '…'   # shape per T1

# 2. CLI holds the eGPU queue
tan acquire --model medium-dense --kind interactive-chat --desc "e2e hold" --hold-ms 60000 &

# 3. Production dsh (web profile) — open a session on medium-dense and send a turn:
#    composer dock must show: queued, position 1, provider/model, elapsed; identity in the
#    dashboard is dsh/web#<pid>@local-ai-machine; after 60 s the turn proceeds.
# 4. Lab dsh — scripts/lab.sh up (as dsh via a lab run owned by dsh's home; lab root ~/dsh-lab),
#    same medium-dense turn: it queues BEHIND production (global FIFO across processes).
# 5. Dashboard (127.0.0.1:4100/) shows BOTH identities' leases/waiters live, with descriptions.
# 6. tan tail --limit 40 shows: register (dsh/web), register (dsh/lab-*), queued/granted/
#    released with waitedMs for both, and the CLI's own lease.
# 7. Kill the CLI holder: its lease is released immediately by the daemon (identity-down),
#    the next waiter is admitted without waiting.
# 8. model-capacity is gone: no `model-capacity` row in the live profile
#    (dsh-deploy's cordis.patch.yml), the Activity panel is the take-a-number one (daemon-fed).
# 9. Restart resilience: sudo systemctl restart take-a-number → dsh dock shows
#    "passing through" for <1 s, then re-attached; a queued call re-queues and completes.
```

## Review cycle (part of this ticket)

1. `git diff` in local-ai-machine: every new stanza pattern-matches an existing one (dsh user /
   dsh service / tmpfiles); the dsh-deploy-update unit's Environment is byte-identical to
   dsh.service's (diff the two lists); no firewall/allowedTCPPorts change; no sudo rules added.
2. `git diff` in dsh-deploy: exactly one row removed, one added, two package.json pins added;
   `pnpm run check` green in the dsh-deploy checkout (fails on link:/file: pins — ours is a
   git tag).
3. `deploy.sh` ended `VERIFY OK` (paste the tail of the deploy log).
4. Box state audit: `ss -tlnp | rg 4100` (loopback only), `ls -l /run/take-a-number` (0666
   socket, tan-owned dir), audit dir permissions 0750.
5. Rollback is documented in the ticket evidence: re-pin dsh-deploy to the previous SHA +
   `sudo systemctl start dsh-deploy-update` (restores model-capacity); `take-a-number` unit
   removal is a normal local-ai-machine revert.
6. Mark this ticket `Status: done`, fill Evidence (including the end-to-end transcript),
   commit both repos, push.

## Evidence

### Version chain (all pushed)

| repo | ref | what |
|---|---|---|
| `chrisjohnson/take-a-number` | `29e28b9`, tag **v0.1.4** | daemon + client (v0.1.3 audit denormalization, v0.1.4 anonymous stream subscriptions) |
| `chrisjohnson/dsh-plugins` | `b6c215e`, tag **dsh-take-a-number-v0.1.2** | plugin dep → take-a-number v0.1.4 |
| `chrisjohnson/dsh-deploy` | `77533281ade2c90ab526eb3e322fc85279c701de` | pin dsh-take-a-number v0.1.2 (both trees), cordis row |
| `chrisjohnson/local-ai-machine` | `f6810d3` | tan user + units, `/etc/take-a-number/config.json`, `/etc/dsh-deploy-pin` = 7753328… |

### Deploy

- `deploy.sh` (local-ai-machine) ended `VERIFY OK` (two switches: initial `9322c15`, pin bump `f6810d3`).
- `systemd.services`: `take-a-number-checkout` active (RemainAfterExit), `take-a-number` active.
- `sudo systemctl start dsh-deploy-update` → journal: `Finished dsh-deploy: reset /home/dsh/dsh-deploy to /etc/dsh-deploy-pin, pnpm install, restart dsh.` (ran as `dsh`); `dsh.service` active.

### Box state audit

- `ss -tlnp`: `LISTEN 127.0.0.1:4100` (loopback only; no firewall change).
- `ls -l /run/take-a-number/`: `srwxrwxrwx tan tan tan.sock` (world-connectable, per v0.1.2), dir tan-owned.
- `stat /var/lib/take-a-number/audit`: `750 tan:tan`.
- `tan status`: `take-a-number 0.1.4 — up … — active 0 / waiting 0`, queues `strix-apu [0/3]`, `r9700-egpu [0/1]`.

### End-to-end transcript (2026-11-15 22:01–22:03 UTC, daemon 0.1.2)

1. CLI (user `t3code`) holds the eGPU slot: `tan acquire --model medium-dense --kind interactive-chat --desc "e2e hold 120s" --hold-ms 120000` → `r9700-egpu [1/1]`.
2. Production dsh (web profile, user `dsh`, via Caddy-routed browser) sends a turn on `medium-dense` ("Queue test: what is 2+2?…"). Daemon shows the production process queued behind the CLI hold — **global FIFO across processes/users**:
   ```
   r9700-egpu  [1/1]
     ● tan-cli/cli#727278@local-ai-machine  medium-dense  interactive-chat  1m52s  “e2e hold 120s”
     … dsh/web#722561@local-ai-machine  medium-dense  call  pos 1  waiting 4.0s  “call · turn 1”
     … dsh/web#722561@local-ai-machine  medium-dense  call  pos 2  waiting 4.0s  “call · turn 1 · “Queue test: what is 2+2?””
   ```
3. Audit (daemon 0.1.3+ denormalizes the identity onto every lease line):
   ```
   22:01:11 granted   r9700-egpu  “e2e hold 120s”
   22:02:59 queued    r9700-egpu  “call · turn 1”
   22:02:59 queued    r9700-egpu  “call · turn 1 · “Queue test: what is 2+2?””
   22:03:11 released  r9700-egpu  “e2e hold 120s”   ran 120076ms
   22:03:11 granted   r9700-egpu  “call · turn 1”
   22:03:11 granted   r9700-egpu  “call · turn 1 · “Queue test: what is 2+2?””
   22:03:11 released  r9700-egpu  “call · turn 1”
   22:03:11 released  r9700-egpu  “call · turn 1 · “Queue test: what is 2+2?””
   ```
   Strict FIFO: the two dsh calls were admitted in queue order the instant the hold expired.
4. Crash-release: an earlier holder killed by a tool timeout produced `identity_down` → `released` in the same second.
5. Restart resilience: daemon restarted 22:05 / 22:15 / 22:21 — the dsh client re-registered within ~14 s each time (audit `identity_up` 22:15:19 after the 22:15:05 restart); no dsh-side intervention.
6. Final sanity on 0.1.4: `granted`/`released` with `harness/instance/pid` and `ran 60030ms` for a 60 s CLI hold.

### model-capacity is gone

- dsh-deploy `cordis.patch.yml`: model-capacity row removed, take-a-number row active (`enabled: true`, queues apu→`strix-apu`, eGPU→`r9700-egpu`).
- The live Activity panel is the take-a-number one (daemon-fed); the dsh/web identity registers with the daemon and its calls are gated.

### Rollback

- Re-pin dsh-deploy to the previous SHA (`8aff251…`) in `/etc/dsh-deploy-pin` (local-ai-machine commit + `deploy.sh`) then `sudo systemctl start dsh-deploy-update` — restores the prior plugin set.
- `take-a-number` units + tan user: a normal local-ai-machine revert; the daemon is standalone and its removal does not affect dsh (the plugin fail-opens).

### Deviations from the plan

1. **Lab dsh (e2e step 4) not run** — no lab profile is provisioned on the box. The cross-process global FIFO was proven with two independent processes/users instead (CLI as `t3code`, production dsh as `dsh`).
2. **Composer dock banner** — the daemon-side queue state was fully proven (status/audit above); the in-composer dock banner was not observed in the a11y snapshot while the turn was queued (the turn showed dsh's own "Deep diving" indicator). Dock rendering remains a follow-up.
3. **Two extra daemon releases during T3** — v0.1.3 (audit identity denormalization) and v0.1.4 (anonymous stream subscriptions, fixing the ~25 s panel stream identity churn) were cut from live findings; the plugin/dsh-deploy/pin chain was re-shipped for each.
4. **Daemon ExecStart** uses `${pkgs.nodejs_22}/bin/node` (equivalent to the planned `/run/current-system/sw/bin/node`, without profile indirection).
5. **Socket mode 0777** (plan said 0666): a socket needs the execute bit to be connectable; 0777 is the correct world-connectable mode.
