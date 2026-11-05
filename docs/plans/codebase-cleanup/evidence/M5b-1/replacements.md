| Stopped unit | Replacement verified live |
| --- | --- |
| gem: nightshift-nightwatch.timer/service | aico-pve-sender.timer/service; local PVE pool, SMART, failed-unit and ECC checks from host-steward; rescue-login probe; independent FCM outage/floor sender |
| gem: nightshift-nightwatch-web.service | Aico Status rows from gem, posted through CT 190 loopback and returned over the workstation heartbeat link; old fallback server retained for rollback |
| workstation: nightshift-check.timer/service | host-steward-check.timer/service; heartbeat no longer depends on the host check pass |
| workstation: nightshift-fcm-token.timer/service | host-steward-fcm-token.timer/service, same key and access-token paths; fresh token copied root-to-root to gem by heartbeat |
| workstation user: nightshift-notify-critical.timer/path/service | Aico Status alert rule and notify outbox in aico-web; root heartbeat carries failed Phone alerts/Push path state to gem for independent FCM delivery |
| workstation: nightshift-runner-critical.timer/path and runner@critical | host-steward-rules.timer/service, after M5b-2 explicitly verified readiness |
| workstation: nightshift-runner-nightly.timer and runner@nightly | host-steward-rules.timer plus Aico jobs and the already-cut-over host-steward acting jobs |
| workstation: nightshift-runner-weekly.timer and runner@weekly | host-steward-rules.timer plus the existing host-steward scrub/NVMe schedules |
| workstation: nightshift-runner-monthly.timer and runner@monthly | host-steward-rules.timer plus the existing host-steward scrub/NVMe schedules |

The existing guest forced command remains /usr/local/sbin/aico-push, now Aico-owned. Caller origins, notice limits and resend windows are data in /etc/aico/pve-sender.json. Existing SSH keys remain unchanged. CT 190 refreshes only its own heartbeat through its push-only key and only while its local Aico Status API responds.

Both sources use a five-minute timer; gem's alarm window stays 45 minutes. A current source prevents the availability alarm. An open outage survives gem reboots and closes only on an actual new healthy heartbeat. A failed phone path has a separate held alarm. All messages use the Aico app's encrypted FCM contract; no Web Push delivery remains in the sender.

Heartbeat link failures and sender failures become failed Status rows, using Aico's existing tray/phone alert path. A stale gem watchdog also fails the independent workstation heartbeat-link row. Source heartbeat rows show ages and warn when missing. Local check failures keep their previous findings and publish a failed check-health row until the next completed pass recovers it.
