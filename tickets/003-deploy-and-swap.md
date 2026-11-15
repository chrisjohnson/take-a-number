# T3 — Box deploy + dsh-deploy swap (remove model-capacity) + end-to-end proof

**Status:** pending
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

(paste verification output + e2e transcript here before marking done)
