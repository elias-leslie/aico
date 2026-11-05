# Problems left for the coordinator to route

These are retained live reports, not failures silenced by this cleanup. Initial badge: 16. Current badge: 12. The backup lane independently verified its missing-copy proofs and Redis rerun. The swap warning appeared during this work and remains visible.

| Row | State | Plain reason | Current reporter evidence |
|---|---|---|---|
| davion-sidarli/check-tripwire | failed | A sudo policy change still lacks an attributed explanation. | the workstation: Auth config changed (Tue 21:34): /etc/sudoers.d/60-host-steward content. Nothing explains it. Check it, then run: host-steward security-ack --event 85bcaccdea --note WHY. |
| jobs/github-publish | failed | The last nightly publication failed for two projects. | Exited 1: Publication: 2 pushed; 2 failed. |
| davion-sidarli/backup/external/portfolio-ai-complete | failed | The apps VM is off, so its backup owner cannot report a fresh artifact. | The backup owner machine could not be reached; its last artifact date is shown. |
| davion-sidarli/check-trends | failed | The Proxmox storage pool is filling and its trend predicts capacity pressure. | PVE host thin pool: pve/data data 65.2%, +1.11/day, worsening: pve/data data reaches 92.0% in ~24 days. Guests freeze if the pool fills. Free space (discard, snapshot pruning) or grow the pool before then. |
| publish:blackbox | failed | The last local check failed in four gates. | Local check failed at 519ce38b82: browser-e2e, go-tests, osv, webcrypto. Owning agent: fix it and check again. |
| publish:ominull | failed | The published candidate has no successful local acceptance receipt. | Main has no local check at cfbbecee35. Owning agent: run st check --acceptance. |
| davion-sidarli/check-assets | warn | The Windows lab machine has no verified NIC isolation evidence. | fydor-lab-win11 (111) is a lab machine but is not verified isolated: declared isolated, but no NIC evidence. Its tier assumes it cannot reach the LAN. Check its network cards and the PVE firewall. |
| jobs/context-unused | warn | Context usage is unknown for 25 unavailable sessions. | 0 items have no recorded use across at least 3 observed sessions. 1/26 deliveries fully observed; 25 sessions unavailable. |
| davion-sidarli/check-sudo | warn | New sudo commands remain in the host audit window. | 6 new sudo commands: 8, bin/tether, journalctl cloudflared-aico and 3 more. Expected if declared (host-steward or nightshift declare) or run by a known agent; they count as normal after a day. Don't know one? journalctl -t sudo --since -1d -g NAME shows who ran it. Also: Sudo command spikes: btrfs… |
| davion-sidarli/check-workstation | warn | A package update requires a reboot. | A package update wants a reboot. Reboot when the work in flight is done. |
| davion-sidarli/check-perf | warn | Swap is 87% full even though memory is available. | Swap is 87% full while 18 GiB of memory is free. Things run slower than they need to. Check what pinned pages into swap. |
| davion-sidarli/check-probes | warn | Managed local browsers are using workstation memory while the browser VM is off. | 3 agent-driven local Chrome (3.4 GiB); 0 fallbacks from the browser VM to local Chrome in 24h (+55 while the browser VM was off on purpose). Agent browsers belong on the browser VM; local ones eat workstation memory. Check why the browser VM is not answering and close stray local Chrome. |
