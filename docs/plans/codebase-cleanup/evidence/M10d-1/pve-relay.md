# Proxmox Status follow-up

The coordinator observed a healthy Proxmox sender marked Late on the workstation after the main cutover proof. This was a relay deadline bug, not a dropped LAN post or redeployment. The sender posts directly to CT190's loopback API; the workstation fetches those rows through its independent root heartbeat every five minutes. Local web/jobs started at 01:04 EST and Tether at 01:15, before the affected 02:25 run.

The sender's 02:25:28.932 row reached the workstation at 02:28:49.881. Its seven-minute deadline expired at 02:32:28.932. The sender's next run succeeded at 02:30:28.943, but the workstation did not fetch it until 02:33:54.289. A live read at 02:32:50 reproduced the false Late, and the native regression reproduced the same deadline gap before the fix (pve-relay-red.txt).

The sender config now explicitly budgets the workstation relay interval. Row freshness covers one sender interval, one relay interval, and the existing slack. Last-run timestamps remain the original sender timestamps. A separate regression binds the relay budget to the workstation heartbeat's configured interval. Phone outage detection and heartbeat schedules retain their existing contracts.

Installation and live verification are recorded below after the managed checks and committed source are installed on Proxmox.
