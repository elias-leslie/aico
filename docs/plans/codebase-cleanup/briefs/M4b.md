# M4b brief (builder: Sonnet 5.5 high, native subagent). Part 2 of 2 of M4: the phone app.

Goal: the Nightshift Android app becomes the Aico phone app in `/srv/workspaces/projects/aico/native/android` (Kotlin). It keeps FCM decrypt, the outage alarm and the updater, and reads Aico instead of Nightshift's web backend.

Read first:
- `docs/plans/codebase-cleanup/cutlist.md`: 1.1 (native table: `native/android`), the 2.3 row ns-06, and the M4 row in section 4.
- `plan.md`, decisions of 2026-11-03: owner alerts go only through the Aico phone app (FCM), and the Proxmox sender covers the times the workstation is down.
- Source to port: `/srv/workspaces/projects/nightshift/android`, especially:
  - `net/ApiClient.kt`, `Sync.kt`, `Act.kt` and `LiveFeed.kt`;
  - `alarm/OutageAlarm.kt` and `OutageRule.kt`;
  - `update/Updater.kt`.
- The backend it calls today: Nightshift's `/api/app/*` (`notify/fcm.py` around 640-680 for health; find the rest).
- Aico's sender: `packages/notify` (M3). It already sends FCM in the format the app decrypts.

Scope:
1. Copy the app into `native/android`. Keep the applicationId, so it updates in place and keeps its pairing and FCM registration; change only the shown name and icon to Aico (Lantern tokens). If keeping the id is impossible, stop and report, because re-pairing needs the owner.
2. Point the app's API at Aico. Put the app endpoints the app uses (health, sync, act, acks, live feed, update manifest and APK) on aico-web, built from Status, notify and Needs you. Reach them the way the app reaches Nightshift today: through Cloudflare, access only. Find out how and use Aico's existing public hostname.
3. The outage alarm reads Aico's health, which is fresh when aico-web and the host checks are reporting, not Nightshift's `findings-pass.json`. Keep its two-probe rule.
4. Build a signed APK with the existing signing setup, the same way Nightshift builds it. Never print, copy or read the keystore or its passwords yourself; gradle uses them.
5. Serve the update so the phone's updater offers it. Installing needs a tap on the phone, so file one Aico Needs-you ask for that tap (`tether ask create`) and continue meanwhile.
6. Kotlin tests run in a native stage (`gradle test` when `native/android/**` changes; cutlist 1.4).

Proof:
- `gradle test` and `st check --quick --changed-only` pass.
- curl each new endpoint and get answers in the shape the app expects.
- After the owner installs the update, the app shows Aico's problems, an alert from Aico arrives and opens, and the outage alarm stays quiet while Aico is fresh.
- Before that tap, prove the APK and the endpoints with the existing tests, and report the install as waiting on the owner.

Rules:
- Commit with `st commit -m "..." --paths <files>`; end with "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>".
- Hold leases. M4a ports the tray at the same time, and others are in packages/web-server status files and native/host-steward.
- Never git stash, reset, checkout or rebase. Never open the neri repo or Neri data. Never read credentials, .env or key files.
- Nothing reaches our hosts from the internet except through Cloudflare.
- If the port needs a design call, stop and report.

Report (≤20 lines): commits, LOC, the endpoints, the APK version, the ask id, tests, and what still runs on Nightshift.
