# Power-off test

Proves that each host comes back on its own after a power cut, that the other host keeps the owner informed while it is down, and that nothing needs a hand to recover. Run it with the owner, once agent work is idle.

## Setup

- Two Kasa EP40 plugs on the house wifi (Davion), Third-Party Compatibility on in the Kasa app; the router lets the lan side reach only their control port (TCP 9999). Everything is in the shed:
  - Plug `shed`, 192.168.87.217: socket 0 powers the workstation (davion-sidarli), socket 1 powers davion-gem (hostnames davion-gem and aico).
  - Plug `shed-network`, 192.168.87.193: socket 0 powers the shed network gear (Omada, wifi), socket 1 is empty. `aico away` never touches it; the router and the house Omada and wifi are never on a switched socket.
- `aico plug` (settings in packages/ops/data/ops.json, `plug`) reads and switches both plugs from either host and refuses to cut the host it runs on. `aico plug off MACHINE --in SECONDS` sets the plug's own countdown on that socket (so the plug cuts the power later, even if the host is gone by then); `aico plug` shows a pending one as `off in 1 min`; `aico plug cancel MACHINE` takes it away.
- BIOS, set by the owner at each host (required: the Kasa app can only start a host that powers on by itself when power returns):
  - Workstation (Gigabyte B650 AORUS ELITE AX V2): Settings → Platform Power → AC BACK = Always On; ErP = Disabled.
  - davion-gem (Tianbei GEM10): Restore on AC Power Loss (or State after G3) = Power On.
- The Kasa app on the phone switches the plug from anywhere, even with both hosts down.

## Away and start

`aico away MACHINE... | --all [--dry-run]` shuts the hosts down cleanly and cuts their power; the Machines page has the same as **Shut down all**. Start them again from the Kasa app (socket on); the BIOS setting above boots each host by itself.

For each host, davion-gem first and the computer you run it on last (settings: `away` in ops.json):
1. Mark a planned outage for the host (its name, the hostnames the plug settings list, and for davion-gem every Proxmox guest it runs), on this Aico and on the standby Aico (`ssh aico-gem aico away mark ...`). A mark that cannot be placed is reported and does not stop the shutdown.
2. Set the countdown on the host's socket (120 s; davion-gem 300 s, its guests take longer to stop). If the plug refuses, that host is not shut down and its mark is taken back.
3. Shut it down: `sudo -n systemctl poweroff --no-ask-password` here, root ssh `davion-gem` for the Proxmox host (Proxmox stops its guests itself). If the shutdown does not start, the countdown and the mark are taken back, so the plug never cuts a host that is still running.

Before step 1 it checks that every plug answers, every socket is on and each shutdown command can run; if not, nothing changes. `--dry-run` prints the steps and changes nothing (a silent plug is reported, not an error). It runs on the workstation; the standby (CT 190) cannot shut the workstation down.

What the planned outage silences, until the host reports again more than 2 minutes after the mark (a link that only says "disconnected" does not count):
- Status: the host's machine row and all its rows show Off instead of late or unknown, so they never count as problems.
- The phone alert, the tray and the app's problem list: all read those shown rows, so nothing is sent.
- The Machines page: Off since the time of the mark.
- Proxmox's "Aico stopped checking in" alarm: it needs the workstation and the standby both silent for 45 minutes. Away of davion-gem stops that sender with it; away of the workstation alone leaves the standby checking in. The sender needs no change.

## Before each run

1. No agent work running: `aico status` shows no working sessions; nothing queued that must not be interrupted.
2. Backups current: `aico backups` shows no problems.
3. `aico plug` shows both sockets on, from both hosts.
4. Note the time; each step records time to recover and anything that needed a hand.

## Steps

1. **Cut davion-gem (the workstation keeps running)** (from the workstation: `aico plug off davion-gem`). Its guests stop with it, including ominull-hub (OmniNull paging is down until it boots).
   - The phone gets an alert that davion-gem is down.
   - The Machines page shows davion-gem off.
   - After 2 minutes: `aico plug on davion-gem`.
   - It boots by itself; guests set to start at boot come back (`aico machines`); CT 190 Aico answers; ominull-hub pages again.
2. **Cut the workstation (davion-gem keeps running)** (from davion-gem's standby: `ssh aico-gem aico plug off davion-sidarli`, or the Kasa app).
   - The phone gets the alert from davion-gem's standby Aico.
   - The shed network stays up (its own plug).
   - On the phone: the rescue path works and notes are reachable.
   - After 2 minutes: `aico plug on davion-sidarli` from the standby (or the app).
   - It boots by itself (fallback: wake from the network, Wake-on-LAN is on); Aico web, Tether and the jobs come back; sessions that were running show as ended, not lost silently; Status has no unexplained problems.
3. **Away** (workstation): `aico away --all --dry-run`, then `aico away --all` (or **Shut down all** on the Machines page).
   - The phone gets no alert; the standby Aico shows the workstation and davion-gem off (before it goes down itself).
   - Both plugs' countdowns fire after the shutdown: `aico plug` from another computer shows both sockets off.
   - Wait 2 minutes, switch both sockets on in the Kasa app. Both boot by themselves and reach the same state as after steps 1 and 2.
4. **Cut both without warning** (Kasa app on the phone), wait 2 minutes, switch both on from the app. Both boot cleanly and reach the same state. No alert is expected while both are down: both Aico instances and Proxmox's sender are off.

## After

- Record times and findings below; each failed check becomes a fix.
- `aico plug` shows both sockets on.

## Results

(none yet)

## On hold (Nov 7)

The owner paused the test runs. Where it stands:
- `aico away` (and the Machines page **Shut down all**, disabled with the reason) refuses to shut anything down while `away.enabled` in packages/ops/data/ops.json is `false`, which it is now. Set it to true only after the owner confirms the plugs are wired and the BIOS power-on is set. `--dry-run` works either way.
- `aico plug` and `aico away` are built (tests with stubbed plugs and shutdowns only; the countdown rule's field names follow the Kasa protocol and are not yet proven on the real plug). The settings are the layout above; nothing is wired to either plug yet.
- On Nov 7 neither plug answered on TCP 9999 from the workstation (no route to host), so `aico plug` and `aico away --dry-run` could not read them; the dry run prints the steps and says the sockets were not checked.
- Router: fixed addresses and TCP 9999 rules for both plugs (lan → house), nothing else opened.
- The standby (CT 190) gets `aico away mark` and the outage route when the next release reaches it (peer release job); until then the away run reports that it could not mark the standby and goes on.
- Open: the BIOS settings at both hosts, wiring the shed, a first live countdown on one plug, and the test run itself.
