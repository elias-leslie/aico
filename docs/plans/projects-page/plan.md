# Projects page and ROADMAP.md (replaces tasks) — owner approved 2026-11-06

Goal: each project has a checked-in `ROADMAP.md`; Aico shows a Projects page (list + detail timeline + runtime power) built from it, git, Status, Tether and fleet; agents get the project's Now/Next at session start; the task system is removed.

Mockup (approved): `mockup.html` (desktop/phone PNGs beside it). Critiques: `design-critique.md`, `adversarial-critique.md`.

## ROADMAP.md format (repo root)
```
# <Project name>
<one paragraph: what the project is>

## Now
- <item in plain words> (plan: docs/plans/x/plan.md)
## Next
- ...
## Later
- ...
```
- Only these three sections. No Done section: git is the done history. Optional `(plan: path)` suffix links a plan doc. An item may carry `(blocked: <reason>)`.
- Missing file = "No roadmap yet". Unparseable lines are shown raw, never dropped.
- Rules for agents: edit only the line you are working on; delete it in the same commit that finishes it; commit subjects are written for the owner's timeline. Adding/reordering items = owner or coordinator. Work spanning >1 session or >1 agent gets a plan doc linked from its line. In-session checklists stay native, never persisted.

## Data model
- ROADMAP.md parser: `packages/tasks/src/roadmap.ts` (`parseRoadmap(source)`, `readRoadmap(root)` -> null when the file is missing; also exports `ROADMAP_FILE`, `Roadmap`, `RoadmapItem`, `RoadmapProblem`). The Projects page and the `st commit` format check import this one parser (`@aico/tasks`). Lines that are not bullets and unknown `##` sections are kept (raw items, `other`) and listed in `problems` with the line number.
- Projects registry (`packages/tasks/src/projects.ts`) gains `runtime`: a JSON list of places stored in the project's `agent_configs.runtime` (no table change). Place = `{kind: "host"|"vm"|"ct", id?: number, node?: string, label: string, power: boolean, intent: "always"|"on-demand"|"off", machine?: string}`. `machine` is the Status machine name of that place. Host places have no id and `power: false`. Set with `aico projects runtime ID --set JSON` / `--clear` (`st projects` routes there); a bad place is refused with the reason. Data now: Aico = Workstation (host, davion-sidarli, always) + CT 190 (aico, always, power false); OmniNull = CT 150 (ominull-hub, always); Jobinator = CT 191 (jobinator, on-demand, owner confirmed); Portfolio AI = VM 180 (apps, on-demand). Projects with nothing deployed = [].
- Intent: `always` = should run, down is a problem unless the owner shut it down (stop mark, cleared when it is seen running again); `on-demand` = off is normal, running means expected on (silent rows are late); `off` = parked. Expected state comes from the observed power state, not from which button was pressed: agents and the owner start and stop guests with `aico vm`, Proxmox or the page, and the poller sees all of them. Helpers live in `packages/status` (`intent.ts`, exported from `@aico/status`): `expectedState(intent, running)` -> "on"|"off", `expectedOffSince(machineIntent)`. `StatusStore` keeps a `machine_intent` table (`power`, `powerSince`, `powerAt` = last observation) and exposes `syncIntents(declared)` (the server copies the registry's intents in; observed power survives), `setObservedPower(machine, running, at, since?)` (the poller feeds each Proxmox reading; an unreachable Proxmox feeds nothing, so the last reading and its `powerAt` stay and rows do not flip to late), `isExpectedOff(machine)`, `expectedOff()` (machine -> since), `intents()` and `markStopped(machine, at|null)` (owner shut it down / clear). There are no "in use" marks. Status `show()` shows an expected-off machine as `off` and its rows as unknown/"off", never late; a row whose last report predates the off time shows off too; `alerts.ts` does not page for them. A machine's own report after the stop time ends a stop mark; a machine with no report of its own has the mark ended by the poller when it sees the guest running again.
- Status rows need a project: backup rows now carry `project` from the backup source (`project_id`, external `owner_project`, and the `sourceProjects` map in `packages/ops/data/backups.json`), so badges count per project.

## API (web-server)
All under `packages/web-server/src/projects.ts` and `places.ts`.
- `GET /api/projects/overview` -> `[{id, name, archived, top: string|null, waiting: {askId, title}|null, runState: "running"|"stopped"|"down"|"starting"|"unknown"|null, problems: [{kind: "fail"|"quiet"|"publish"|"backup", count, worst: "failed"|"late"|"unknown"|"warn"}], agents: number, lastActivity: iso|null}]`. Sorted: waiting first, then problems (failed/late before warnings, then count), then recent activity; archived last, by name. `agents` counts live agent sessions of the project (not shells) and includes blocked ones; `waiting` is the oldest blocking open ask tied to the project (by its session's project, else requester = project id).
- `GET /api/projects/:id` -> `{id, name, overview, now[], next[], later[] (items: {text, plan?, blocked?, raw?}), roadmap: {found, editedAt: iso|null, problems: [{line, text, why}], other: [{...item}]}, places: [{...runtime place, state: "running"|"stopped"|"down"|"starting"|"unknown", since: iso|null, asOf: iso|null, busy: "start"|"shutdown"|"restart"|null, note?}], problems: [{kind, count, worst, rows:[{name, detail}]}], agents: [{sessionId, title, blocked}], waiting, runState, lastActivity}`. No ROADMAP.md: `roadmap.found` false, empty lists, `overview` falls back to the README intro. 404 for an unknown project. `session?` on items is not populated.
- `GET /api/projects/:id/timeline?before=<sha>&limit=40` -> `{days: [{date, commits: [{sha, subject, at, release?}]}], end: boolean, available: boolean}` from `git log` on the project root (`available` false: no root or not a repo). `limit` 1-100; a bad `before` is 422.
- `POST /api/projects/:id/places/:index/power {action: "start"|"shutdown"|"restart"}` -> the updated place view. Start, clean shutdown (guest `shutdown`) and clean reboot through Proxmox (SSH alias from fleet.json `proxmoxSsh`); there is no hard stop. Errors: 404 project/place, 422 not powered from the page (host, `power: false`) or bad action, 409 an action is already running or restart of a stopped place, 502 Proxmox refused, 503 no Proxmox access / unreachable / guest not listed. Marks: shutdown -> `markStopped`; start clears the stop; restart of an `always` place -> short stop mark. A refused action restores the marks.
- Place state comes from a server poller (`places.ts`, interval and timeouts in web-server config `projects.*`) with `asOf`; Proxmox unreachable -> "unknown" + last good `asOf` + `note`. A stopped place is "stopped" when it is expected off (parked, on-demand and stopped, or the owner stopped it), else "down". A running place's `since` is its observed start time.
- Not built: the "N rows belong to no project" footer (overview stays a plain array).

## Milestones
1. Server: registry `runtime`, roadmap parser, API above, poller, power actions + owner-stopped suppression, status project attribution. Tests.
2. Page: `/projects` route + nav entry, list/detail/timeline/power sheet/popover/all states per mockup, phone list↔detail. Lantern tokens only.
3. Agents: ROADMAP.md in each active project repo (carry the 52 task rows once: still-real → lines, pointer/done → drop), startup brief injects Now/Next, prompts/capability blocks drop the task lifecycle, task tables + `st create/claim/done/context` removed (keep projects registry, pulse, leases, `st commit`).

## Out of scope
- Neri and Neri Hunters repos/prompts: the Neri coordinator updates its own text.
- Editing the roadmap from the web/phone (later).
