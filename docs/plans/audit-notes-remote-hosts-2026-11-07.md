# Audit: notes-and-capture.md and remote-hosts.md against what runs today (2026-11-07)

Method: read both plans in full; every claim, including every "shipped" note, was treated as unverified. Checked code in `packages/`, the live Aico web on the workstation (127.0.0.1:3002 and `/api`), the `aico`, `tether` and `st` CLIs, both `notes.db` files (counts, ids, timestamps and metadata only, no note text), CT 190 over `ssh aico-gem`, and the Proxmox host over `ssh davion-gem` (read only). Nothing was changed, started or deployed. No Neri case data was read.

Status words: **done** (built and checked), **partly**, **missing**, **contradicted** (built differently from the plan), **obsolete** (superseded by a later owner decision or a retirement).

"Plan" below is `notes-and-capture.md` (N) or `remote-hosts.md` (R); numbers are plan line numbers. Package paths are today's (`packages/...`), not the ones the plan names (the 2026-11-03 restructure moved them).

## 1. What I verified live (the key evidence)

**Sync between the workstation and CT 190 works and is converged.** Read-only checks at 20:09-20:13 UTC:

- `GET /api/sync/status` on both hosts: state `ok`, last sync seconds old, skew 22 ms / -1 ms, `buildMismatch: false` (same release).
- `notes.db` meta: workstation `seq` 947, gem's cursor for it 947; gem `seq` 711, workstation's cursor for it 711. Both schema 5.
- Row-for-row: a SHA-256 over `(id, updated_at, deleted)` for each of captures, notes, note_items, note_labels, attachments, note_revisions is **identical on both hosts** (31, 107, 350, 43, 6, 14 rows). `web.db` view state matches too (panes 67, links 75, settings 11, seen 303), schema 3 on both, cursors current.
- Transport is the fleet link, not ssh: `/run/user/1000/aico/fleet/aico/sync.sock` (workstation) and `.../fleet/davion-sidarli/sync.sock` (gem) exist; both hosts listen on 7449 (192.168.86.128, 192.168.86.59); gem's journal shows `sync davion-sidarli: pulled 1 change(s)` through 20:07:14.
- The one live attachment (Groceries photo) has its blob on both hosts. The other 4 attachment rows belong to deleted notes; their blobs are gone, as designed. The workstation holds 11 more blob files than gem (all still referenced by deleted captures; sync only copies blobs a live row needs, and the 7-day grace has not passed).
- Counts: 107 notes rows, 42 deleted, 65 live (36 `summitflow:`, 22 `keep:`, 1 `aico:groceries`, 6 hand-made); API reports 60 unarchived + 5 archived = 65. 31 captures rows, all 31 deleted (test data; no live captures). 20 prompts, 2 lists.
- Drive export: gem's journal shows `uploaded ... 63/64/65 notes` on Nov 5/6/7 at 03:30. `rclone lsf` (names counted, not read) on `SummitFlow-Notes`: 65 note files, `photos/`, `captures.md` = 67 files, matching the 65 live notes.
- Both Aico doors answer: gem sets `X-Aico-Host: gem`; public `aico.summitflow.dev` (via `--resolve`) and `app.summitflow.dev` both redirect to Cloudflare Access (302) for the page and `/api`. This workstation's own resolver sends `aico.summitflow.dev` to 127.0.0.1 (the plan's "every machine serves itself"), which is why it answers 200 here.
- `st aico placement --needs mem=6G,cpu=2` answers `local` fits; `--pool neri-hunt` answers `neri-hunters` (powered off, would be started). It reads the Proxmox node over `ssh davion-gem`.
- `aico status`: Notes export row OK ("aico is linked and does the nightly export"); "Aico on CT 190 heartbeat" OK; restore drill of 2026-11-05 served matching sessions, notes and Logins.

**Not verifiable now:** agent-work and neri-hunters are powered off (no route), VM 180 is off, and the phone itself. Anything that needs those is marked "code and tests only" below.

## 2. Counts

Totals are in section 5 (103 items: 72 from the notes plan, 31 from the remote-hosts plan).

## 3. notes-and-capture.md

| # | Plan | Commitment | Status | Evidence / note |
|---|---|---|---|---|
| N1 | 3 | "Status: design, nothing built" | contradicted | Header is stale; lines 142-312 record M2-M9 as shipped. Doc fix, small. Not in ROADMAP. |
| N2 | 7 | Capture button on the phone (photo or files, caption, send) | done | `CaptureLauncher` mounted in `Rail`, `Panel`, `SessionSwitcher`, `EmptySessionState`, `UnifiedTerminalHeaderContent` (the plan's SessionSidebar became Rail/Panel); `/captures` 200; manifest shortcuts Groceries and Notes. |
| N3 | 8, 316-364 | Agent asks for files: `tether ask create --files N\|MIN-MAX --files-hint` | done | `tether ask create --help` shows flags and aliases; schema v30 at `packages/tether/src/schema.ts:771`; `files_not_requested` at `asks.ts:1086`; card in `AskFiles.tsx`, `AskCard.tsx:96`; tests in `asks.test.ts`, `NeedsYou.test.tsx`. Not exercised live this audit. |
| N4 | 349-357 | Ask-card state table (idle, uploading, failed, partial, closed...) | partly | All states exist in `AskFiles.tsx` / `AskCard.tsx`; wording differs from the table (e.g. "1 file didn't upload. Retry it or remove it." vs "won't be sent"). Cosmetic. |
| N5 | 9 | Captures list plus a real Notes feature (text, checklists, recipes, labels, search) | done | `/api/notes` 65 live; routes at `packages/web-server/src/notes.ts:280-456`; FTS5 in `notes-data.ts:186`; screens in `components/notes/`. |
| N6 | 10, 432 | Photo text read in the background; only the origin host reads | done | `extract-worker.ts`; rows show `extract_route=agy` for 17 captures across all three origins; `status=ready/filed`. No live captures now to watch. |
| N7 | 11, 464-472 | Same app on two hosts, own data each, synced both ways | done | Section 1. |
| N8 | 15, 483-485 | CT 190 `aico` on davion-gem | done | `aico machines`: VMID 190 running, boots at start; user units `aico-web`, `aico-jobs`, `tether@default`, `cloudflared-aico` active; Node 24.14.1; `heif-convert`, `rclone`, `agy` present. |
| N9 | 16 | `notes.db` + hash-named blob folder beside `web.db` | done | `~/.local/state/aico/notes.db` (0600, WAL), `blobs/<2 hex>/<hash>`. |
| N10 | 17, 402-413 | Sync rides the Tether link's ssh connection (`-L` forward) | obsolete | Owner fleet-link decision (plan.md decisions log, "Aico fleet"; plan line 415 anticipates it). Today `packages/fleet` proxies `sync.sock` over TLS 7449; `linkArgv`/`tether-link@` are gone (`scripts/install.sh:169` removes the unit). The `/sync/*` socket API is unchanged (`sync/server.ts:35-62`). |
| N11 | 18 | Every write stamped for sync from Milestone 1 | done | Sync columns on every table; hashes identical across hosts. |
| N12 | 19, 99, 123-129 | `tether capture ...` and `tether note ...` thin HTTP clients | done | `tether capture --help` (list, get, file, result), `tether note --help`; code in `packages/tether/src/capture-cli.ts`, `note-cli.ts`; exit 3 while reading at `capture-cli.ts:289`. |
| N13 | 128, 123 | `tether capture file ID --out DIR` from a session on another host via `forwards` in hosts.json | contradicted | Help text and `capture-cli.ts:25` still tell users to add port 3002 to `forwards`, but nothing reads `forwards` (see R4). A session on a worker VM cannot download as described. Small-medium. Not in ROADMAP. |
| N14 | 20, 119-120 | 25 MB / 20 files; HEIC stored as sent | done | `GET /api/captures/limits` returns 26214400 and 20; `config.ts:212`. |
| N15 | 20, 120 | HEIC preview, long edge 2000 px | partly | `heic.ts:48` runs `heif-convert -q 85` with no resize (plan.md line 453 admitted "full-size for now"). Preview works; the size cap is missing. Small. Not in ROADMAP. |
| N16 | 24-37 | Durable storage in the data dir, not `~/aico-uploads`; backup coverage | done | `/home recovery · T7` OK; `Aico databases and photos · Drive` OK. |
| N17 | 36, 501-507 | Backup row for CT 190 (`pve-ct-190-aico-data`) so gem edits made while the workstation is off are covered | contradicted | Today's row is "Aico on gem · databases and photos · Drive": "Copied from gem by the workstation; **no Drive copy runs while the workstation is off**", data 12 h old, daily 02:30. The plan's stated purpose (gem disk fails while the workstation is off) is not covered by that row. Mitigations that exist: gem's own hourly snapshots (`aico-state-snapshot.timer`, plan said 4 h) and gem's nightly Drive export. A restore drill passed 2026-11-05. Medium. Not in ROADMAP. |
| N18 | 42-73 | Schema v1 (captures, sync columns, indexes); later migrations add extract/route/notes | done | Schema 5 on both hosts; counts above. |
| N19 | 75-97 | File list (`notes-db.ts`, `hlc.ts`, `blobs.ts`, `capture-files.ts`, `heic.ts`, `captures.ts`, pages and hooks) | done | All exist, relocated: `hlc.ts` in `packages/shared/src/`, `blobs.ts`, `capture-files.ts`, `heic.ts` in `packages/notes/src/`, upload queue in `lib/capture-queue.ts` instead of `use-capture-upload.ts`. |
| N20 | 97 | Thumbnail made in the browser, 480 px, under 256 KB | done | `lib/capture-thumb.ts:5-6`. |
| N21 | 101-115 | Endpoint table and plain-word errors (413/415/429/409) | done | All routes at `captures.ts:285-445` plus `/route`; messages at `:241,:353,:409`; 60/min `RateLimiter`; cache headers `:57,:178-179`. |
| N22 | 117-121 | Accepted types incl. HEIC, PDF, docs, audio; data table | done | `capture-file-types.json`; limits API lists jpg, png, gif, webp, heic, heif, pdf, txt, md, csv, json, docx, xlsx, odt, ods, m4a, mp3, ogg, webm, wav. |
| N23 | 131-140 | Milestone 1 tests | done | `captures.test.ts`, `notes-db.test.ts`, `hlc.test.ts`, `capture-files.test.ts`, `capture-cli.test.ts`, `CapturePicker/CaptureSheet/CaptureLauncher/CaptureList/CaptureDetail` tests all exist. Not re-run (read-only audit). |
| N24 | 140, plan.md 453 | Live check on the phone PWA: take a photo, choose files including HEIC and PDF | partly | Headless phone-size check recorded; owner confirmed Photos multi-select (plan.md decisions log). A real iPhone HEIC through Safari is still listed as untried and I cannot test it. |
| N25 | 145 | Vision routes `agy` then `ollama`, env config, concurrency 2 | done | Defaults at `config.ts:245-249`; agy route used by captures on both hosts. |
| N26 | 150-152 | agy reads PDFs and audio directly; no separate STT | done | Recorded live check; `capture-files` accepts audio; matches plan.md. |
| N27 | 152, 431 | Ollama fallback exercised live | missing | Unit-tested with a canned reply only; no live evidence. Small. Not in ROADMAP. |
| N28 | 153, 226 | Sync-aware rule for which host reads a capture (origin changes when the other host edits) | missing | Known limit recorded at line 226; unchanged. Rare; small. |
| N29 | 157-161, 443-451 | Type table as data, owners `portfolio-ai`, `notes`, `vehicles`; user override file | done | `packages/notes/capture-types.default.json` has receipt, grocery_list, note, recipe, document, odometer, service_invoice, vehicle_note, other. Override file `~/.config/aico/capture-types.json` is optional and absent. |
| N30 | 447 | `shelf_tag` type with portfolio-ai | contradicted | Table row at 447 vs line 157 "No `shelf_tag` row"; no row exists. The plan contradicts itself. Small. Not in ROADMAP. |
| N31 | 161, 453-458 | portfolio-ai receipt hand-off: adapter, UUIDv5 id, purge after 2xx, `waiting` when VM 180 is off, retry on maintenance | partly | Adapter in `owners/portfolio-ai.ts`; waiting path seen live (one row shows `route_state=waiting`, now tombstoned). The real `filed` + purge path was never run live (plan line 166, still true; VM 180 is off now). Medium to verify (needs a spare receipt). Not in ROADMAP. |
| N32 | 163 | Tray todo per capture needing a tap, via Nightshift `sendNotice` | obsolete | Nightshift retired 2026-11-06 (plan.md decisions log); `capture-router.ts:58` keys `capture:<id>` now go through Aico's own `notify.ts`. |
| N33 | 168-192 | M4a notes server: tables, API, revisions, groceries, `tether note` | done | Routes listed in N5; Groceries note exists (`aico:groceries`, 1 live list plus items); `tether note groceries show` works. |
| N34 | 203 | A label list endpoint (chips come from loaded notes, newest 500 only) | missing | No `/api/notes/labels` route in `notes.ts`. Small. Not in ROADMAP. |
| N35 | 203 | An empty New note left untitled; "Crossed out on the photo?" hint seen live | partly | Not checked either way. Low value. |
| N36 | 194-202 | M4b screens: list, editor, autosave, reorder, attachments, history, shortcuts | done | `components/notes/*`, `app/notes/page.tsx`, manifest shortcuts; `/notes?id=groceries` 200. Rendering not re-screenshotted. |
| N37 | 205-228 | M5a sync engine, registry, web.db schema 2+, conflict rule refinements, restore detection | done | `sync/engine.ts`, `registry.ts`, `sync.test.ts` (26 tests), web.db schema 3; live convergence proves the common path. Split-brain, skew and restore are covered by tests only, not re-run. |
| N38 | 395-398 vs 219-224 | Conflict rule as written in "Conflict rule" (`prev == updated_at`) | contradicted | Superseded by "Review fixes" (prev is the other host's base plus `prev_origin`). The Sync section of the plan still shows the old rule; code follows the review fixes. Doc fix, small. |
| N39 | 230-245 | M5b transport and loop: unix socket 0600, hello/changes/blob/nudge, 60 s loop, blob copy, daily tombstone purge | done | `sync/server.ts`, `peer.ts`, `loop.ts`, `blobs.ts`; socket mode `srw-------`; `maintenance_at` written daily. |
| N40 | 236, 421 | Push-door rule: only the host whose Tether owns the item pushes | done | `background.ts:105-154` (`data.host` check); test file `background.test.ts`. |
| N41 | 247-265 | M6a CT 190 build, keys, ufw, `deploy-remote.sh`, `hello.build_id` | done | `scripts/deploy-remote.sh` exists; `buildMismatch:false`. |
| N42 | 253, 485-489 | `deploy-remote.sh` rsyncs the tracked tree and runs `install.sh --start` on the guest | contradicted | It now copies the workstation's already-built release and runs `install.sh --prebuilt` (the guest cannot build); better than planned. |
| N43 | 254 | `tether-link@workstation` / `tether-link@gem` units | obsolete | Fleet link replaces them (N10). `hosts.json` entries remain (cosmetic duplicates: workstation has both `gem` and `aico`; gem has both `workstation` and `davion-sidarli`). |
| N44 | 261, 267-270 | Hub relays `asks.changed`/`show.requested`; `?hosts=all` merged lists; answers forwarded to the owning host | done | `hub/peer.ts:78-89`; `web-server/src/asks.ts:439`, `shows.ts:180`. Live: one `answered` ask listed. Cross-host path covered by tests, not re-exercised. |
| N45 | 271, 592 | Gem door can push the phone through a restricted PVE key | done | Key lines present on PVE (`/etc/pve/priv/authorized_keys` 15,17,18: forced `aico-push`, from CT 190 only); `/usr/local/sbin/aico-push` now wraps `pve-sender push`; gem unit has `AICO_PUSH_SSH=pve-alerts`; pve-sender heartbeats show FCM accepted. Last logged `aico-push` send was Nov 2; I did not send a test push (it would reach the owner). |
| N46 | 271, 274 | Push depends on Nightshift's `deadman.send`; gem push has no Nightshift item | obsolete | Nightshift retired; sender is Aico's `native/pve-sender`. |
| N47 | 272, 263 | Hosts card sign-in line calls `agent-hub` on the other host | obsolete | Agent Hub retired. Hosts sign-in now uses Aico logins (R25). |
| N48 | 276 | Echo storm fix (no transitive relay) | done | `peer.ts` drops events that already carry `host`; regression in `hub.test.ts`; gem load average 0.8. |
| N49 | 277, 583 | Workstation-off test: gem stays up, edits sync back | done | Recorded 2026-11-02 (73 s outage); not repeated. |
| N50 | 276-279 | `cloudflared-aico` on both hosts; DNS moved; `agy` on gem | done | `cloudflared-aico.service` active on both (workstation since Nov 6 20:33, gem since Nov 3); ingress `aico.summitflow.dev -> localhost:3002`; `agy` at `~/.local/bin/agy` on gem and a gem-origin capture was read via `agy` and filed. |
| N51 | 495-499 | Docs updated: `remote-access.md` (one tunnel, two connectors, why a replica is wrong) | missing | `docs/remote-access.md` has no mention of a second connector and still says "Don't add a second hostname" (the phone app now uses `app.summitflow.dev`). `INSTALL.md` has `sync` and `deploy-remote.sh`. Small. Not in ROADMAP. |
| N52 | 283-284 | PWA read-only cache, `X-Aico-Host` rule, banner, thumbs 200, version bump | done | `public/sw.js` (served by both hosts, header present), `lib/offline.ts:69-70`, `ReadOnly.tsx`, `service-worker.test.ts`. |
| N53 | 515, 585 | Both hosts off: installed PWA opens last notes read-only | partly | Tested through a flaky local proxy (Cloudflare 530/drop), never with both hosts really down. Covered by the on-hold power-off test (ROADMAP "Next"). |
| N54 | 285-288, 527-532 | Nightly Markdown + photo export to `SummitFlow-Notes` via `rclone copy --update`, dedicated `drive.file` token | done | Section 1; both hosts hold `notes-drive.conf` (scope `drive.file`). |
| N55 | 286 | Workstation defers to gem via a user timer + `AICO_EXPORT_DEFER_TO=gem` | contradicted | Workstation now runs the `notes-export` job under `aico-jobs` with defer logic in `notes-export.ts:78`; gem still uses the old user units `aico-notes-export.timer/.service`, which are no longer in the repo (`scripts/systemd/` has none). Works (nightly uploads Nov 5-7); drift only. Small. |
| N56 | 291-298, 540-545 | `tnotes` import-summitflow / import-keep / verify-keep | done | `~/bin/tnotes` -> script exists; 36 SummitFlow + 22 Keep notes live; the Takeout folder holds 22 JSON + 22 HTML and no attachments, matching 22 `keep:` notes (0 deleted). I did not re-run `verify-keep` because it opens the live store read-write. |
| N57 | 298, 544 | Keep retired only after the owner has seen the report | partly | Import is done; whether Keep is retired is the owner's step and cannot be checked from here. Recipes/car notes are in the 22. |
| N58 | 545, X4 (plan.md) | Remove notes code from SummitFlow and Agent Hub | obsolete | Both projects are retired and archived (`/srv/workspaces/archive/agent-hub-2026-11-06`; no summitflow checkout). |
| N59 | 302-312, 460-462 | M9 vehicles hand-off to portfolio-ai (`VehiclesOwner`, grouped events, purge) | done | `owners/vehicles.ts`, `vehicles.test.ts`; a workstation odometer capture is `filed` to `vehicles`; portfolio-ai has `vehicle_service.py` and `docs/vehicles.md` ("server side only, a UI comes later"). Waiting state with VM 180 off, voice and PDF not exercised live. |
| N60 | 368-378 | Data model (notes, items, labels, attachments, revisions; FTS local) | done | Tables exist with the plan's counts; `notes_fts` local. |
| N61 | 380-400 | HLC, skew guard (5 s shown, 24 h refused), `seq`, restore `db_id`, 180-day tombstones | done | `shared/src/hlc.ts`, `config.ts` (`AICO_SYNC_TOMBSTONE_DAYS` 180, max-ahead 24 h); live skew 22 ms. Stale meta rows on gem (`peer:livetest`, `peer:davion-sidarli` from old names) are harmless leftovers. |
| N62 | 417-420 | `web.db` view state synced (tabs, links, settings, seen max) | done | Equal counts on both hosts, schema 3. |
| N63 | 431 | Fallback speech-to-text via Agent Hub faster-whisper | obsolete | agy takes audio (N26); Agent Hub retired. |
| N64 | 429 | Route 2 "Agent Hub" for when agy is down | obsolete | Replaced by the local ollama route; Agent Hub retired. |
| N65 | 517-523 | Wake button on the offline workstation | obsolete | Owner said not now (plan.md 2026-11-02); gem's `hosts.json` has no `wake` (checked). |
| N66 | 522, 583 | Test `wake-ws` from gem and time it | missing | Allowed without asking but never run; rolled into the on-hold power-off test (ROADMAP "Next"). |
| N67 | 509-515, 569-588 | Live lane 2: gem off, add an item from the phone, power gem on | partly | Only `aico-web` on gem was stopped (6a); gem itself has not been powered off. ROADMAP has the power-off test (on hold). |
| N68 | 586 | Live lane 6: stop one connector, site keeps answering | missing | No record. Two connectors are registered, but the failover itself is untested. Small to run; part of the on-hold test. |
| N69 | 588 | Live lane 8: real receipt through the router with VM 180 on and off | partly | Off (waiting) seen; on (filed) not (N31). |
| N70 | 590-594 | Open questions decided (PVE key for rescue/alerts; own Drive token) | done | Both implemented (N45, N54). |
| N71 | 87 | Camera permission left `camera=()` because the page uses native file input | done | Header `Permissions-Policy: camera=(), microphone=(self)` on live responses. |
| N72 | plan.md decisions log | Wife's grocery list | obsolete | Deferred by owner (plan.md decisions log); nothing built, nothing blocks it. |

## 4. remote-hosts.md

| # | Plan | Commitment | Status | Evidence / note |
|---|---|---|---|---|
| R1 | 3-5 | Phase 1a built; API in `api-v1.md` "Remote hosts" | done | Section exists at `packages/tether/docs/api-v1.md:1024`. |
| R2 | 7-10 | Start, watch and steer from one Aico pane on desktop and phone | partly | Phone web works. The desktop app is gone (memory G:02c79821), so "desktop" is obsolete. |
| R3 | 12-24 | Local Tether is the hub; every client keeps one local socket; diagram | partly | Hub design is in place (`hub/hub.ts`, `hub/peer.ts`). The diagram's "Aico desktop" and "SF tether.py" boxes are obsolete (desktop and SummitFlow retired). |
| R4 | 26-38 | `hosts.json`: `name`, `ssh` alias (never an IP), `socket`, `forwards`, `wake` | contradicted | `name`, `ssh` (IPv4 refused, `remote.ts:12`), `socket`, `wake` work, and `sleep`/`status` were added. **`forwards` is read by nothing** (no match in `packages/`); the live file still carries `forwards: [3017]` for neri-hunters and the 8001/8003 ports it was made for are gone with SummitFlow/Agent Hub. Open question for the owner: how do hunters reach the Neri backend (3017) over the fleet link? Small to remove the dead field; unknown size if the 3017 path is broken. Not in ROADMAP. |
| R5 | 40-47 | Link is the fleet link: TLS 1.3, port 7449, `fleet.json`, pinned keys, proxy sockets, quiet backoff, never powers a host on | done | Listeners `192.168.86.128:7449` and `192.168.86.59:7449`; proxies under `/run/user/1000/aico/fleet/<host>/`; `fleet.json` retry 2 s to 300 s; allowlist `/etc/aico/fleet-peers.json` root-owned; `docs/fleet-link.md`. |
| R6 | 46-47 | ssh stays for administration and rescue only | done | No `tether-link@` units; `install.sh:169` removes the leftover; ssh aliases still used by me for CT 190 and the PVE host. |
| R7 | 51-52 | Peers are read from `hosts.json` | contradicted | Peers now come from `~/.config/aico/fleet.json` (names `aico`, `agent-work`, `neri-hunters`); `hosts.json` supplies socket/ssh/wake/sleep/status. Names disagree (hosts.json `gem` and `aico` for one machine; fleet name is `aico`). Cosmetic, small. |
| R8 | 53-61 | Merged session list, parallel with short timeout and a circuit breaker; `host` field; last-known items marked offline/powered_off/connecting | done | `peer.ts:13` states, `:70-72` breaker 3 failures / 30 s, `:363-381`; live `/api/hosts` shows agent-work and neri-hunters `powered_off`, aico `connected`. |
| R9 | 62-65 | Per-session routes forwarded to the owning peer; global ids; duplicate id logged, local wins | done | `hub.ts` routing; `peer.ts:153,397-399`; `hub.test.ts`. |
| R10 | 66-72 | Hub follows peer events, re-emits with `host`, resync on reconnect; asks and shares relayed | done | `peer.ts:78-89` `RELAYED` includes `asks.changed`, `show.requested`; `peer.resync` at `:592`; `?hosts=all` used by aico-web. |
| R11 | 73-74 | Hub bridges each peer's `/v1/gui/channel` | obsolete | Desktop gone; `/v1/gui/*` answers "retired" (`server.test.ts:254`). |
| R12 | 75-78 | `POST /v1/sessions` and `/v1/roots` take `host`; wake; wait for link and forwarded Agent Hub health | partly | `host` + wake + link wait done (`hub/wake.ts`, `host-admin.ts:269`, `st aico create --host`). The Agent Hub health wait is obsolete. |
| R13 | 79-82 | Lineage across hosts (`launchedBy`, `parentId`) | done | `hub.ts:736`; commit 8a11b000 as pointer. |
| R14 | 83 | `/v1/tools` and `/v1/projects` accept `?host=` | done | `server.ts:277,339`. |
| R15 | 87-94 | Attach runs tmux through the fleet exec channel; socket path validated | done | `packages/tether-client/src/term/remote.ts` (`remoteAttachArgv`, `trustedRemoteSocket`). Comment at line 59 still names `tether-link@<host>` (stale wording). |
| R16 | 95-96 | Client pid from `#{client_pid}` for resize claim | done | `term/control.ts:354,447`. |
| R17 | 97-99 | Bounded reattach after a link drop | done | `web-server/src/terminal.ts:237,281-287`. |
| R18 | 100-105 | UI: host badge, + dialog host picker, offline/powered-off states, Hosts panel with state, power, resources, sessions, sign-in | partly | `HostBadge.tsx`, `NewSessionDialog.tsx` (picker), `HostsSheet.tsx` (state, power on/off, sessions, sign-in, notes-sync line). **Resources (memory/CPU) are not shown** in the panel (placement reads them). Small. Not in ROADMAP. |
| R19 | 109 | Paths mirror the workstation on the VM | missing | Cannot check: VM 200 is off. Unverified, not found broken. |
| R20 | 110-111 | Config checkouts pushed from the workstation; work projects on demand | partly | `scripts/install-worker.sh`, `scripts/peer-release.sh`, `tether fleet push-update` exist. VM off, not checked. |
| R21 | 112-113 | Retained work returns by fetching branches; nothing durable on the host | partly | Policy only. ROADMAP "Next: Failover: copy active repos to the peer" covers the repo side. |
| R22 | 115 | Remote Tether runs `TETHER_HEADLESS=1` | done | CT 190 unit drop-in verified. Worker VMs unverified (off). |
| R23 | 116-125 | On link-up the hub compares `apiVersion` and installs its release on an older host with database copy and rollback | done | `hub/update.ts` (`install-release.sh`, `restore_db`, rollback at `:128-165`); `tether hosts` UPDATE column; `tether fleet push-update`. Not triggered live (versions equal). |
| R24 | 126-127 | Snapshots only when the Tether catalog is empty; rollback and poweroff end sessions first; clones from a clean snapshot | partly | `aico vm reset` only touches stopped guests (`ops/src/vm.ts:209-246`); hub Power off ends sessions first (commit 451e874b). `aico vm snapshot` has no empty-catalog check and there is no clone command. Small. Not in ROADMAP. |
| R25 | 129-164 | Credentials split: Agent Hub serves non-rotating logins, shim `agent-hub-cred-exec`, rotating logins stay on the host, sign-in sessions | obsolete | Agent Hub retired 2026-11-06 (owner approved deleting its logins, commit 9359adbf). Replaced by Aico logins (`aico logins`, `packages/fleet/src/logins*.ts`, `tether fleet push-logins`, Hosts sign-in rows). Intent kept in spirit: static-login tools are claude-code and pi only, and the fleet peer tool lists exclude codex. Whether agent-work still holds its own Codex login cannot be seen while it is off. |
| R26 | 166-168 | Power start only on create via `wake` | done | `wake: st vm start 200/201` in hosts.json; `st vm status 200` works; link never wakes. |
| R27 | 169-174 | Guest powers itself off after 15 idle minutes (zero sessions, no wakes, low load, no ssh) | missing | No timer or script anywhere in the repo (searched `scripts`, `native`, `packages`); VM 200/201 are off now, but I cannot tell who stopped them. Today the only off paths are the manual Power off button (`canSleep: true`) and `aico vm shutdown`. Medium (guest unit, or hub-side idle watcher). Not in ROADMAP. |
| R28 | 176-216 | Placement: `--host auto --needs`, pools, room formula, capabilities, reservations, local room, named host with needs, `st aico placement` | done | Live outputs in section 1; `placement.json` has `order [local, agent-work]`, pool `neri-hunt [neri-hunters, local]`, Proxmox sections; `hub/placement.ts` (1172 lines) + `placement.test.ts`. The "Nightshift admission file" is now host-steward's admission file (`TETHER_HOST_ADMISSION`). ROADMAP "Neri hunter VM placement: Proxmox authority not linked" looks fixed (commit af2e70ec) apart from its dry-run verification; the ROADMAP line is probably stale. |
| R29 | 218-222 | Cross-host `inject` for `st sessions send`; `_coord.json` per host | done | `lifecycle-api.ts:1211`, hub forwarding; `coordination/docs.ts`. Not exercised live (no remote session running). |
| R30 | 224-235 | Phases 1-4 including end-to-end test (launch from a coordinator, send, watch on phone, roll back a VM) | done | Recorded e2e run (commits 451e874b "remote-hosts e2e run D10, D11, D17", 86a73a81 D18, 461af4cd rollback case). Not re-run now: both worker VMs are off, and read-only was the rule. |
| R31 | ROADMAP | ROADMAP "Later: install on gem (CT 190) and the agent VMs as one fleet" | contradicted | Already done: CT 190, agent-work and neri-hunters are fleet peers. ROADMAP line is stale. Small. |

## 5. Counts

Sections 3 and 4 together (72 + 31 = 103 items):

| Status | notes-and-capture | remote-hosts | Total |
|---|---|---|---|
| done | 40 | 17 | 57 |
| partly | 9 | 7 | 16 |
| missing | 6 | 2 | 8 |
| contradicted | 7 | 3 | 10 |
| obsolete | 10 | 2 | 12 |

## 6. Missing and contradicted, ranked by what matters to the owner

1. **N17: gem-only edits are not in Drive while the workstation is off.** The CT 190 backup row is pulled through the workstation (12 h old, daily), so the case the plan built it for is open. Mitigation today: gem's hourly local snapshot and its nightly Drive export (notes text and photos). Medium. Not in ROADMAP.
2. **R27: no idle power-off for worker VMs.** Nothing implements the 15-minute rule; VMs stay on until someone stops them. Medium. Not in ROADMAP.
3. **R4 / N13: `forwards` in hosts.json is dead.** Nothing reads it, yet neri-hunters lists port 3017 and `tether capture file --out` tells users to rely on it. Need to confirm how hunters reach the Neri backend now. Small to remove, unknown if it hides a break. Not in ROADMAP.
4. **N31 / N69: the receipt hand-off that deletes Aico's copy has never run live** (only the waiting path and fakes). Medium to prove (needs a spare receipt and VM 180). Not in ROADMAP.
5. **N53, N66, N67, N68: outage tests not done for real** (gem powered off, both off, one connector stopped, `wake-ws` timing). ROADMAP has this as the on-hold power-off test (`docs/power-off-test.md`).
6. **N51: `docs/remote-access.md` does not describe the two connectors** and says not to add a second hostname. Small. Not in ROADMAP.
7. **N24: a real iPhone HEIC through Safari is untried.** Phone-only; ask the owner or the next phone check.
8. **R31, N1, N38: stale statements**: ROADMAP "Later" line (CT 190 already done), the plan header "nothing built", the old conflict rule in the Sync section. Small doc fixes.
9. **N15, N30, N34, N27, N28, R18, R24:** HEIC preview has no 2000 px cap; no `shelf_tag` type; no label list endpoint; ollama fallback never exercised live; capture-reading host rule when the other host edits; Hosts panel has no resources; no snapshot-when-idle check or clone command. Each small, none in ROADMAP.
10. **N55, N43, R7:** drift only: gem still on the old export timer units that are not in the repo; duplicate hosts.json entries (`gem`/`aico`, `workstation`/`davion-sidarli`) and stale peer rows in gem's sync meta.

Owner-only steps that I could not and did not check: whether Keep is retired (N57), and gem's BIOS "power on after AC loss" setting (plan.md 2026-11-02, "I'll set it").
