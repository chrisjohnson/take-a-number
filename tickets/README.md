# Tickets — take-a-number

Five tickets, in order. Each is self-contained: an agent with access to this box (user `t3code`),
the three repos (`chrisjohnson/take-a-number`, `chrisjohnson/dsh-plugins`, `chrisjohnson/dsh-deploy`,
`chrisjohnson/local-ai-machine`), and the sudo surface documented in each ticket can complete it
without a human. `PLAN.md` is the architecture reference; where a ticket and the plan disagree,
the ticket wins (tickets are newer).

**Done means:** work complete, verification commands run with the expected results pasted into
the ticket's *Evidence* section, review checklist ticked, ticket committed to `main`.

---

## Conventions shared by all tickets

- **Box user:** `t3code`. Sudo surface (passwordless): `systemctl *`, `journalctl *`, the literal
  `nixos-rebuild switch --flake /etc/nixos#local-ai-machine`, `modelctl *`, scoped docker read
  verbs. No `sudo -u` of any kind — ticket 3 documents the sanctioned way to act as `dsh`.
- **Everything to the box goes through git.** No hand edits on the box, ever.
- **Repos:** direct pushes to `main` are authorized in all four repos (Chris's standing rule).
- **Node:** `/run/current-system/sw/bin/node` (v22). `pnpm` at `/run/current-system/sw/bin/pnpm`.
- **Test runner:** `node --test <dir>` (node's built-in test runner, zero deps, everywhere).
- **The daemon port** is `127.0.0.1:4100` (verified free 2026-11-15). **UDS** is
  `/run/take-a-number/tan.sock`.
- **Live model→GPU map** (read 2026-11-15 from LiteLLM `/model/info` + `modelctl list`; re-verify
  with the commands in ticket 3 before seeding):

  | LiteLLM model | GPU queue |
  |---|---|
  | `small-dense`, `big-moe`, `small-moe`, `image-gen` | `strix-apu` |
  | `medium-dense`, `medium-moe` | `r9700-egpu` |
  | `deepseek-flash` | cloud — never mapped, passes through `unmapped: unlimited` |
