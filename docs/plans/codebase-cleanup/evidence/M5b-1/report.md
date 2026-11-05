Commits: 7af66a49, 68e7de1b, 7beb4d19, da3c21ee, 983c325e; evidence 69c08e1a.
Gem runs Aico's pve-sender every five minutes: local PVE/ECC checks, rescue-login probe, independent encrypted FCM, and the existing guest aico-push command.
Workstation and CT 190 send independent five-minute heartbeats; the availability alarm requires both stale beyond the 45-minute window. All eight gem rows show ok on both Aico hosts.
Gem stopped: nightshift-nightwatch.timer/service and nightshift-nightwatch-web.service; Aico sender and Status rows replace them.
Workstation stopped: nightshift-check.timer/service and nightshift-fcm-token.timer/service; host-steward checks, heartbeat and token refresh replace them.
User stopped: nightshift-notify-critical.timer/path/service; Aico's Status alerts and notify outbox replace them, with gem's independent floor sender.
Runner timers stopped: critical, nightly, weekly, monthly, plus runner-critical.path; host-steward rules, Aico jobs and M5a's acting schedules replace them (M5b-2 confirmed readiness).
The final audit was after Nightshift's last pairing-only deployment: all nine Step-B timer/path triggers are disabled and inactive; no further Nightshift deployment is pending.
Live proof: one labelled TEST outage alert; the exact signed phone receipt says shown=true. A repeat tick did not resend it.
Recovery: one signed shown=true receipt after a scratch heartbeat resumed; repeat deduplicated, zero open alarms, two accepted events total. Test scratch removed.
A forced host-steward token mint reached gem with the same mint timestamp; existing secret paths remain in use and nothing secret was printed.
Checks: quick passes; before acceptance passed at b11fbc46, after passed at 48de5a70 and again at 916495d7 after the live machine-row fix. Required Codex review findings have failing-then-passing regressions.
Rollback: rollback.md restores the archived root code, retained old units and gem's saved push wrapper before restarting Nightshift. Pairing-only legacy web is M5b-2's remaining service.
Remaining: None within the agreed scope.
