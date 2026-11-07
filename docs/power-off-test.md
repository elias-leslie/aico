# Power-off test

Proves that each host comes back on its own after a power cut, that the other host keeps the owner informed while it is down, and that nothing needs a hand to recover. Run it with the owner, once agent work is idle.

## Setup

- Two Kasa EP40 plugs on the house wifi (Davion), Third-Party Compatibility on in the Kasa app; the router lets the lan side reach only their control port (TCP 9999):
  - Shed plug, 192.168.87.217: socket 0 powers the whole shed strip (workstation, shed Omada, shed wifi, monitor); socket 1 empty.
  - House plug, 192.168.87.193: socket 0 powers davion-gem, which sits in the house on the house Omada unit's spare port; socket 1 empty. The router, Omada units and Google wifi are never on a switched socket.
- `aico plug` (settings in packages/ops/data/ops.json) reads and switches both plugs from either host and refuses to cut the host it runs on.
- BIOS, set by the owner at each host:
  - Workstation (Gigabyte B650 AORUS ELITE AX V2): Settings → Platform Power → AC BACK = Always On; ErP = Disabled.
  - davion-gem (Tianbei GEM10): Restore on AC Power Loss (or State after G3) = Power On.
- The Kasa app on the phone switches the plug from anywhere, even with both hosts down.

## Before each run

1. No agent work running: `aico status` shows no working sessions; nothing queued that must not be interrupted.
2. Backups current: `aico backups` shows no problems.
3. `aico plug` shows both sockets on, from both hosts.
4. Note the time; each step records time to recover and anything that needed a hand.

## Steps

1. **Cut davion-gem (the house keeps running)** (from the workstation: `aico plug off davion-gem`). Its guests stop with it, including ominull-hub (OmniNull paging is down until it boots).
   - The phone gets an alert that davion-gem is down.
   - The Machines page shows davion-gem off.
   - After 2 minutes: `aico plug on davion-gem`.
   - It boots by itself; guests set to start at boot come back (`aico machines`); CT 190 Aico answers; ominull-hub pages again.
2. **Cut the shed strip (workstation, shed network; davion-gem keeps running)** (from davion-gem's standby: `ssh aico-gem aico plug off davion-sidarli`, or the Kasa app).
   - The phone gets the alert from davion-gem's standby Aico.
   - The shed Omada and wifi come back by themselves with the strip.
   - On the phone: the rescue path works and notes are reachable.
   - After 2 minutes: `aico plug on davion-sidarli` from the standby (or the app).
   - It boots by itself (fallback: wake from the network, Wake-on-LAN is on); Aico web, Tether and the jobs come back; sessions that were running show as ended, not lost silently; Status has no unexplained problems.
3. **Cut both** (Kasa app on the phone), wait 2 minutes, switch both on from the app.
   - Both boot by themselves and reach the same state as after steps 1 and 2.

## After

- Record times and findings below; each failed check becomes a fix.
- `aico plug` shows both sockets on.

## Results

(none yet)
