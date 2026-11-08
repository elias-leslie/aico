# Power-off test

Proves that each host comes back on its own after a power cut, that the other host keeps the owner informed while it is down, and that nothing needs a hand to recover. Run it with the owner, once agent work is idle.

**Owner, Nov 8: the Kasa plugs are not plugged in and won't be; the kids can power things on if asked. The owner skipped this test.** So a real power cut has never been run. The plug steps further down (and `aico plug`, `aico away`, **Shut down all**) describe what was built and stay off.

## The short run, if it's ever wanted

1. Gem BIOS: Restore on AC Power Loss = Power On. Pull its power for 30 seconds and put it back without touching the button. It starts by itself; Aico, Ominull, Jobinator and Dadbot are back within about 3 minutes with no help. Portfolio stays off (Autostart off).
2. Workstation BIOS, only to wake it from the phone: ErP = Disabled, AC BACK = Always On. From the phone on mobile data: Machines > Workstation > Shut down, then Power on. If it doesn't wake, someone presses the button; it comes back with no login.
3. A frozen box has no remote fix: someone holds its button for 5 seconds, then presses it once.

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

`aico power on|off|state davion-sidarli` is the workstation's own power from either Aico, and it's what the Machines page's Power on and Shut down use. On: its plug socket if the plug answers, and always the Wake-on-LAN packet (MAC and broadcast in `power`, data/ops.json). Off: runs on the workstation (over ssh from the standby): sessions save their place (`tether reboot prepare`), the outage is marked on every Aico, then a clean poweroff. It needs no plug and no `away.enabled`, and nothing cuts the power. The standby's Tether entry for the workstation (`~/.config/tether/hosts.json` on CT 190) names `aico power on` and `aico power state`, so the standby shows it off and can start it. `aico power units` and `aico power restart UNIT [--on MACHINE]` are the services on the same page.

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

### Nov 8: workstation cut off by firewall (no power cut)

Six cuts of 2 to 5 minutes, with the workstation's connector stopped, so the standby saw what it would see with the workstation off.

- Address: the standby's connector was on within about 46 s and off again about 2 minutes after the workstation came back.
- Quiet: no notice on either Aico, from any cut or any return.
- Standby: Status 3 to 7 problems, none of them about the workstation being off. Real `/v1/ask` from Jobinator answered in about 4 s. Test push went out through the Proxmox relay (outbox sent; the phone itself not seen).
- `aico power state davion-sidarli` reads off from the standby within 2 minutes. `tether hosts` can say connected for up to 5 minutes.
- CT 190 rebooted once: Tether restored the Antigravity session in 6 s, it resumed and answered a message. kill-server is refused on the real server there; the server's OOM score is 0 (the container can't go lower, the workstation gets -500).
- CT 191 and CT 170 rebooted with no help. VM 180 stays off after a gem boot (Autostart off, the owner's choice).

Found and fixed along the way: a stuck fleet link, a repo copy row that stayed Failed, caretaker reading late while the standby stood in, routines of an off machine showing red, two "Workstation" choices in the new-session dialog.

Not proven: starting the workstation from off (a magic packet reaches its card), gem restarting itself after a power cut (BIOS setting can't be read from Linux), the plugs (neither answers). Those need the owner: test 1 and test 2 in the Aico ask.

### After the owner's run, also check

- `tether reboot status`: sessions restored, none failed or stuck pending.
- Each resumed agent's first prompt says the machine went down and is true about whether it was working.
- Text sent to a throwaway session seconds before the cut comes back under "Sent to you before the crash", and `~/.local/state/tether/default/pending-input` is empty afterwards.
- aico-web and tether@default come up with no restart loop, and their stores open.
- No deploy record stuck running under `~/.local/state/aico/deploys`, no leftover `.git/index.lock` in project checkouts.

## On hold (Nov 7)

The owner paused the test runs. Where it stands:
- `aico away` (and the Machines page **Shut down all**, disabled with the reason) refuses to shut anything down while `away.enabled` in packages/ops/data/ops.json is `false`, which it is now. Set it to true only after the owner confirms the plugs are wired and the BIOS power-on is set. `--dry-run` works either way.
- `aico plug` and `aico away` are built (tests with stubbed plugs and shutdowns only; the countdown rule's field names follow the Kasa protocol and are not yet proven on the real plug). The settings are the layout above; nothing is wired to either plug yet.
- On Nov 7 and Nov 8 neither plug answered on TCP 9999 (no route to host), so `aico plug` and `aico away --dry-run` could not read them; the dry run prints the steps and says the sockets were not checked.
- Router: fixed addresses and TCP 9999 rules for both plugs (lan → house), nothing else opened.
- The standby (CT 190) gets `aico away mark` and the outage route when the next release reaches it (peer release job); until then the away run reports that it could not mark the standby and goes on.
- Open: the BIOS settings at both hosts, wiring the shed, a first live countdown on one plug, and the test run itself.
