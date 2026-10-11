# Changelog

## Unreleased

Requires Tether API v1. Install and start Tether (`tether@default`) before Aico.

### Changed

- Aico is now a client of Tether, the per-user session daemon. Tether owns
  tmux servers, panes, agent launch and admission, End, roots and context hooks,
  and serves the legacy `/run/user/<uid>/aico/{control,gui-control}.sock`
  sockets for `st aico` and SummitFlow. Aico connects over Tether's API v1
  (`TETHER_SOCKET`, else `$XDG_RUNTIME_DIR/tether/${TETHER_INSTANCE:-default}/control.sock`),
  checks the API version, follows `/v1/events` with reconnect and gap resync,
  and holds the GUI channel for show, position and title.
- `aico.db` now keeps only `views` (window geometry, open state, local name
  override per session ID) and `settings`. On first start the views are
  migrated from the old `widgets` table, which is left untouched as a backup.
- The session list shows every Tether session (Aico, A-Term, CLI and root
  origins), plus A-Term's pre-Tether `summitflow-<uuid>` sessions, which open
  attach-only. The separate A-Term federation is gone.
- Window focus claims the tmux window size through Tether's resize claim;
  desktop auto-resize is unchanged.
- `scripts/aico-install.sh` requires Tether API v1 or later and no longer
  installs `aico-owner.service` or the context hooks.
- `st aico ... --surface a-term` accepts the Tether-shaped root descriptors that
  A-Term's `/v1/roots` proxy now returns.

### Removed

- The in-process lifecycle owner, `aico-owner.service`, the owner bundle, the
  lifecycle harness, the real-session smoke, `qualify-codex-admin.py`, the
  context-hook installer and `npm run check:context` (all now in Tether, or
  retired with the code they checked).
- Agent admission environment variables (`AICO_AGENT_*`); admission is
  configured in Tether.
- The titlebar context-mandate badge; Tether has no route for it yet (see
  `docs/tether-api-gaps.md`).
