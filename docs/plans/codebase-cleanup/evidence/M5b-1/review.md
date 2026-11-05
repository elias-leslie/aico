The required independent Codex review found six original defects and two defects in the added token refresh/route sync. Each was reproduced with a failing regression before its fix. A second review confirmed the original six fixes by inspection. No real keys or phone data were used in review tests.

- A stale failed floor heartbeat could claim recovery. An open floor alarm now waits for a fresh healthy heartbeat.
- Partial FCM success could repeat messages on the healthy phone. Stable delivery ids and per-device receipts now retry only recipients that have not accepted a message.
- A powered-off workstation could cause a rescue-login alarm. The probe now distinguishes an unreachable host from a reachable host refusing SSH and from an unusable home folder.
- The heartbeat referenced an old phone-alert row id. It now reads the actual notify-outbox row.
- A gem reboot could falsely recover then repeat an outage. An existing outage remains open until a source has actually refreshed its heartbeat.
- A recovered local check could leave its old failed row behind. Every completed local pass now posts an ok health row with the same id.
- A malformed phone registry member could stop the independent heartbeat. Route-sync failures now leave the host heartbeat running and report the link failure.
- A malformed cached token expiration could escape before any Status row. It is now treated as stale, and refresh failures still report a failed row while retaining the previous token.

Additional regression checks found and fixed guest deduplication incorrectly spanning Portfolio-AI’s configured resend window, heartbeat contention with slow host probes, and stale production-path assumptions in the floor collector tests.

The final live view exposed a missing gem machine heartbeat row. A failing contract regression and the 983c325e fix now keep the sender visible as its real shown state; all eight gem rows were then verified as shown=ok on the workstation and CT 190. Full acceptance passed again with this fix in source 916495d7.
