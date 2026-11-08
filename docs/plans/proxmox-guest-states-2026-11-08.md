# Proxmox guest states after readiness work

Observed Nov 8 after the controlled gem reboot and live browser test. All states
below follow the owner's choices. VM 180 was renamed and resized by the Portfolio
agent, which deliberately left it off. Memory is in GiB.

| ID | VM | Cores | Memory | State | Autostart | Intended use |
|---|---|---:|---:|---|---|---|
| 100 | st-browser | 4 | 8 | Off | No | Starts for agent browser work; stops when unused |
| 110 | wfp-target-win11 | 4 | 6 | Off | No | Windows tests on demand |
| 112 | ominull-target-linux | 2 | 2 | Off | No | Isolation tests on demand |
| 120 | neri-lab | 4 | 4 | Off | No | On demand |
| 121 | neri-gitlab | 4 | 8 | Off | No | On demand |
| 123 | neri-wordpress-core | 2 | 4 | Off | No | On demand |
| 124 | neri-woocommerce-multisite | 2 | 2 | Off | No | On demand |
| 125 | neri-workbench | 2 | 2 | Off | No | On demand |
| 180 | portfolio-ai | 4 | 6 | Off | No | Owner's Portfolio work on demand |
| 200 | agent-work | 8 | 16 | Off | No | On demand |
| 201 | neri-hunters | 6 | 12 | Off | No | On demand |
| 210 | dadbot | 2 | 2 | On | Yes | Family service |
| 9000 | ubuntu-2404-cloud | 2 | 2 | Off | No | Template |
| 9001 | ubuntu-2404-agent-ready | 2 | 2 | Off | No | Template |

| ID | Container | Cores | Memory | State | Autostart | Intended use |
|---|---|---:|---:|---|---|---|
| 140 | blackbox-vault | 2 | 1 | On | Yes | Owner requested; separate BlackBox test planned |
| 150 | ominull-hub | 2 | 1 | On | Yes | Monitoring hub |
| 160 | restic-append | 2 | 1 | On | Yes | Backup receiver |
| 170 | opencanary | 1 | 0.5 | On | Yes | Monitoring service |
| 190 | aico | 2 | 10 | On | Yes | Standby Aico |
| 191 | jobinator | 2 | 2 | On | Yes | Application and scheduler; AI remains paused |

VM 100's live two-controller test proved it starts for browser work, remains on
while the other controller still has a session, and stops after the final close
and reap. No manual power action was used in that retest. Further user shakedown
may start it again temporarily; leave it off when all test sessions are closed.

The controlled reboot proved recovery of the listed always-on guests. It does
not prove automatic startup after loss of mains power; the owner skipped the
unwired smart-plug test. Do not turn that into a recurring new owner ask.
