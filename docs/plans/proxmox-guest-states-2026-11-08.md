# Proxmox guest states for after the readiness work

Inventory observed Nov 8 at 2:38 PM EST. The owner approved these states, with
VM 100 changed to automatic on-demand power. VM 180 is now off; the replacement
backup transport reads a hypervisor snapshot without starting it.

| ID | VM | Current | Recommended after work |
|---|---|---|---|
| 100 | st-browser | On | On demand; start for browser work, stop when unused |
| 110 | wfp-target-win11 | Off | Off; start for a Windows test |
| 112 | ominull-target-linux | Off | Off; start for an isolation test |
| 120 | neri-lab | Off | Off; on demand |
| 121 | neri-gitlab | Off | Off; on demand |
| 123 | neri-wordpress-core | Off | Off; on demand |
| 124 | neri-woocommerce-multisite | Off | Off; on demand |
| 125 | neri-workbench | Off | Off; on demand |
| 180 | apps | On | Off after backup and Portfolio verification |
| 200 | agent-work | Off | Off; on demand |
| 201 | neri-hunters | Off | Off; on demand |
| 210 | dadbot | On | On; family service |
| 9000 | ubuntu-2404-cloud | Off | Off; template |
| 9001 | ubuntu-2404-agent-ready | Off | Off; template |

Proxmox also runs these containers:

| ID | Container | Current | Recommended after work |
|---|---|---|---|
| 140 | blackbox-vault | Off at inventory | On with autostart; owner will test separately |
| 150 | ominull-hub | On | On; monitoring hub |
| 160 | restic-append | On | On; backup receiver |
| 170 | opencanary | On | On; monitoring service |
| 190 | aico | On | On; standby Aico |
| 191 | jobinator | On | On; application and scheduler |

BlackBox update: CT 140 was started and its autostart enabled at the owner's
request. Its application health check passed. Other power changes remain after
the active backups and final checks. VM 100 still has autostart enabled until its
automatic on-demand lifecycle is installed and validated.

Fresh inventory before deployment: all listed containers and VM 210 are running with
autostart enabled. All other QEMU guests except VM 100 are off with autostart
disabled. Both templates are off. VM 100 is the only remaining state change;
its helper and both controllers must be deployed and verified first. No guest
currently has a PVE operation lock.
