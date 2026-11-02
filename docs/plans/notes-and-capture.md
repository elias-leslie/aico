# Notes and capture in Aico, with two equal front doors

Status: design, nothing built. Written 2026-11-02 from the owner decisions in `summitflow/docs/plans/codebase-cleanup/plan.md` ("Decisions log", "Notes in Aico", "Notes store: works with either host down", "Hosts", "Phone Aico when either host is down", "Remote agent work"). Those are settled and not reopened here. Same rule as [ADR 0001](../adr/0001-tether-owns-sessions.md): Tether owns sessions, apps own data and views. So notes and captures live in `aico-web`, not Tether.

## What you get

- A **Capture** button on the phone: take a photo or choose photos and files (several at once), add a caption, send. It is saved at once and filed later.
- An agent can ask you for files in a "Needs you" card: `tether ask create "..." --files 1-3`. You take or pick them in the card, and the answer reaches the agent with the file ids and paths.
- A **Captures** list, then a real **Notes** feature (text, checklists, recipes, labels, search) that replaces Keep and the SummitFlow notes.
- Text in photos is read in the background. A router suggests what each capture is and who owns it. Grocery items file themselves. Receipts go to portfolio-ai. Money and vehicle items wait for one tap.
- The same app on **davion-gem** (always on) and **davion-sidarli** (on demand), each with its own copy of the data, synced both ways. Either host can be down and notes and capture still work.

## Decisions this doc makes (everything else is from the plan)

- **On gem it runs in a new LXC (CT 190 `aico`), not on the Proxmox host.** It parses untrusted files (HEIC, PDF) and runs a Node web app, and every other always-on service on gem is a guest. The host stays lean, as RESCUE.md asks. The cost and the one owner decision it raises are under "Gem deployment" and Open questions.
- **Data lives in a new `notes.db` plus a hash-named blob folder, beside `web.db`.** `web.db` keeps the per-server view state and joins the same sync.
- **Sync rides the existing Tether link ssh connection** (one more forwarded socket): no new ports, tokens or firewall holes.
- **Every write is stamped for sync from Milestone 1**, though sync ships in Milestone 5. Nothing is migrated later.
- **Agents use `tether capture ...` and `tether note ...`**: thin HTTP clients in the Tether CLI over aico-web's loopback API. No capture or note logic lives in Tether.
- **Limits:** 25 MB per file (`AICO_CAPTURE_MAX_MB`), 20 files per batch or ask. HEIC is stored as sent, with a JPEG preview made on the host.

---

## Milestone 1: Capture v1 (build this first)

Goal: open Aico on the phone, tap Capture, take a photo or choose files, add a caption, send. It is stored durably, listed, and readable by agents. No extraction, router or sync yet.

### Durable storage (not `~/aico-uploads`)

`~/aico-uploads` is session-bound and `cleanupOldUploads` deletes it after 24 h. Captures never touch it.

- Data dir: `${XDG_STATE_HOME:-~/.local/state}/aico/` (`AICO_DATA_DIR`), the folder `web.db` already lives in.
  - `notes.db`: SQLite, WAL, mode 0600, same open/migrate pattern as `WebStore` (`web/server/src/db.ts`).
  - `blobs/<hash[0:2]>/<hash>`: the original bytes, named by SHA-256. Variants beside it: `<hash>.thumb.jpg`, `<hash>.preview.jpg`.
- **Backup coverage, checked 2026-11-02:** `st backup status` shows the `home` job (btrbk `home` every 4 h to the T7, restic to Drive daily). `backup_offsite.excludes` leaves out `.cache`, `.local/lib` and similar, not `.local/state`. So the workstation copy is covered with no registry change. Never name a folder `.cache`. A live SQLite WAL inside a snapshot recovers on open.
- On gem the LXC needs a `backup_sources` row like `pve-vm-180-app-recovery` (a `proxmox://davion-gem/...` source with `path=` entries). Added in Milestone 6; check then that the scheme supports an LXC. Once sync runs, the workstation's backup also holds gem's data.

### Schema (`notes.db`, schema version 1)

Every synced row carries the sync columns. `seq` is a per-database change counter. `prev` is the `updated_at` of the version this edit was based on (conflict detection only). No foreign keys on synced tables; the app enforces links.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- meta: schema_version, db_id (random uuid, new for a fresh file), host_name, seq, hlc_last

CREATE TABLE captures (
  id          TEXT PRIMARY KEY,          -- 12 hex, random (short for CLI and ask lines)
  client_id   TEXT NOT NULL UNIQUE,      -- uuid from the browser: a retry never duplicates
  group_id    TEXT,                      -- uuid: files sent together (a photo plus a note)
  ask_id      TEXT,                      -- 12 hex Tether ask id when it answers an ask
  kind        TEXT NOT NULL CHECK (kind IN ('image','pdf','doc','text','audio')),
  name        TEXT NOT NULL,             -- original file name, display only
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  hash        TEXT,                      -- sha256 hex; NULL once handed off and purged (Milestone 3)
  caption     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','extracting','ready','failed','filed')),
  type        TEXT,                      -- router type id; NULL until extracted
  text        TEXT,                      -- extracted text; NULL until extracted
  created_at  INTEGER NOT NULL,          -- ms, display and ordering
  updated_at  INTEGER NOT NULL,          -- ms, hybrid logical clock
  origin      TEXT NOT NULL,             -- host that wrote this version ('gem', 'sidarli')
  prev        INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL
);
CREATE INDEX captures_created ON captures (deleted, created_at DESC);
CREATE INDEX captures_ask ON captures (ask_id);
CREATE INDEX captures_seq ON captures (seq);
```

Later migrations add `captures.extract_json`, `owner`, `owner_ref`, `route_state` (Milestone 3) and the notes tables (Milestone 4).

### Files to add or change

Server (`web/server/src/`):
- `notes-db.ts` new: `NotesStore` (open, migrate, `stamp()` for the sync columns, `insertCapture`, `getCapture`, `listCaptures`, `updateCaption`, `tombstoneCapture`, `capturesForAsk`).
- `hlc.ts` new: hybrid logical clock, `next()` = `max(Date.now(), last + 1)` and `observe(remote)`; persisted in `meta.hlc_last`.
- `blobs.ts` new: `blobPath(dir, hash, variant)`, atomic write (temp file, fsync, rename), hash check, read.
- `capture-files.ts` + `capture-file-types.json` new: the accepted-types table as data (extension, mime, kind, magic). The server sniffs with it, and `GET /api/captures/limits` hands it to the page so the `accept` string comes from the same table.
- `heic.ts` new: `makePreview(runner, src, dst)` runs `heif-convert -q 85 SRC DST.jpg`. The runner is injected.
- `captures.ts` new: `registerCaptureRoutes(router, deps)`.
- `uploads.ts` change: export `readUpload` (already caps the body and parses multipart) and `RateLimiter`. The session upload path does not change.
- `config.ts` change: `captures: { maxBytes, maxFiles }`, `dataDir`, `hostName` (`AICO_HOST_NAME`, default `os.hostname()` lowercased).
- `api.ts`, `main.ts` change: open `NotesStore`, pass it in `ApiDeps`, close it on shutdown.
- `guard.ts` stays: `camera=()` in `SECURITY_HEADERS` is fine because the page uses the native file input with `capture`, not `getUserMedia`. `microphone=(self)` already allows dictation.

Frontend (`web/frontend/`):
- `components/capture/CapturePicker.tsx` new, shared with Milestone 1b. Two equal controls:
  - **Take photo**: `<input type="file" accept="image/*" capture="environment">`. Shown on touch devices.
  - **Choose files**: `<input type="file" multiple accept={types.accept}>`: library photos, PDFs and documents in one multi-select. On desktop this is the one control, plus drag-drop and paste.
- `components/capture/CaptureLauncher.tsx` new: the button, mounted beside every `NeedsYouLauncher` (`SessionSidebar.tsx` icon and tool variants, `SessionSwitcher.tsx`, `EmptySessionState.tsx`, `UnifiedTerminalHeaderContent.tsx`), never inside a terminal view. Opens `CaptureSheet`.
- `components/capture/CaptureSheet.tsx` new: picker, per-file rows, caption box, Send. A dictation button when `SpeechRecognition` exists; the phone keyboard's dictation always works. Voice files arrive in Milestone 2.
- `app/captures/page.tsx` new (static export, detail by `?id=`), `CaptureList.tsx`, `CaptureDetail.tsx`: thumbnail, caption, status, extracted text once present.
- `lib/api/captures.ts`, `lib/hooks/use-captures.ts` (react-query, polling like `use-asks.ts`), `lib/hooks/use-capture-upload.ts` (per-file queue with XHR progress, like `use-file-upload.ts`).
- The thumbnail is made in the browser (canvas, 480 px JPEG, under 256 KB) and uploaded after the file. A HEIC the browser cannot decode gets its thumbnail from the server preview.

Tether CLI (`tether/src/`): `capture-cli.ts` new, wired in `cli.ts` beside `case 'ask'`.

### Endpoints (all behind the existing Host/Origin guard)

| Method and path | Does |
| --- | --- |
| `GET /api/captures/limits` | `{ max_bytes, max_files, types: [{ext, mime, kind}], accept }` |
| `POST /api/captures` | multipart: `file`, `client_id`, optional `caption`, `group_id`, `ask_id`. Sniffs, hashes, writes the blob, inserts the row (`status=new`). The same `client_id` again returns the existing row (200); a new row is 201. |
| `PUT /api/captures/:id/thumb` | raw JPEG, at most 256 KB, JPEG magic checked |
| `GET /api/captures?status=&ask=&limit=&before=` | `{ captures, total }`, newest first, tombstones hidden |
| `GET /api/captures/:id` | one capture |
| `GET /api/captures/:id/file`, `/thumb`, `/preview` | bytes. `Cache-Control: private, max-age=31536000, immutable` (hash-named), `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`. Only jpeg, png, webp and gif render inline; everything else is `Content-Disposition: attachment`. |
| `POST /api/captures/:id/retry` | A `failed` capture goes back to `new` and is read again (409 for any other status). Milestone 2. |
| `PATCH /api/captures/:id` | `{ caption }` only |
| `DELETE /api/captures/:id` | tombstone. The blob stays until the sync-aware cleanup (Milestone 5). |

Errors in plain words: 413 "That file is over 25 MB", 415 "Aico can't store this kind of file yet", 429 (60 per minute, the `RateLimiter`), 409 for a closed or full ask (Milestone 1b). The capture JSON: `{ id, clientId, groupId, askId, kind, name, mime, size, hash, caption, status, type, text, createdAt, updatedAt, origin, hasThumb, previewState, extractError, extractRoute, needsCheck }`, plus `extract` (the parsed reading) on a single `GET /api/captures/:id` and on retry, never in lists, with `previewState` of `ready`, `pending` or `unavailable`.

### Accepted types and HEIC

- Accepted: JPEG, PNG, WebP, GIF, **HEIC/HEIF** (an ISO file with an `ftyp` brand such as `heic`, `heix`, `hevc`, `mif1`, `msf1`), PDF, plain text, Markdown, CSV, JSON, DOCX, XLSX, ODT, ODS, and audio (m4a, mp3, ogg, webm, wav). The data file is the list. Zip-based documents are checked by zip magic plus extension and are only downloaded, never opened or rendered.
- **HEIC is stored exactly as sent.** After the upload the server makes `<hash>.preview.jpg` (long edge 2000 px) with `heif-convert` (package `libheif-examples`, installed on both hosts). The page and `vision-extract` use the preview. If the tool is missing or fails, the capture is still saved, `previewState` is `unavailable`, and the detail view says so with a download link. Safari usually hands over JPEG anyway.
- Text files must be valid UTF-8 with no NUL bytes. Their claimed type stands (same rule as `detectMimeType`).

### `tether capture` (agent read path)

A thin client over `http://127.0.0.1:3002` (`AICO_WEB_URL` overrides). It sends no Origin, so the guard lets it through.
- `tether capture list [--status S] [--ask ID] [--json]`
- `tether capture get ID [--json]`: fields, caption, text.
- `tether capture file ID [--out DIR]`: prints the blob path on this host; with `--out` it downloads. A session on another host needs port 3002 in that host's `forwards` in hosts.json.
- `tether capture result ID [--json]`: what was read (Milestone 2, shipped). Exit 3 while it is still being read, 1 when it could not be read.

### Tests for Milestone 1

No network, no real `heif-convert`, no real timers.
- `notes-db.test.ts`: migration; a `client_id` retry returns the same row; every write bumps `seq` and `updated_at` and sets `origin` and `prev`; `updated_at` never repeats or goes backwards; a tombstone hides the row; a newer-schema file is refused like `WebStore`.
- `hlc.test.ts`: `observe` of a future stamp moves the clock past it; a restart keeps order.
- `capture-files.test.ts`: every table row sniffs; a renamed `.exe` or a PDF claiming JPEG is refused; HEIC brands; non-UTF-8 text refused.
- `captures.test.ts` (route level, in-memory store, temp dir): create, duplicate, 413, 415, paging, caption patch, delete, blob bytes equal the upload at `blobs/ab/<hash>`, cache headers, attachment disposition for a PDF, thumb size and magic, HEIC with a fake runner (`ready`, and `unavailable` when it fails), rate limit.
- Frontend: `CapturePicker.test.tsx` (two inputs, `accept` from the table, `capture` attribute, `multiple`), `CaptureSheet.test.tsx` (queue states, retry, caption sent), `CaptureLauncher.test.tsx` (beside each `NeedsYouLauncher`, absent in a terminal view), `CaptureList`/`CaptureDetail` tests for loading, empty, failed and stale states.
- `tether/src/capture-cli.test.ts` against a stub HTTP server on an ephemeral loopback port.
- Live check (a lane, not `st check`): phone PWA on the workstation door; take a photo; choose three files including a HEIC and a PDF; see them in Captures; `tether capture get`.

### Milestone 2 as shipped (2026-11-02)

- **Module:** `web/server/src/vision-extract/` (`index.ts` routes, `validate.ts` a small schema checker, `capture-schema.ts` the schema and prompt, `runners.ts` the real agy and HTTP calls). `extract(request, config, runners)` returns `{ json, raw, route, ms }`; output that fails the schema fails that route and the next route is tried. Tests inject the runners and pin the agy argv and the ollama request.
- **Routes and config** (`config.ts`, all env): `AICO_VISION_ROUTES` (default `agy,ollama`), `AICO_AGY_PATH` (else `~/.local/bin/agy` when present, else `agy`), `AICO_AGY_MODEL` (`gemini-3.8-flash-low`), `AICO_OLLAMA_URL` (`http://localhost:11434`), `AICO_OLLAMA_MODEL` (`qwen3-vl:8b-instruct`), `AICO_VISION_CONCURRENCY` (2). The ollama route reads pictures only and its results are `needsCheck`. No time limit on either route (owner rule); a read ends when the process exits or the connection errors.
- **Schema (one call):** `type` (grocery_list, receipt, odometer, service_invoice, recipe, note, document, other), `title`, `text`, `summary`, `lines[{text, struck}]`, `items[{as_written, item, quantity, struck}]`, `receipt|null`, `odometer|null`. All fields are required; the unused ones come back empty or null.
- **Store:** `notes.db` schema 2 adds `extract_json`, `extract_route`, `extract_error`. Claim, finish, fail, requeue and retry are `NotesStore` methods that go through the same stamp path as every edit (new `updated_at`, `seq`, `prev`), so sync later sees them. A capture in `extracting` has the time reading began as its `updated_at`.
- **Worker** (`extract-worker.ts`, started in `main.ts`): takes `status=new` rows whose `origin` is this host, oldest first, up to the concurrency; sets `extracting`; writes `ready` or `failed` with a short plain reason; requeues `extracting` rows at startup. Upload and Retry only call `kick()`. A HEIC is read through its preview (fails plainly if there is none). The reader gets a temp folder holding one symlink with a real extension, so blobs named by hash still read as `.jpg`, `.pdf`, `.m4a`. Text captures are copied in as `type=note` with no call; Word, Excel and OpenDocument files are marked `ready` with no text.
- **UI:** the list shows Reading… / Read / Couldn't read it and the first line of the text when there is no caption. The detail view, under the picture, shows "Waiting to be read", "Reading since 1:42 PM", or "Couldn't read it: reason" with Retry; then a "check this" note when the fallback route read it, the list items (cleaned item, quantity, struck items crossed out, "written: ..." when it differs), and the text.
- **Live check (workstation, 2026-11-02):** receipt 40.6 s, type receipt, total 172.89, subtotal 171.31, tax 1.58, 24 items, date 2026-08-17. Odometer 14.5 s, 33396 with trip 44.6. Grocery list 16.9 s, 21 items with cleaned names ("see weeds" to seaweed, "pamagrants" to pomegranates, "potateous" to potatoes). Concurrency 2 held: the third waited as `new` until a slot freed. The model marked "sea salt" and "bread crumbs" as struck; on the photo those lines are underlined, so it may be confusing underlines with strike-throughs (worth a look at the prompt).
- **Spikes:** `agy` reads a PDF directly, text or scanned (a text PDF made with LibreOffice: exact; an image-only PDF made from a rendered picture: exact, 21 s). No `pdftoppm` step is needed. `agy` takes audio directly: a synthetic spoken sentence in m4a, wav, mp3, ogg and webm/opus transcribed word for word (11 to 13 s each). So speech-to-text through Agent Hub's faster-whisper is not needed for now. Both also worked through the real worker (a PDF and an m4a uploaded to the running server reached `ready` with correct text). Gem still needs `agy` installed and signed in. The ollama fallback cannot read PDFs or audio, so those fail plainly when agy is unavailable.
- **Not exercised live:** the ollama fallback (unit-tested with a canned reply only; it was bake-off tested earlier) and the failed-read path with a real agy outage.
- **Left for Milestone 3 (shipped below):** the router and type table, suggestions, owners and hand-off; still open: a sync-aware rule for which host reads a row (today `origin` equals this host, which also changes when another host edits the row).

### Milestone 3 as shipped (2026-11-02)

- **Type table:** `web/server/capture-types.default.json` (`owners` and `types`), with `~/.config/aico/capture-types.json` (or `AICO_CAPTURE_TYPES_FILE`) adding or replacing rows by id; a malformed row or file is logged and skipped. Row fields: `id`, `label`, `owner` (null: nobody), `owner_kind` (what the owner calls it), `auto`, `confirm`, `keep_copy`, `question`, `not_label`, `dismiss_type`. Owner rows carry `label` and `later` (the sentence shown while Aico has no adapter). Ids are the reader's: `receipt`, `grocery_list`, `note`, `recipe`, `document`, `odometer`, `service_invoice`, `other`. A new type the reader can already name is a data row. A type the reader cannot name yet also needs its value in the extract schema's enum. **No `shelf_tag` row**: the reader cannot tell a shelf tag from anything else, so the row would never fire; the adapter already sends `kind` from `owner_kind`.
- **Store:** `notes.db` schema 3 adds `owner`, `owner_ref`, `route_state` (`suggested`, `confirmed`, `waiting`, `failed`, `filed`, `kept`) and `route_note` (a plain sentence). `kept` is new: the owner chose Keep here or Not a receipt. The plan is written in the same transaction that makes the capture `ready` (`finishExtraction(..., plan)`); every later change goes through `transitionRoute`, which only moves from the expected states, so a double tap or a late retry changes nothing.
- **Router** (`capture-router.ts`): `plan(type)`, `describe(row)` (the `route` object on the capture JSON), `act(id, send|keep|not_this)`, `deliver(id)`, `tick()`. Owners with an adapter (`portfolio-ai`) get a tray todo and a Send button. Owners without one (`notes`, `vehicles`) leave the capture `ready` with the suggestion and the owner's `later` sentence, no button and no todo. An `auto` type with a live adapter files itself.
- **`POST /api/captures/:id/route`** `{action}`: `send` (from suggested, waiting or failed; answers with the final state, `filed`, `waiting` or `failed`), `keep`, `not_this` (retypes to the row's `dismiss_type`, default `other`). A deleted capture clears its todo.
- **portfolio-ai adapter** (`owners/portfolio-ai.ts`): `client_id` is a UUIDv5 of the capture id; sends `member_scope=local`, `kind`, `store_name` (from the reading) and `note` (the caption). A HEIC goes as its JPEG preview. Config: `AICO_PORTFOLIO_URL` (default the workstation forwarder `http://127.0.0.1:18000`; `off` disables), `AICO_PORTFOLIO_TOKEN_FILE` (else `HOUSEHOLD_AGENT_TOKEN_FILE`; read per call, sent only as the header, never logged; unset or unreadable sends none, which loopback allows today), `AICO_PORTFOLIO_APP_URL` (portfolio-ai's web address; the filed capture links to its `/capture` page; no deep link per capture exists). 2xx: `filed`, `owner_ref`, `status=filed`, and unless `keep_copy`, `hash`, `text` and `extract_json` become NULL and the blob, thumb and preview are deleted (kept when another capture holds the same bytes). 5xx or no connection: `waiting` ("Portfolio AI isn't answering right now"). 403 and other 4xx: `failed` with portfolio-ai's own sentence. Over 15 MB or a type portfolio-ai does not take: `failed` before sending.
- **Retry without a timer:** `Background.tick` runs `router.tick()` on every maintenance pass (startup and the 15-minute interval). It looks at `/health` once per owner, then sends the `waiting` captures (and any left `confirmed` by a restart). Send now is the same action as the first tap.
- **Tray todo:** one per capture that needs a tap, `kind=todo`, `push=tray`, key `capture:<id>`, title and body name the type and owner, never the contents; `open` links to the capture when the public host is known. Sent by the host that read the capture; resolved on Send, Keep here, Not a receipt or delete.
- **UI:** the detail view shows the suggestion ("Send to Portfolio AI as a receipt?" with Send, Not a receipt, Keep here), waiting (with Send now), failed (with the reason and Try again), and filed (link to portfolio-ai when configured, no Download). The list row's right-hand word becomes the route ("Send to Portfolio AI?", "Waiting for Portfolio AI", "Sent to Portfolio AI"). `tether capture get` prints `route: state -> owner (their id)`.
- **Live check (workstation, 2026-11-02):** portfolio-ai already holds this Costco receipt (2026-08-17, total 172.89, subtotal 171.31) as a ready-read document from the earlier order-history import, so the real receipt was not sent (no duplicate). A real photo through the new code: read as `receipt` in 33 s, suggestion shown and one tray todo raised; Send with VM 180 off went `waiting` in 5 s and cleared the todo; `/health` through the forwarder returned 200 with the VM on; a garbage upload to portfolio-ai's real endpoint answered 415 (so the loopback auth path works without a token file) and created nothing. The `filed` path was exercised only against the loopback fake in tests. **Fix found on the way:** the `portfolio-prod-*` forwarders ssh to `apps.lan`, which the workstation resolver (127.0.0.1) does not answer (the router does), so they failed. An ssh `Host apps.lan` entry in `~/.ssh/config` now points it at 192.168.86.160 (the VM's DHCP address; a router reservation would make that permanent).
- **Not done:** the real `filed` hand-off live (no real receipt to spare), the tick against a real VM start, `shelf_tag`, deep link to a portfolio-ai capture, and the gem LXC's own forwarder (Milestone 6).

### Milestone 4a as shipped (2026-11-02): the notes server side, no UI

- **Store:** `notes.db` schema 4 adds `notes`, `note_items`, `note_labels`, `attachments` and `note_revisions` as in "Data model after Milestone 4", each with `updated_at`, `origin`, `prev`, `deleted`, `seq` and each write going through `NotesStore.stamp()` like captures do. Code: `notes-data.ts` (`NoteStore`, reached as `store.notes`), `notes.ts` (routes), `owners/notes.ts`, `tether/src/note-cli.ts`. Ids are 12 hex, except a grocery item (`<capture id>-<n>`) and an attachment (`<note id>:<capture id>`), which are derived so a retry cannot duplicate them. Added to the model: `note_items.hint` (nullable text; the grocery reader's struck flag is kept as `struck`). `notes.source` has a unique index (nulls allowed). Transactions now nest (an inner call joins the outer one).
- **Search:** FTS5 is in Node's bundled SQLite (checked at runtime; falls back to LIKE if a build lacks it). `notes_fts` is a local table rebuilt from the rows at open and kept up to date inside each write; it is not synced. Each word of `q` must match a title, body, item or label (a word start under FTS, any part under LIKE).
- **Revisions:** changing `title` or `body` keeps the old text as a `note_revisions` row (`reason: 'edit'`, insert-only), at most one per field per window (`AICO_NOTE_REVISION_MINUTES`, default 5; measured from the field's last revision, so a snapshot lands every window, not once per save). Empty old text and unchanged text keep nothing. `reason: 'conflict'` is for sync.
- **Groceries:** the list note with `source = 'aico:groceries'`, kind `list`, title Groceries, made on first use. `groceries` works wherever a note id does in the API and CLI. If the owner deletes the list, the next use sets the old one aside (renames its `source`) and makes a fresh empty one.
- **Router:** the `notes` owner is live (`owners/notes.ts`, `local: true`, so no bytes are read or sent). `grocery_list`: each reading item becomes `item` or `item (quantity)`, unchecked, at the end of Groceries; a struck one is added unchecked with `hint: 'struck'`; the photo is attached; the capture becomes `filed` with `owner_ref` = the Groceries note id. No items read: `failed` ("I couldn't find any items on that list"; Send from the capture retries). `note`, `recipe`, `document`: one note (kind `note`, `source = capture:<id>`), title from the reading (else the text's first line, else the file name), body = the extracted text (else the caption), photo attached; `owner_ref` = the note id. Both keep the capture's file (`keep_copy`). A repeat for the same capture adds nothing, and what the owner deleted stays deleted. `HandOff` now carries `capture` (the row). `countHashRefs` counts attachments too, so a purge never removes a file a note holds. Captures read before this shipped and left `suggested` are not filed by themselves; Send on them works.
- **Deploy gotcha:** `--worker tether@default` alone rebuilds only that worker. Web changes need a plain `st service rebuild aico` too.

**API** (all under the Host/Origin guard; JSON camelCase; errors `{detail}`; 404 `That note is gone`, `That item is gone`, `That attachment is gone`; 422 for bad input; creates answer 201):

- `GET /api/notes?kind=note|list|prompt&label=L&pinned=true|false&archived=true|false|all&q=TEXT&limit=N&offset=N` returns `{notes: NoteSummary[], total}`. Default: live (not archived) notes, pinned first, then latest activity (title/text edit or any item change); `limit` default 100, max 500. Tombstones are never listed. `NoteSummary` = `{id, kind, title, pinned, archived, scope, source, createdAt, editedAt, updatedAt, origin, labels: string[], snippet (first 200 chars of the text, one line), unchecked, checked, attachmentCount, activityAt, preview: Item[] (first 6 unchecked)}`. `editedAt` moves only on title/text edits.
- `GET /api/notes/:id` returns `NoteDetail` = the summary fields except `snippet`/`preview`/`attachmentCount`/`activityAt`, plus `body`, `unchecked`, `checked`, `items: Item[]` (by position), `attachments: Attachment[]`. `Item` = `{id, noteId, text, checked, position, hint, updatedAt}`; `Attachment` = `{id, noteId, captureId, hash, name, mime, size, position, hasThumb}`.
- `POST /api/notes` `{kind?, title?, body?, pinned?, labels?: string[], items?: (string | {text, checked?})[]}` returns `NoteDetail` (201). Unknown keys are 422.
- `PATCH /api/notes/:id` `{title?, body?, pinned?, archived?, kind?}` returns `NoteDetail`. Only those keys.
- `DELETE /api/notes/:id` returns `{deleted: true, id}` (tombstone; the note drops out of lists and `GET` is 404).
- `POST /api/notes/:id/items` `{text, checked?, position?}` returns `Item` (201). No `position`: end of the list. `position` is a fractional number; to insert between two items send the midpoint of their positions.
- `PATCH /api/notes/:id/items/:itemId` `{text?, checked?, position?}` returns `Item`. `DELETE` the same path returns `{deleted: true, id}`.
- `PUT /api/notes/:id/labels` `{labels: string[]}` returns `{labels}` (sets the exact list; case-insensitive repeats dropped; 40 characters and 30 labels at most).
- `POST /api/notes/:id/attachments` `{captureId}` returns `Attachment` (201); 404 if the capture is gone, 409 if its file was handed off. Again for the same capture returns the same attachment. `DELETE /api/notes/:id/attachments/:attachmentId` removes it. `GET /api/notes/:id/attachments/:attachmentId/file|thumb|preview` serves the bytes by hash (same headers and rules as the capture routes), so a photo still shows after its capture is deleted.
- `GET /api/notes/:id/revisions?field=title|body` returns `{revisions: [{id, field, text, savedAt, reason}]}`, newest first (50).
- Limits: title 500, body 200,000, item 2,000 characters, 500 items per create.
- **`tether note`:** `list [--kind] [--label] [--q] [--limit]`, `get ID`, `add "title" [--body] [--list]`, `item add ID "text"`, `item check|uncheck ID ITEMID`, `groceries show`, `groceries add "text"...`; `--json` on all. Open items print before done ones.
- **Live check (workstation, 2026-11-02):** the owner's grocery photo, uploaded as a capture, was read as `grocery_list` in about 20 s and filed itself: Groceries got 21 items, all unchecked (3 carry `hint: struck`), the photo attached, the capture `filed` with `owner_ref` = the list's id and its file kept. Retry and Send on the filed capture answered 409, and uploading the same `client_id` again returned the same capture; the list stayed at 21 items and 1 attachment. `tether note groceries show`, `add`, `item add|check`, `list --q` and an unknown id (exit 1) worked. All of it was removed afterwards (items, attachment, capture and its blob), so Groceries starts empty. The re-delivery path (a hand-off that ran twice) is covered by tests only.
- **Left for the UI (Milestone 4b):** the Notes page (list with search, label filter, pin, archive, kind), the note editor (title/text with autosave, checklist with drag reorder via fractional `position`, labels, attachments, revisions view and restore through PATCH), the Groceries shortcut, the capture detail's "Filed in Notes" link (`route.ownerRef` is the note id; `route.url` is null for notes, so the link is the UI's), and removing the "coming soon" copy. Not built, by design: sync, import, export, reminders, a client-side offline queue.

### Milestone 4b as shipped (2026-11-02): the Notes screens

- **Where:** `/notes` (list) and `/notes?id=<note id>` (one note; `?id=groceries` works). The id is in the query, not the path, because the web app is a static export (like `/captures?id=`); a `/notes/<id>` route would need every id at build time. A Notes link (`NotesLauncher`) sits beside every Capture button (session list, rail, switcher, empty state, header), and the PWA manifest has Groceries and Notes shortcuts for a long-press on the phone icon.
- **List** (`components/notes/NoteList.tsx`): New note and New list, a Groceries shortcut on top (counts, or "Nothing on it yet"), search (`q`, debounced), an Archived toggle, label chips (filtered in the page from the labels of the loaded notes; the API has no label list), Pinned then Others, each card with title, snippet or the first three open items, open and done counts, attachment count and labels. Loading, empty (different words for search, label and archive), failed (Try again) and stale ("Couldn't refresh, this is the list from N ago") states. The list refreshes every 10 s like Captures.
- **Note** (`NoteEditor.tsx`, `NoteItems.tsx`, `NoteAttachments.tsx`, `NoteHistory.tsx`): title and text autosave through `useAutosave` (800 ms after typing stops, only changed fields, "Saved" / "Saving…" / "Couldn't save. Retry", sent at once when the app is hidden or the screen closes; an untouched draft follows a change from another device). Pin, History, Archive and Delete (confirm) in the bar; Note/List switch; labels (Enter adds, x removes). Items: Enter in the add box adds the next one (sent in typed order, shown dimmed as "Adding…", the text comes back with the reason if it fails); check, edit text (saves on Enter or leaving the box), remove; checked items move to a Done section with Clear checked. Reorder: a drag handle on a computer, a Reorder toggle with up/down buttons on a touch screen; the moved item gets the midpoint of its new neighbours (`positionAt`). An unchecked item with `hint: 'struck'` asks "Crossed out on the photo?" with a Check it button. Photos and files: thumbnails (thumb route, else the file or the HEIC preview) open full size in a new tab; Add photo or file opens the same `CapturePicker` as Capture; History lists earlier titles and texts (both fields merged, newest first) with Restore, which puts the old text in the draft so autosave sends the PATCH.
- **Capture detail:** a capture the router filed into Notes shows "Filed in Notes: <title>" linking to its note. The "coming soon" wording existed only in one test; it now uses another owner.
- **A photo added from a note is not routed:** the note's picker uploads the file as a capture (limits, types and thumbnail as for Capture), then `POST /api/notes/:id/attachments`. `ExtractWorker` now plans no route for a capture a note already holds (`NoteStore.hasCaptureAttachment`), so it is read (text kept on the capture) but never suggested to Groceries, a new note or another owner. No new flag or column. The window is the time between upload and attach (milliseconds against a read of seconds); a capture that fails to attach stays an ordinary capture.
- **`tether note`** prints times in local time (`stamp()`), as the other commands do.
- **Live check (workstation, phone viewport 390x844 and a 1440 desktop):** Groceries shortcut on an empty list, a new list with three items typed with Enter, one checked (2 open, 1 done on its card), reorder buttons, a note with a photo of the odometer (thumbnail, label), History with Restore, search by title, by item text and with no match. The odometer capture was read as `odometer` and its route stayed empty. Everything made was deleted afterwards, the photo's blob removed, Groceries left empty.
- **Left:** a New note that is left empty stays as an untitled note; no label list endpoint (chips come from the loaded notes, so only the newest 500 notes feed them); the hint check is tested but was not seen live (no API to add a struck item; the router sets it); no offline queue or sync UI (Milestones 5 to 8).

---

## Milestone 1b: Needs-you cards that ask for files

An agent can ask for photos or files. This reuses the ask plumbing: Tether stores the ask and delivers the answer, aico-web takes the upload, and the card gets one more block. Flag: `--files`; `--photos` is an alias.

### CLI (`tether/src/ask-cli.ts`)

```
tether ask create "Photo of the odometer?" --files 1 --files-hint "odometer, engine off"
tether ask create "Dealer invoices?" --files 1-5 --files-hint "service invoices, PDF or photo"
```
- `--files N` (exactly N) or `--files MIN-MAX` (0 to 20; `0-3` is optional). Aliases `--photos`, `--photo-hint`. `--files-hint TEXT`: one line, up to 100 characters.
- `tether ask get` and `list` show `wants files: 1-5 (hint)` and, once answered, one line per file (id, name, type, size, path, host). `--json` has the same.
- Asking the same open question again updates the wanted files, as it already updates the options.

### Tether (`tether/src/asks.ts`, `schema.ts`, `docs/api-v1.md` "Asks")

- Schema migration v30: `asks` gets `files_min INTEGER`, `files_max INTEGER`, `files_hint TEXT`, `files TEXT CHECK (files IS NULL OR json_valid(files))`.
- `AskRequest` and `parseAsk` accept `files: { min, max, hint }`. `Ask` gains `wantsFiles` (that object or null) and `files: AnswerFile[]`.
- `POST /v1/asks/:id/answer` accepts `files: AnswerFile[]`, at most `max`; `400 files_not_requested` if the ask wanted none. `AnswerFile = { id (12 hex), name, mime, size, path | null, host | null }`. An answer may be files only. Tether checks shapes, not content.
- `answerNote` adds `files: 2 (ids ...; read: tether capture get ID)` ahead of the existing tail, clipped by the existing room logic, so the wake line to the asking session carries the ids. Paths are in `tether ask get`, not in the wake line.

### aico-web (`web/server/src/asks.ts`, `captures.ts`)

- `validateAsk` accepts the new fields (it re-checks everything from Tether).
- Upload: the card posts each file to `POST /api/captures` with `ask_id`. The server asks Tether for the ask (`tetherCall`, as `Asks.act` does): `409 ask_closed` unless it is open or answered, `409 too_many_files` past `max`.
- Answer: `POST /api/asks/:askId/answer` accepts `files: [captureId, ...]`. The server checks each belongs to this ask and is not deleted, builds the `AnswerFile`s (absolute blob path on this host, `host` = this door's `hostName`) and forwards to Tether. Files may come with or without an option or note.
- Paths are readable on that host only. An agent on another host uses `tether capture file ID --out DIR`.
- Not covered: asks from sessions on a linked remote host. The hub does not federate asks today, so the card shows on the door whose Tether holds the ask.

### The card (`web/frontend/components/asks/NeedsYou.tsx`, `AskCard`)

A files block sits between the options and the note, using the shared `CapturePicker`: Take photo and Choose files, equal, multi-select; drag-drop and paste on desktop through `FileUploadDropzone`. `OwnerAsk` and `AskReply` in `lib/hooks/use-asks.ts` gain `wantsFiles`, `files` and `files?: string[]`.

| State | What the card shows |
| --- | --- |
| Idle | "0 of 1-3 files" and the hint. Send is off until the minimum is met. "Answer without files" always works (sends the note and `skippedFiles`). |
| Uploading | One row per file: thumbnail or icon, name, progress bar, Cancel. Send says "Waiting for 1 upload". |
| Saved | Thumbnail, name, size, and a remove button (tombstones the capture; it was tagged to this ask and never sent). |
| Failed | The reason in plain words ("Over 25 MB", "Can't store this kind of file", "Aico is unreachable, try again"), with Retry or Remove. Failed files are never sent. |
| Partial | Some saved, some failed: Send is on when saved is at least the minimum, and the card says "1 file failed and won't be sent". Below the minimum Send is off. |
| At the maximum | Both controls off, "3 of 3". |
| Answer failed | Uploads stay saved and tagged. The error shows under the card and Send retries without uploading again. |
| Ask closed meanwhile | "This question was closed. Your files are kept in Captures." The captures stay, tagged with the ask id. |
| Sent | The card leaves like any answered ask: "Sent to 'name': 2 files." The Answered tab shows thumbnails. |

### Tests for Milestone 1b

- Tether: `asks.test.ts` for parsing (ranges, hint, alias), re-ask update, files-only answer, `files_not_requested`, over max, `answerNote` clipping; the v30 migration on a v29 file; `ask-cli.test.ts` for the flags and output.
- aico-web: `asks.test.ts` for the pass-through, a capture from another ask refused, a closed ask, a double submit.
- Frontend: `NeedsYou.test.tsx` covers each row of the state table with a fake uploader; `SessionAsk.test.tsx` covers the in-session card.
- Live: file an ask from a real session with `--files 1-3`, answer from the phone with two photos and a PDF, confirm the session gets the wake line and `tether capture get` works.

---

## Data model after Milestone 4

The same sync columns (`updated_at`, `origin`, `prev`, `deleted`, `seq`) on every table.

- `notes(id, kind 'note'|'list'|'prompt', title, body, pinned, archived, scope, source, created_at, edited_at)`. `scope` keeps SummitFlow's `project_scope`. `source` is `summitflow:<id>` or `keep:<id>`, unique, so imports can be rerun. `edited_at` is the display time; `updated_at` is the sync clock.
- `note_items(id, note_id, text, checked, position REAL)`. Every list item is its own row, so two hosts adding to one list never collide. `position` is fractional, so an insert changes one row.
- `note_labels(id = note_id:label, note_id, label)`.
- `attachments(id, note_id, capture_id | NULL, hash, name, mime, size, position)`: a file on a note, by hash.
- `note_revisions(id, table_name, row_id, field, text, saved_at, reason 'conflict'|'edit')`: insert-only, so it never conflicts.
- Search: a local `notes_fts` FTS5 table rebuilt from rows, not synced. Check at build that Node's bundled SQLite has FTS5; if not, use `LIKE` (the data is small).
- Not in v1: reminders (car service due dates belong to portfolio-ai vehicles, with Nightshift push), sharing, the wife's list. Nothing here blocks them; an `owner` column can be added to `notes` later.

## Sync

Row-level, two-way. No CRDT library, no database replication. A generic engine in `web/server/src/sync/` works on a registry of `{ db, table, keyColumns }`, so it covers `notes.db` and the view state in `web.db`.

### Clock and ordering

- `updated_at` is a **hybrid logical clock** in ms: `max(Date.now(), highestSeen + 1)`, where `highestSeen` includes the peer's stamps. A host with a slow clock still sorts after anything it has received, so skew cannot make a later edit lose. Ties between hosts break by `origin` name.
- **Skew guard:** `GET /sync/hello` returns the peer's `now`. Each pull records `skew = peer.now - local.now - rtt/2` in `meta`, logs it, and shows it in the Hosts panel past 5 s. A batch with any `updated_at` more than a day ahead of local time is refused and the peer is marked "clock far ahead", so one bad clock cannot poison the HLC. Both hosts run chrony (checked on gem).
- `seq` is a per-database counter bumped by every local write and every applied remote row. A peer pulls "rows after my cursor", so order is exact without timestamps.
- A restored backup gets a new `db_id`. A peer that sees a new `db_id` resets its cursor to 0 and re-pulls everything; applying is idempotent.

### Conflict rule (per row)

For a remote row R and the local row L with the same key:
1. Same `updated_at` and `origin`: identical, skip.
2. `R.prev == L.updated_at`: R was made on top of L. Take R.
3. `L.prev == R.updated_at`: we are already past R. Skip.
4. Otherwise both sides edited from a common ancestor while apart. The newest (`updated_at`, then `origin`) wins the whole row. If text fields differ, the loser's text is saved as a `note_revisions` row with `reason='conflict'`. Nothing is silently lost.
- Adds never collide (random ids). A delete is a row with `deleted=1` and wins by the same rule. If an edit is newer than the delete, the note comes back and the deleted text is kept as a revision.
- `session_seen` merges by `max(seen_at)`, no tombstones.
- Tombstones are kept 180 days (config), then removed once both cursors are past them.

### Transport and auth

- aico-web opens a **second listener on a unix socket**, `$XDG_RUNTIME_DIR/aico/sync.sock`, mode 0600, serving only `/sync/*`. It is not on the TCP port the tunnel points at, so nothing public can reach it and the Host/Origin guard does not apply.
- `hosts.json` gets one optional field per host, `sync`: the remote path of that socket (for example `/run/user/1000/aico/sync.sock`). `tether/src/hub/hosts.ts` validates it like `socket`, and `linkArgv` in `tether/src/hub/link.ts` adds `-L <peerDir>/sync.sock:<remote sync path>` to the same ssh ControlMaster. So the existing `tether-link@<host>` unit carries sync, with its retry and backoff, and authentication is the ssh key the link already uses in each direction. aico-web finds peer sockets by reading hosts.json through a pure helper exported from `tether/client` (check `bundle.test.ts`'s import rule).
- Endpoints on the sync socket:
  - `GET /sync/hello` -> `{ db_id, host, now, schema_version, build_id, seq }`
  - `GET /sync/changes?set=notes|web&since=SEQ&limit=500` -> `{ rows: [{table, row}], next, more }`
  - `GET /sync/blob/:hash?v=thumb|preview` -> bytes or 404
  - `POST /sync/nudge` -> the peer wrote; pull soon
- **Pull loop** (per peer, serial): every 60 s and on a nudge, `hello`, then pages of `changes`, one transaction per page. After a local write the host nudges the peer, so it is current in about a second. Then it fetches every blob a live row references that is missing locally (original, then thumb and preview if the peer has them), writes to a temp file, checks the SHA-256 against the name, and renames. A mismatch is dropped and logged.
- A differing `schema_version` pauses sync ("update gem") but never blocks local use. Migrations are additive.
- Failures: peer or link down -> skip quietly, retry on the next tick; half a page -> nothing applied; duplicate delivery -> idempotent.

**Fleet link (2026-11-02):** the agreed fleet direction gives Aico its own Ominull-style link: connect out, a certificate per machine, approve to join. It's in the summitflow cleanup plan, "Aico fleet". Until that exists, sync uses the SSH forward above. Later the fleet link carries the same `/sync/*` socket API, so only the `-L` forward changes; the engine, endpoints and tests stay.

### View state in `web.db` (the per-server state fix)

- `panes`, `session_links` and `project_settings` get the sync columns in `web.db` schema version 2. The deletes in `db.ts` (`deletePane`, `unlink`, `pruneProjectSettings`, `deleteEmptyPanes`) become tombstones and reads filter them. So a tab made on one door appears on the other. Sessions stay in Tether; their ids are global (8 hex).
- `session_seen` syncs with the `max` rule.
- **Duplicate pushes:** `Asks.receive` (`asks.ts:188`) and `Shows.receive` (`shows.ts:114`) keep their `pushed` sets in memory, so two doors would push twice. The hub re-emits a peer's events with `host` set ([remote-hosts.md](remote-hosts.md) "Events"), so `background.ts` passes `asks.changed` and `show.requested` to those handlers only when `event.host` is null: **only the door whose Tether owns the session pushes.** Tested with two fake event streams.

## `vision-extract` and the capture router (Milestones 2 and 3)

### `vision-extract` (`web/server/src/vision-extract/`)

- Interface: `extract({ file, schema, hint }) -> { json, raw, route, ms }`. Schema in, validated JSON out; nothing is stored unless it validates.
- Route 1 (default): `agy -p "<prompt naming the file>" --model gemini-3.8-flash-low --output-format json --json-schema <schema file>`, on whichever host is up (tested 2026-11-02: 23 s, exact on a synthetic list). `agy` must be installed and signed in on gem too; you finish that login on the phone. The model name is config, not code.
- Route 2 (optional, config): Agent Hub, for when `agy` is unavailable. Callers see no difference.
- The runner is injected, so tests record the argv and return canned JSON. A pinned test checks the argv shape; the real call is a live lane.
- It reads the HEIC preview, never the HEIC. Spikes in Milestone 2: whether `agy` reads PDFs directly or needs `pdftoppm` pages, and whether it takes audio. If not, speech-to-text goes through Agent Hub's faster-whisper (`agent-hub/backend/app/services/voice/stt.py`) when the workstation is up, and the audio stays playable with "transcript pending" until then.
- **Background only.** The upload returns as soon as the blob is saved. The origin host's worker takes `status=new` rows, sets `extracting`, then writes `text`, `type`, `extract_json` and `ready` (or `failed` with a short reason and Retry). Only the origin host extracts a capture, so the hosts never both spend a call on it.

### The router

1. Classify (one call): the schema returns `{ type, confidence, title, text, summary }`, `type` being an id from the type table.
2. Typed extract (optional second call) with that type's schema: grocery items, odometer reading, service lines.
3. Look the type up: owner, action, files itself or needs a tap.
4. Hand off through the owner's adapter, or leave it `ready` with a suggestion.

The **type-to-owner map is data**: `web/server/capture-types.default.json`, overridable by `~/.config/aico/capture-types.json`. Each entry: `id`, `label`, `owner`, `schema`, `auto` (files itself), `confirm` (waits for one tap), `keep_copy` (whether Aico keeps the file and text after hand-off). A new type is a data row plus a schema file.

| Type | Owner | Behaviour |
| --- | --- | --- |
| `grocery` | aico notes | Items appended to the open Groceries list. Files itself. |
| `note`, `recipe`, `document` | aico notes | A note with the file attached. Files itself. |
| `receipt`, `shelf_tag` | portfolio-ai | One tap, then hand off and purge Aico's copy. |
| `odometer`, `service_invoice`, `vehicle_note` | portfolio-ai (vehicles, later) | One tap. Contract below. |
| unknown | none | Stays `ready`; suggestion chips on the detail view. |

`route_state` on the capture: `suggested`, `confirmed`, `filed`, `waiting` or `failed`. A capture that needs a tap raises one Nightshift tray todo (`sendNotice`, key `capture:<id>`), sent by the origin host only.

### portfolio-ai receipts (Milestone 3)

- The adapter `owners/portfolio-ai.ts` uses the existing API in `backend/app/api/captures.py`: `POST /api/captures` multipart with `file`, `client_id`, `member_scope=local`, `kind` (`receipt` or `shelf_tag`; a shelf tag cannot be a PDF), `store_name`, `note`. `client_id` is a UUIDv5 of our capture id, and `household_capture_service.save` already answers a repeat with the same row, so a retry never duplicates. It sends `X-Portfolio-Agent-Token` (the `HOUSEHOLD_AGENT_TOKEN_FILE` token, honoured only on loopback). `local_agent` may capture (`capture_path_allowed`); review and intake stay yours in portfolio-ai's own capture page.
- Reach: the backend listens on VM 180's loopback. The workstation already has the socket-activated forwarder `portfolio-prod-api` (`127.0.0.1:18000`, `ssh -W 127.0.0.1:8000 kasadis@apps.lan`). The gem LXC gets a copy with its own key. Config: `AICO_PORTFOLIO_URL`.
- **No second copy:** after a 2xx, Aico stores `owner_ref` (portfolio-ai's capture id), sets `filed`, and deletes the blob, thumb, preview, `text` and `extract_json`. The row keeps type, caption and the link. The deletion syncs because `hash` becomes NULL and unreferenced blobs are removed. Portfolio-ai encrypts its uploads, and Aico must not leave plaintext receipts behind.
- VM 180 off: `route_state='waiting'` ("Waiting for Portfolio AI"). The next sync tick checks the forwarder's `/health` and sends; "Send now" also works. No timer of its own.

### Vehicles hand-off (Milestone 9, after portfolio-ai builds vehicles)

Aico extracts; portfolio-ai owns vehicles, odometer and service records. The contract, so portfolio-ai can build to it: a `vehicle_event` per capture group: `{ capture_id, vehicle_hint, occurred_on, odometer: {value, unit} | null, services: [{kind, note}], files }`, posted as multipart to an endpoint portfolio-ai defines (proposed `POST /api/vehicles/captures`), idempotent on `capture_id`, answering a review row you confirm there. "Just changed the oil, rotated the tires" arrives as the caption or a transcribed audio file in the same `group_id` as the odometer photo.

## Two front doors and the gem deployment

| | davion-sidarli | gem LXC 190 `aico` |
| --- | --- | --- |
| aico-web, tether@default | yes (today) | yes, same build |
| `notes.db`, blobs | yes | yes |
| cloudflared for the `aico` tunnel | new | new |
| `agy`, `heif-convert`, `rclone` | `agy`, `rclone` present; add `libheif-examples` | all three installed |
| Tether link to the other | `tether-link@gem` | `tether-link@workstation` |

### What is on gem now (checked 2026-11-02)

Debian 13 PVE host, 30 GB RAM (about 24 GB free), 54 GB free on root, 310 GB free in the thin pool, chrony running, no Node, only `root`. Running guests: LXC 150 ominull-hub, 160 restic-append, 170 opencanary; the VMs are off. A cloudflared service already runs for `pve.summitflow.dev`. The Proxmox firewall drops everything except the workstation for ssh and 8006 (the `management` ipset), and `/root/RESCUE.md` says keep the host lean. `wake-ws` is a small Python script that broadcasts a magic packet on the LAN.

### Why an LXC, not the PVE host

- Untrusted files and a web app with a shell behind Access belong in a guest, like every other always-on service there. Node 22 (for `node:sqlite`, [ADR 0002](../adr/0002-runtime-and-packaging.md)), tmux and `libheif-examples` stay off the host.
- Cost: the guest needs its own ssh key to the workstation and to VM 180, a backup row, and its own `agy` login. Reaching the PVE host from it was blocked on purpose; you approved it on 2026-11-02 for the rescue shell and alerts only (Open question 1).

### The LXC

CT 190 `aico`: Debian 13, unprivileged, `nesting=1`, `onboot=1`, 2 cores, 2 GB RAM, 512 MB swap, 32 GB on `local-lvm`, a fixed address on `vmbr0` next to ominull-hub (.58); pick a free one at build. User `kasadis`, uid 1000, lingering, so socket paths match the workstation's. Node 22 under `/opt/node-current` like the workstation. Packages: tmux, git, curl, `libheif-examples`, `rclone`, cloudflared, `agy`.

### Install and keep updated

- The workstation checkout stays the source. New `scripts/deploy-remote.sh <host>` copies the git-tracked tree to the guest (rsync over ssh) and runs `scripts/install.sh --start` there, which already builds, installs Tether's release and renders the user units. The guest has no SummitFlow, so `st service rebuild` is not used on it. `hello.build_id` (git sha at build) shows in the Hosts panel; a build mismatch is a warning, a schema mismatch pauses sync.
- The guest's Tether runs `TETHER_HEADLESS=1`, like the work VMs.
- Deploy gem first, then the workstation, so a newer schema never reaches a host that cannot read it.
- Env drop-ins on both hosts: `AICO_HOST_NAME`, `AICO_PORTFOLIO_URL`. `AICO_WEB_ALLOWED_ORIGINS` already defaults to include `https://aico.summitflow.dev`.

### The `aico` tunnel with a connector on each host

- A new remote-managed tunnel `aico` serves only `aico.summitflow.dev` -> `http://localhost:3002`. The hostname's DNS moves from the workstation tunnel (`2757c3c8`) to it, and the `aico` ingress and Caddy vhost leave the workstation's `/etc/cloudflared/config.yml`. The Access application on the hostname is unchanged.
- Each host runs `cloudflared` for this tunnel with the same token (`cloudflared-aico.service`). Cloudflare spreads requests across live connectors and drops a dead one. Either host alone serves the page, and the two doors are equal because the data is synced, the build is the same, and each Tether links the other. The token is a credential: a root-only file on each host, never in the repo. The tunnel is created the same way as `cdd3c8b5` and `9483e71c`.
- **Tether links:** the workstation's `hosts.json` gets `gem` (ssh alias to the LXC, `socket`, `sync`). The LXC's gets `workstation` with `sync` and no wake command (see "Wake button" below). Sessions on one door show on the other, offline ones marked.
- Docs to update: `docs/remote-access.md` (one tunnel, two connectors, why a replica of the big tunnel is wrong), `docs/INSTALL.md` (the `sync` field, `deploy-remote.sh`), `docs/web-guide.md`.

### What each outage looks like

| Down | Works | Missing |
| --- | --- | --- |
| gem | terminals, notes, capture on the workstation door | receipt hand-off waits (VM 180 is on gem) |
| workstation | notes, capture, gem sessions | the workstation's terminals (shown offline), `st` |
| both | the installed PWA opens last-synced notes read-only | everything else |

### Wake button (on hold: owner said no for now, 2026-11-02; revisit only if they ask)

Not part of any milestone above. You said to run it by you first. Testing the wake itself is fine without asking.
- What it would be: the `workstation` entry in the LXC's `hosts.json` gets `wake: ["wake-ws"]`, so phone Aico shows a Wake button on the offline workstation. Tether runs `wake` only on an explicit create or button press and the link never powers anything on, so nothing wakes by itself. `wake-ws` would be a copy of the script in the LXC (it broadcasts a magic packet on the same LAN bridge; no `qm` and no host access).
- Known limit (RESCUE.md): it works after a shutdown, not after a power cut. For that, the BIOS "restore on AC power loss" option or the smart plug.
- Test, allowed now: shut the workstation down, send the packet from gem, time ping and Aico coming back. Result goes in the plan.
- Build only after you say yes.

## Nightly export, PWA cache and import (Milestones 7 and 8)

### Readable Drive copy

- Each host builds a staging folder (regenerable, under the data dir) and runs `rclone copy --update` to a `SummitFlow-Notes` folder on Drive. The command guard blocks `rclone sync` and deletes, so the export never deletes: a deleted note's old file stays until you clean the folder.
- Layout: `notes/<year>/<title-slug>-<id6>.md` (front matter, `- [ ]` items, labels, attachment links), `photos/<hash>.<ext>`, `captures.md`.
- Who runs it: gem at 03:30 if up; the workstation only when its link to gem is down then. The files are the same either way, so a double run is harmless.
- The route is the existing one (rclone, the same Drive account, a dedicated config, copy-only). See Open question 2 for the token.

### PWA read-only cache (`web/frontend/public/sw.js`)

- Today it passes everything through. New: cache the shell (`/`, `/captures`, `/notes`, `/_next/static/*`, cache-first for the immutable assets) and `GET /api/notes*`, `/api/captures*` and thumbs, network-first.
- **When both connectors are gone Cloudflare answers with an error page, it does not fail the fetch.** So the worker falls back to cache when the fetch throws, the status is 5xx, or the response lacks an `X-Aico-Host` header that aico-web will add to every response.
- A banner says "Both hosts are offline. Showing notes from <time>. Read-only." Writes are off; there is no offline queue (owner decision). The cache keeps the last 200 thumbs and clears on a version bump.

### Import (Milestone 8, an `aico-web` command `tnotes`)

- `tnotes import-summitflow` reads the 36 notes (`id, project_scope, type, title, content, tags, pinned, metadata, created_at, updated_at`) through `st db query`. `type=prompt` becomes `kind=prompt`; `project_scope` -> `scope` plus a `project:<scope>` label; tags -> labels; `source=summitflow:<id>`, so a rerun updates instead of duplicating.
- `tnotes import-keep <Takeout/Keep dir>`: you export from Google Takeout (Milestone 8 starts with that ask in Needs you). Mapping: `title`; `textContent` -> body; `listContent[{text,isChecked}]` -> a list with items; `labels[].name` -> labels; `isPinned`, `isArchived`; `createdTimestampUsec` -> `created_at`; `userEditedTimestampUsec` -> `edited_at`; `annotations` links -> appended to the body; `attachments[{filePath, mimetype}]` -> hashed into blobs and attached. Known Takeout quirk: the JSON says `.jpeg` where the file is `.jpg`, so files are found by name stem. Trashed notes are skipped and listed (`--include-trashed` brings them in). Colour and sharees are dropped and counted.
- **Completeness check** (`tnotes verify-keep`): every Keep JSON is a note or a named skip; every attachment file in the folder is stored and re-hashes to its blob; every referenced attachment exists. Anything unmatched is listed, never dropped quietly. `--dry-run` prints the same report without writing. Recipes and car records come first in the report for you to look at. Keep is not retired until the report is clean and you have seen it.
- After import come the separate items to remove the SummitFlow and agent-hub notes code (X4 in the plan).

## Milestones, each sized for one agent

| # | Milestone | Size | Depends on |
| --- | --- | --- | --- |
| 1 | **Capture v1**: durable store, button, list and detail, HEIC preview, `tether capture` | medium | none |
| 1b | **Photo and file asks**: Tether schema v30, CLI flags, card block | medium | 1 |
| 2 | **`vision-extract`**: module, worker, `tether capture result`, bake-off harness on the five real photos, PDF and audio spikes | medium | 1 |
| 3 | **Router and owners**: type table, suggestion UI, portfolio-ai receipts adapter and VM 180 forwarder, purge after hand-off | medium | 2 |
| 4 | **Notes**: tables, API, list/checklist/recipe UI, labels, pin, search, revisions, `tether note`; turns on the grocery and note owners | large (split server and UI if it runs long) | 1 |
| 5 | **Sync engine**: `web.db` v2, the `sync/` module, sync socket, `hosts.json` `sync` and link forward, blob copy, tombstone cleanup, push-door rule, split-brain tests | large | 1, 4 |
| 6 | **Gem LXC and second door**: CT 190, `deploy-remote.sh`, tunnel and two connectors, hosts.json both ways, VM 180 forwarder, backup row, docs, live outage tests | large, mostly operations | 5 |
| 7 | **Export and PWA cache** | small to medium | 4, 6 |
| 8 | **Import**: SummitFlow notes, Keep Takeout, verify report | medium | 4 |
| 9 | **Vehicles hand-off**, Aico side | small | 3 and portfolio-ai vehicles |

Each milestone ends with focused tests, `st check`, and a `st check budget` comparison. Aico is already over its target (100 s against 60 s), so new tests must stay cheap.

## Test plan

Rules: tests never cross the network (loopback ephemeral ports and temp unix sockets only), never spawn `agy`, `heif-convert`, `rclone` or `cloudflared` (injected runners), and never wait on real timers (fake clock, controllable link). The added tests should cost a few seconds in total.

- **Unit and route tests:** each milestone's list above.
- **Sync harness (`sync/harness.ts`):** two `NotesStore`s with separate fake clocks and a transport with `up()`, `down()` and a way to drop a request mid-page. All sync tests use it.
  - **Split-brain (the headline test):** link down. On host A add two list items, edit the title, delete a third item. On host B add two other items, edit the same title differently, edit the deleted item. Link up. Both hosts end identical: all four added items present, the newer title wins and the older is a `conflict` revision, the item edited after its delete returns with the deleted text kept as a revision, and a plain delete elsewhere stays deleted.
  - Skew: B's clock 10 minutes behind, then 10 minutes ahead. An edit made after receiving A's row always wins. A batch more than a day ahead is refused.
  - Idempotency: apply a page twice; stop halfway through a page; same result.
  - Restore: replace a store with an older file (new `db_id`); the peer resyncs from 0 and no row regresses.
  - Photos: a blob appears after its row; a corrupted download is rejected and retried; thumbs and previews copy; an unreferenced blob goes only after the grace period.
  - A tombstone is not cleaned while a peer has been away less than 180 days, so nothing is resurrected.
  - View state: a tab, link and project setting made on A appear on B; deleting a pane tombstones it on the other side; `session_seen` takes the max.
  - Push-door rule: two fake event streams, one with `host` set; exactly one notice goes out.
  - Schema mismatch: sync pauses and local use continues.
- **Router and owners:** the type table drives behaviour (a new row adds a type with no code change); grocery appends to the open list; the receipt adapter against a loopback fake of `/api/captures` (success purges, 5xx and VM-off give `waiting`, a repeat is idempotent).
- **Live lanes** (real hosts, not in `st check`):
  1. Phone PWA on the workstation door: take photo, choose files, answer an ask with `--files`.
  2. **Gem off:** add a list item from the phone, power gem on, the item appears there.
  3. **Workstation off:** capture and notes keep working on gem; then, as a test, shut it down, wake it with `wake-ws` from gem and time ping and Aico coming back (allowed without asking).
  4. **Both doors up:** edit the same list on each within a minute; one ask produces one Nightshift push.
  5. **Both off:** the installed PWA opens read-only from cache with the banner.
  6. Tunnel: stop one connector; the site keeps answering.
  7. Takeout: dry run, import, verify report, spot-check recipes and car notes.
  8. A real receipt photo through the router to portfolio-ai, with VM 180 on and off.

## Open questions (only the owner can answer)

1. **Decided 2026-11-02: yes, for those two uses only.** Let the aico LXC ssh into the Proxmox host? The firewall allows only the workstation today. Without it the phone still gets notes, capture and sessions in the LXC. With it (add the LXC's address to the `management` ipset, one restricted key) you also get a root rescue session on gem from the phone, and the gem door can send your phone a Nightshift push when the workstation is off (the push key lives on the PVE host). Recommendation: yes, for those two uses only. It is a security boundary, so it is yours to open. Milestones 1 to 5 do not depend on it.
2. **Decided 2026-11-02: its own limited token.** Drive token for the nightly export on gem. The export needs a Drive login on both hosts. Recommendation: a separate Google consent limited to files Aico creates (the `drive.file` scope) in its own `SummitFlow-Notes` folder, authorised privately like `scripts/authorize-backup-drive.sh`, so the backup's token is never copied to gem. The alternative is copying the backup's rclone config, which can read your whole backup. It is a credential, so yours to approve.
