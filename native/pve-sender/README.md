# Local backup thermal guard

`aico-backup-guard` runs as root on PVE independently of Aico, the workstation and agents.
The PVE sender installer copies its policy to `/etc/aico/backup-guard.json`, installs
`aico-backup.slice` and enables `aico-backup-guard.service`. Existing policy is preserved.

The daemon discovers `k10temp`'s `Tctl` input once, then reads that one local sysfs file
every 15 seconds. A missing input causes rediscovery. There are no remote probes,
GPU commands, process scans or persistent writes on normal ticks. The heartbeat is
an atomic write in `/run/aico-backup-guard/status.json`; policy and mode transitions
go to `/var/lib/aico/backup-guard/state.json`. It does not send alerts itself.

Policy starts at an aggregate CPU quota of 50% of one logical CPU for managed host
exports. Two consecutive samples at or above 85 C close admission and reduce the
quota to 20%; 90 C does so immediately at 10%. A fresh valid sample at or below
80 C restores admission and the normal quota. These are control thresholds below
the AMD 6800H's 95 C maximum, not replacements for the separate thermal monitor.
A missing sensor blocks admission while retaining the last CPU ceiling. A heartbeat
older than 45 seconds or from another boot also blocks admission. No VM, production
process or agent is stopped, paused or killed. The existing OOM controls are separate.

The host dispatcher must wrap the actual export process (including its cleanup):

```
/usr/local/sbin/aico-backup-guard run -- /usr/local/sbin/summitflow-pve-backup --guarded-capture SOURCE DIGEST
```

Standard output is the export stream. Exit 75 means admission was deferred. A flock
holds the host-wide export slot, and the fixed `aico-backup-export.scope` name
independently prevents overlapping jobs if the caller disappears while an export
remains. `systemd-run --scope` puts the actual host command and descendants under
the slice; wrapping an SSH client cannot constrain work inside a guest. Guest
exporters need their own guest-local quota.

On startup the guard reapplies the saved limit, obtains a fresh local sensor reading
and only then publishes a heartbeat. A saved hot or critical limit remains until
a fresh recovery reading; downtime never counts as cooling evidence. Mode and heat
episode identity survive restarts. An episode is opened at the first hot/critical
transition or unavailable sensor and records its peak level and recovery time.
Every new sensor or heat incident gets a unique persisted episode ID, including
repeated outages on the same boot. Returning heat or recovery readings retain
that identity so pending notices can close. Shared notice metadata also preserves
fallback sensor episodes detected while the daemon is absent or stale.

The runtime snapshot contains `mode`, `limit_mode`, `temperature_c`, `observed_at`,
`boot_id`, `admission_open`, `cpu_quota_percent`, `policy` and optional
`episode: {id, started_at, peak_mode, ended_at?}`. Each incident phase change queues
one dedicated `check-backup-guard` row to a lightweight publisher thread using the
existing PVE sender `status_command`. Critical and recovery rows are both kept
even if the incident ends between five-minute checks. A blocked or failed post
does not delay local enforcement; the existing periodic sender reconciles the
same row. There are no every-sample posts, remote probes or new phone path.
The PVE sender evaluates other thermal sensors against its already collected
local hwmon section. Fresh valid guard evidence owns CPU notices; when that
evidence is unavailable or stale, the ordinary CPU thermal check remains active.
`aico-backup-guard budget` returns `{quotaPercent, admit, sampleSeconds}` without
claiming a slot. A guest monitor reads the runtime snapshot locally and changes
only its named guest export scope when the CPU budget changes; it must not SSH on
each sample. `delivery_machine` in policy selects the Aico instance that delivers
typed guard episodes; it currently names CT 190's `aico` instance.

Verification is synthetic: `st check pytest -- native/host-steward/tests/test_backup_guard.py
native/host-steward/tests/test_pve_sender.py`. No heater, full backup or live service
restart is needed for these tests.
`python3 -I native/pve-sender/benchmark-guard.py` reports synthetic CPU time per
sample and current process RSS using only temporary files in `/dev/shm`. It does
not measure a deployed service or exercise real cgroups.
