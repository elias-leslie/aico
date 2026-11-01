// Tether's SQLite schema. Tables that Phase 3 imports from Aico's aico.db keep
// Aico's column names, types, defaults and CHECK constraints so the importer
// copies rows byte for byte. The only widening is the tmux_servers unit CHECK,
// which additionally admits non-default instance unit names.

export const SCHEMA_VERSION = 28

/** Aico's tmux_servers table (first defined by the retired desktop app),
 * plus `tether-<instance>-tmux-server-<id>.service` for non-default instances. */
export const TMUX_SERVERS_TABLE_SQL = `
  CREATE TABLE tmux_servers (
    id              TEXT PRIMARY KEY
                      CHECK(length(id) BETWEEN 8 AND 64
                        AND id NOT GLOB '*[^0-9a-f]*'),
    kind            TEXT NOT NULL
                      CHECK(kind IN ('managed', 'legacy-observed')),
    phase           TEXT NOT NULL
                      CHECK(phase IN ('provisioning', 'active', 'dead')),
    socket_path     TEXT NOT NULL UNIQUE
                      CHECK(substr(socket_path, 1, 1) = '/'),
    scope_unit      TEXT NOT NULL
                      CHECK(instr(scope_unit, '/') = 0 AND (
                        (kind = 'managed' AND (
                          scope_unit = 'aico-tmux-server-' || id || '.scope'
                          OR scope_unit = 'aico-tmux-server-' || id || '.service'
                          OR (scope_unit GLOB 'tether-[a-z0-9]*-tmux-server-*.service'
                            AND substr(scope_unit, -(length(id) + 8)) = id || '.service'
                            AND substr(scope_unit, -(length(id) + 21), 13) = '-tmux-server-')
                        ))
                        OR (kind = 'legacy-observed' AND scope_unit GLOB '*.scope')
                      )),
    control_group   TEXT,
    invocation_id   TEXT,
    server_pid      INTEGER,
    proc_starttime  TEXT,
    created_at      INTEGER NOT NULL CHECK(created_at >= 0),
    dead_at         INTEGER CHECK(dead_at IS NULL OR dead_at >= created_at),
    CHECK(kind = 'managed' OR phase <> 'provisioning'),
    CHECK(
      (phase = 'provisioning'
        AND control_group IS NULL AND invocation_id IS NULL
        AND server_pid IS NULL AND proc_starttime IS NULL AND dead_at IS NULL)
      OR
      (phase = 'active'
        AND control_group IS NOT NULL AND invocation_id IS NOT NULL
        AND server_pid IS NOT NULL AND server_pid > 0
        AND proc_starttime IS NOT NULL AND dead_at IS NULL)
      OR
      (phase = 'dead' AND dead_at IS NOT NULL AND (
        (control_group IS NULL AND invocation_id IS NULL
          AND server_pid IS NULL AND proc_starttime IS NULL)
        OR
        (control_group IS NOT NULL AND invocation_id IS NOT NULL
          AND server_pid IS NOT NULL AND server_pid > 0
          AND proc_starttime IS NOT NULL)
      ))
    )
  )`

/**
 * Session catalog: the identity columns of Aico's `widgets` table. View columns
 * (bounds, display, open) stay in Aico; `external_tmux_*` rows are never
 * imported. Column names match Aico so `INSERT ... SELECT` copies values
 * unchanged. Tether-only columns are at the end.
 */
export const SESSIONS_TABLE_SQL = `
  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY
                   CHECK(length(id) = 8 AND id NOT GLOB '*[^0-9a-f]*'),
    seq          INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    tool         TEXT NOT NULL DEFAULT 'shell',
    name         TEXT,
    project_id   TEXT,
    project_root TEXT,
    tmux_server_id    TEXT,
    tmux_allocation_state TEXT NOT NULL DEFAULT 'unallocated'
      CHECK(tmux_allocation_state IN ('unallocated', 'legacy-unclassified', 'bound', 'external')),
    tmux_session_id   TEXT,
    pane_id           TEXT,
    session_id       TEXT,
    scope_unit       TEXT,
    scope_invocation_id TEXT,
    pending_scope_unit TEXT,
    pending_scope_invocation_id TEXT,
    launch_state TEXT NOT NULL DEFAULT 'none'
      CHECK(launch_state IN ('none', 'gated', 'dispatched')),
    launch_nonce TEXT,
    lifecycle_version INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'aico'
      CHECK(origin IN ('aico', 'a-term', 'root', 'cli')),
    a_term_session_id TEXT
  )`

/** Aico's root_requests table, unchanged. Rows are tombstones after End. */
export const ROOT_REQUESTS_TABLE_SQL = `
  CREATE TABLE root_requests (
    request_id TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    widget_id TEXT NOT NULL UNIQUE,
    logical_session_id TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    lead_root_reference TEXT,
    facet_capsule_ref TEXT,
    created_at INTEGER NOT NULL
  )`

export const CONTEXT_HOOKS = [
  'claude-session-start',
  'codex-hooks',
  'pi-extension',
  'canonical-retrieval:antigravity',
] as const

/** Merged agent-tool registry (Aico TUI specs + the old web backend's agent_tools rows). */
export const AGENT_TOOLS_TABLE_SQL = `
  CREATE TABLE agent_tools (
    id            TEXT PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE
                    CHECK(length(slug) BETWEEN 1 AND 50 AND slug NOT GLOB '*[^a-z0-9_-]*'),
    name          TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
    argv          TEXT NOT NULL CHECK(json_valid(argv) AND json_type(argv) = 'array'),
    process_name  TEXT NOT NULL DEFAULT '' CHECK(length(process_name) <= 100),
    description   TEXT,
    color         TEXT CHECK(color IS NULL OR length(color) <= 20),
    display_order INTEGER NOT NULL DEFAULT 0,
    is_default    INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    enabled       INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    aliases       TEXT NOT NULL DEFAULT '[]'
                    CHECK(json_valid(aliases) AND json_type(aliases) = 'array'),
    context_hook  TEXT CHECK(context_hook IS NULL OR context_hook IN (${CONTEXT_HOOKS.map((hook) => `'${hook}'`).join(', ')})),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL CHECK(updated_at >= created_at)
  )`

export const INDEXES_SQL = `
  CREATE UNIQUE INDEX tmux_servers_one_live_managed_service
    ON tmux_servers(kind)
    WHERE kind = 'managed' AND phase <> 'dead' AND scope_unit GLOB '*.service';
  CREATE UNIQUE INDEX tmux_servers_managed_scope_once
    ON tmux_servers(scope_unit)
    WHERE kind = 'managed';
  CREATE INDEX sessions_tmux_server_id ON sessions(tmux_server_id);
  CREATE UNIQUE INDEX agent_tools_one_default ON agent_tools(is_default) WHERE is_default = 1;
`

/**
 * v2: session IDs are never reused, even after End (docs/api-v1.md Identity).
 * Ended rows are deleted from `sessions`; this trigger keeps their IDs in the
 * same transaction as the delete, so no crash window can free an ID.
 */
export const RETIRED_SESSION_IDS_SQL = `
  CREATE TABLE retired_session_ids (
    id         TEXT PRIMARY KEY
                 CHECK(length(id) = 8 AND id NOT GLOB '*[^0-9a-f]*'),
    retired_at INTEGER NOT NULL
  );
  CREATE TRIGGER sessions_retire_id AFTER DELETE ON sessions
  BEGIN
    INSERT OR IGNORE INTO retired_session_ids (id, retired_at)
      VALUES (old.id, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  END;
`

/** v3: which app requested a root (the web app or the desktop). The tombstone keeps it. */
export const ROOT_ORIGIN_SQL = `
  ALTER TABLE root_requests ADD COLUMN origin TEXT NOT NULL DEFAULT 'aico'
    CHECK(origin IN ('aico', 'a-term'));
`

/** v4: coordinators (docs/api-v1.md Coordinators). `coordinator` marks a
 * session that coordinates lanes; `coordinator_id` names the root coordinator
 * that launched a session; `coordinator_color` is the coordinator's palette
 * colour, kept on both so a lane keeps its colour after the coordinator ends. */
export const COORDINATOR_SQL = `
  ALTER TABLE sessions ADD COLUMN coordinator INTEGER NOT NULL DEFAULT 0
    CHECK(coordinator IN (0, 1));
  ALTER TABLE sessions ADD COLUMN coordinator_id TEXT
    CHECK(coordinator_id IS NULL OR (length(coordinator_id) = 8 AND coordinator_id NOT GLOB '*[^0-9a-f]*'));
  ALTER TABLE sessions ADD COLUMN coordinator_color TEXT
    CHECK(coordinator_color IS NULL OR coordinator_color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]');
`

/** v16: the session that launched this one (`parentId`), a lane of the same
 * root coordinator or the coordinator itself; the lists nest by it. Null on
 * coordinators and on sessions from before it was recorded. */
export const PARENT_SQL = `
  ALTER TABLE sessions ADD COLUMN parent_id TEXT
    CHECK(parent_id IS NULL OR (length(parent_id) = 8 AND parent_id NOT GLOB '*[^0-9a-f]*'));
`

/** v5: owner settings Tether keeps as data, one JSON value per key
 * (`memory_policy`: src/memory-policy.ts). */
export const SETTINGS_SQL = `
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 64),
    value      TEXT NOT NULL CHECK(json_valid(value)),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
  );
`

/** Root declarations are creation metadata; imported roots remain undeclared. */
export const ROOT_WORK_ROLE_SQL = `
  ALTER TABLE root_requests ADD COLUMN work_role TEXT;
  ALTER TABLE root_requests ADD COLUMN work_role_display_name TEXT;
`

/**
 * v10: session wakes (scheduled check-ins, src/wakes.ts). A wake names its
 * session while the session exists. There is no foreign key: a wake the owner
 * kept past End survives the row, detached (`session_id` NULL) with the
 * ended session's snapshot in `ended_session`. Every other wake goes with its
 * session, whichever path deleted the row.
 */
export const WAKES_SQL = `
  CREATE TABLE IF NOT EXISTS wakes (
    id            TEXT PRIMARY KEY
                    CHECK(length(id) = 12 AND id NOT GLOB '*[^0-9a-f]*'),
    session_id    TEXT
                    CHECK(session_id IS NULL OR (length(session_id) = 8 AND session_id NOT GLOB '*[^0-9a-f]*')),
    due_at        INTEGER NOT NULL CHECK(due_at >= 0),
    note          TEXT NOT NULL CHECK(length(note) BETWEEN 1 AND 2000),
    created_at    INTEGER NOT NULL CHECK(created_at >= 0),
    created_by    TEXT NOT NULL CHECK(created_by IN ('agent', 'owner')),
    kept          INTEGER NOT NULL DEFAULT 0 CHECK(kept IN (0, 1)),
    ended_session TEXT CHECK(ended_session IS NULL OR json_valid(ended_session)),
    attempts      INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    last_error    TEXT,
    CHECK(session_id IS NOT NULL OR (kept = 1 AND ended_session IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS wakes_due_at ON wakes(due_at);
  CREATE INDEX IF NOT EXISTS wakes_session_id ON wakes(session_id);
  CREATE TRIGGER IF NOT EXISTS sessions_end_wakes AFTER DELETE ON sessions
  BEGIN
    DELETE FROM wakes WHERE session_id = old.id AND kept = 0;
    UPDATE wakes SET session_id = NULL WHERE session_id = old.id;
  END;
`

/**
 * v11: agent shares (src/show.ts). A share points at files or folders where
 * they already are (`paths`, a JSON array of absolute real paths) or at a
 * link (`url`); nothing is copied. Rows past the retention are dropped.
 */
export const SHARES_SQL = `
  CREATE TABLE IF NOT EXISTS shares (
    id         TEXT PRIMARY KEY
                 CHECK(length(id) = 12 AND id NOT GLOB '*[^0-9a-f]*'),
    session_id TEXT
                 CHECK(session_id IS NULL OR (length(session_id) = 8 AND session_id NOT GLOB '*[^0-9a-f]*')),
    title      TEXT CHECK(title IS NULL OR length(title) BETWEEN 1 AND 120),
    paths      TEXT CHECK(paths IS NULL OR json_valid(paths)),
    url        TEXT,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    CHECK((paths IS NULL) <> (url IS NULL))
  );
  CREATE INDEX IF NOT EXISTS shares_created_at ON shares(created_at);
`

/**
 * v12: Agent Hub sessions (src/agent-hub/). `sessions.backend` says what holds
 * the session: a tmux pane (`tmux`, every earlier row) or an Agent Hub session
 * (`agent-hub`, no pane, so every tmux column stays at its never-allocated
 * default). `agent_hub_sessions` keeps what Tether needs to find that session
 * again after a restart: the Agent Hub session id Tether picked before it
 * created it, the agent, and whether it was created and its first prompt
 * posted. `agent_hub_queue` holds follow-ups waiting for the running turn to
 * end. Both go with the session row, whichever path deleted it.
 */
export const AGENT_HUB_BACKEND_SQL = `
  ALTER TABLE sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'tmux'
    CHECK(backend IN ('tmux', 'agent-hub'));
`

/**
 * v13: a queued follow-up keeps the model chosen when it was sent: NULL asks
 * for the session's model (a row queued before v13), '' for the agent's own
 * routing, anything else is a catalog model id.
 */
export const AGENT_HUB_QUEUE_MODEL_SQL = `
  ALTER TABLE agent_hub_queue ADD COLUMN model TEXT;
`

/**
 * v14: a queued follow-up keeps the thinking level chosen when it was sent:
 * NULL or '' for the model's own default, anything else a level Agent Hub's
 * turn API takes.
 */
export const AGENT_HUB_QUEUE_THINKING_SQL = `
  ALTER TABLE agent_hub_queue ADD COLUMN thinking_level TEXT;
`

export const AGENT_HUB_SQL = `
  CREATE TABLE IF NOT EXISTS agent_hub_sessions (
    session_id     TEXT PRIMARY KEY
                     CHECK(length(session_id) = 8 AND session_id NOT GLOB '*[^0-9a-f]*'),
    hub_session_id TEXT NOT NULL UNIQUE CHECK(length(hub_session_id) BETWEEN 8 AND 64),
    agent_slug     TEXT NOT NULL CHECK(length(agent_slug) BETWEEN 1 AND 100),
    model          TEXT CHECK(model IS NULL OR length(model) BETWEEN 1 AND 128),
    created        INTEGER NOT NULL DEFAULT 0 CHECK(created IN (0, 1)),
    prompt_sent    INTEGER NOT NULL DEFAULT 0 CHECK(prompt_sent IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS agent_hub_queue (
    id         INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL
                 CHECK(length(session_id) = 8 AND session_id NOT GLOB '*[^0-9a-f]*'),
    text       TEXT NOT NULL CHECK(length(text) > 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0)
  );
  CREATE INDEX IF NOT EXISTS agent_hub_queue_session ON agent_hub_queue(session_id, id);
  CREATE TRIGGER IF NOT EXISTS sessions_end_agent_hub AFTER DELETE ON sessions
  BEGIN
    DELETE FROM agent_hub_queue WHERE session_id = old.id;
    DELETE FROM agent_hub_sessions WHERE session_id = old.id;
  END;
`

/**
 * v17: owner asks (src/asks.ts). A question an agent puts to the owner, with
 * optional choices, and the owner's answer. `session_id` is the asking session
 * (no foreign key: an ask outlives its session, read with `tether ask get`);
 * without one, `requester` names who asked. One open ask per asker and
 * question (`question_hash`). `wake_id` is the check-in that carries the
 * answer to the session until it is delivered.
 */
export const ASKS_SQL = `
  CREATE TABLE IF NOT EXISTS asks (
    id            TEXT PRIMARY KEY
                    CHECK(length(id) = 12 AND id NOT GLOB '*[^0-9a-f]*'),
    session_id    TEXT
                    CHECK(session_id IS NULL OR (length(session_id) = 8 AND session_id NOT GLOB '*[^0-9a-f]*')),
    requester     TEXT CHECK(requester IS NULL OR length(requester) BETWEEN 1 AND 60),
    question_hash TEXT NOT NULL,
    question      TEXT NOT NULL CHECK(length(question) BETWEEN 1 AND 200),
    options       TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(options)),
    recommended   INTEGER,
    body          TEXT,
    command       TEXT,
    share_id      TEXT,
    blocking      INTEGER NOT NULL DEFAULT 0 CHECK(blocking IN (0, 1)),
    state         TEXT NOT NULL DEFAULT 'open'
                    CHECK(state IN ('open', 'answered', 'done', 'withdrawn')),
    answer        TEXT,
    note          TEXT,
    wake_id       TEXT,
    delivery      TEXT CHECK(delivery IS NULL OR delivery IN ('wake', 'pull')),
    created_at    INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at    INTEGER NOT NULL CHECK(updated_at >= 0),
    answered_at   INTEGER,
    CHECK(session_id IS NOT NULL OR requester IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS asks_state ON asks(state, updated_at);
  CREATE INDEX IF NOT EXISTS asks_session ON asks(session_id);
`

/**
 * v18: lane reports (src/lane-reports.ts). A lane launched with
 * `st aico create` tells whoever launched it when it finishes a turn, is
 * blocked or ends.
 * - `sessions.launched`: the lineage came from `launchedBy` (a launch, a
 *   kept-wake relaunch or the hub's lineage), not an owner's mark or join.
 *   Rows from before v18 stay 0, so nothing is backfilled.
 * - `wakes.kind`/`source`: a delivery row is a scheduled check-in (`time`) or
 *   an event line (`event`, `source` names what it reports). Only `time` rows
 *   count against the cap and show as check-ins.
 * - `lane_reports`: the per-lane cursor (per host; '' is this computer). The
 *   agent's own time of the last finished turn reported or absorbed, when the
 *   last finished line was queued, the last blocked episode reported, the
 *   generation, and the title and lineage snapshot an `ended` line needs.
 * - `lane_watches`: `st aico watch` (an explicit watch) and `st aico unwatch`
 *   (an exception to lineage). They go with the watcher.
 * - `lane_outbox`: an `ended` written by the delete trigger in the same
 *   transaction as the delete, so a crash cannot lose it; the reporter turns
 *   it into delivery rows.
 */
export const LANE_REPORTS_COLUMNS: readonly { table: string; column: string; sql: string }[] = [
  {
    table: 'wakes',
    column: 'kind',
    sql: "ALTER TABLE wakes ADD COLUMN kind TEXT NOT NULL DEFAULT 'time' CHECK(kind IN ('time', 'event'))",
  },
  {
    table: 'wakes',
    column: 'source',
    sql: 'ALTER TABLE wakes ADD COLUMN source TEXT CHECK(source IS NULL OR length(source) BETWEEN 1 AND 120)',
  },
  {
    table: 'sessions',
    column: 'launched',
    sql: 'ALTER TABLE sessions ADD COLUMN launched INTEGER NOT NULL DEFAULT 0 CHECK(launched IN (0, 1))',
  },
]

export const LANE_REPORTS_SQL = `
  CREATE TABLE IF NOT EXISTS lane_reports (
    host             TEXT NOT NULL DEFAULT '' CHECK(length(host) <= 64),
    lane             TEXT NOT NULL CHECK(length(lane) = 8 AND lane NOT GLOB '*[^0-9a-f]*'),
    generation       TEXT,
    finished_at      INTEGER NOT NULL DEFAULT 0,
    finished_sent_at INTEGER NOT NULL DEFAULT 0,
    blocked_at       INTEGER NOT NULL DEFAULT 0,
    reset            INTEGER NOT NULL DEFAULT 1 CHECK(reset IN (0, 1)),
    ended            INTEGER NOT NULL DEFAULT 0 CHECK(ended IN (0, 1)),
    title            TEXT,
    request_id       TEXT,
    coordinator_id   TEXT,
    parent_id        TEXT,
    launched         INTEGER NOT NULL DEFAULT 0 CHECK(launched IN (0, 1)),
    updated_at       INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY (host, lane)
  );
  CREATE TABLE IF NOT EXISTS lane_watches (
    watcher    TEXT NOT NULL CHECK(length(watcher) = 8 AND watcher NOT GLOB '*[^0-9a-f]*'),
    lane       TEXT NOT NULL CHECK(length(lane) = 8 AND lane NOT GLOB '*[^0-9a-f]*'),
    mode       TEXT NOT NULL CHECK(mode IN ('watch', 'unwatch')),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY (watcher, lane),
    CHECK(watcher <> lane)
  );
  CREATE TABLE IF NOT EXISTS lane_outbox (
    id             INTEGER PRIMARY KEY,
    lane           TEXT NOT NULL,
    at             INTEGER NOT NULL,
    coordinator_id TEXT,
    parent_id      TEXT,
    launched       INTEGER NOT NULL,
    title          TEXT,
    request_id     TEXT
  );
  CREATE TRIGGER IF NOT EXISTS sessions_end_lane AFTER DELETE ON sessions
  WHEN (old.launched = 1 AND old.coordinator_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM lane_watches WHERE lane = old.id AND mode = 'watch')
  BEGIN
    INSERT INTO lane_outbox (lane, at, coordinator_id, parent_id, launched, title, request_id)
      VALUES (
        old.id,
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
        old.coordinator_id,
        old.parent_id,
        old.launched,
        COALESCE((SELECT title FROM lane_reports WHERE host = '' AND lane = old.id), old.name),
        COALESCE(
          (SELECT request_id FROM lane_reports WHERE host = '' AND lane = old.id),
          (SELECT request_id FROM root_requests WHERE widget_id = old.id)
        )
      );
  END;
  CREATE TRIGGER IF NOT EXISTS sessions_end_lane_watches AFTER DELETE ON sessions
  BEGIN
    DELETE FROM lane_watches WHERE watcher = old.id;
  END;
`

/**
 * v19: general waits (src/waits.ts). An agent's wait on its own session: a
 * condition (`kind`, `ref`, `until`), a deadline and an optional note. It
 * fires once (`seq` compare-and-set), when the condition holds or at the
 * deadline, and queues one event line for the waiter (wakes, kind `event`,
 * source `wait:<id>`).
 * - `waiter`: the session that hears it; NULL for a `--block` client, or
 *   once a kept wait (`kept`, End with keepWakes) outlived its session, with
 *   the ended session's snapshot in `ended_session`.
 * - `host`: where `ref` lives ('' is this computer).
 * - `since`: "finished" counts turns that ended after this.
 * - `cursor`: the target's last observed state and names (JSON), for the
 *   timeout line and lines after the target is gone.
 * - `key`: the same key from the same waiter names the same wait until it is
 *   cancelled or pruned.
 * `session_sends`: when a session last sent a follow-up to another
 * (`st aico root send`), the default `since` of a wait on it.
 */
export const WAITS_SQL = `
  CREATE TABLE IF NOT EXISTS waits (
    id            TEXT PRIMARY KEY
                    CHECK(length(id) = 12 AND id NOT GLOB '*[^0-9a-f]*'),
    waiter        TEXT
                    CHECK(waiter IS NULL OR (length(waiter) = 8 AND waiter NOT GLOB '*[^0-9a-f]*')),
    kind          TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 20),
    ref           TEXT NOT NULL CHECK(length(ref) BETWEEN 1 AND 120),
    host          TEXT NOT NULL DEFAULT '' CHECK(length(host) <= 64),
    until         TEXT NOT NULL CHECK(length(until) BETWEEN 1 AND 20),
    since         INTEGER NOT NULL CHECK(since >= 0),
    deadline      INTEGER NOT NULL CHECK(deadline >= 0),
    key           TEXT CHECK(key IS NULL OR length(key) BETWEEN 1 AND 64),
    note          TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 200),
    armed_at      INTEGER NOT NULL CHECK(armed_at >= 0),
    seq           INTEGER NOT NULL DEFAULT 0 CHECK(seq >= 0),
    cursor        TEXT CHECK(cursor IS NULL OR json_valid(cursor)),
    state         TEXT NOT NULL DEFAULT 'armed'
                    CHECK(state IN ('armed', 'fired', 'timed_out', 'cancelled')),
    outcome       TEXT CHECK(outcome IS NULL OR outcome IN ('until', 'timeout', 'gone')),
    line          TEXT CHECK(line IS NULL OR length(line) BETWEEN 1 AND 2000),
    fired_at      INTEGER,
    kept          INTEGER NOT NULL DEFAULT 0 CHECK(kept IN (0, 1)),
    ended_session TEXT CHECK(ended_session IS NULL OR json_valid(ended_session)),
    CHECK(kept = 0 OR ended_session IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS waits_waiter ON waits(waiter, state);
  CREATE INDEX IF NOT EXISTS waits_ref ON waits(ref, state);
  CREATE UNIQUE INDEX IF NOT EXISTS waits_key ON waits(coalesce(waiter, ''), key)
    WHERE key IS NOT NULL AND state <> 'cancelled';
  CREATE TABLE IF NOT EXISTS session_sends (
    sender TEXT NOT NULL CHECK(length(sender) = 8 AND sender NOT GLOB '*[^0-9a-f]*'),
    target TEXT NOT NULL CHECK(length(target) = 8 AND target NOT GLOB '*[^0-9a-f]*'),
    at     INTEGER NOT NULL CHECK(at >= 0),
    PRIMARY KEY (sender, target)
  );
  CREATE TRIGGER IF NOT EXISTS sessions_end_waits AFTER DELETE ON sessions
  BEGIN
    DELETE FROM waits WHERE waiter = old.id AND kept = 0;
    UPDATE waits SET waiter = NULL WHERE waiter = old.id;
    DELETE FROM session_sends WHERE sender = old.id OR target = old.id;
  END;
`

/**
 * v20: per-session entries (src/lifecycle/entries.ts). A root created with
 * `entry` runs its agent through that program from this host's entries.json
 * (`<argv> <arg> -- /bin/sh -c '<line>'`), on every launch: restart, crash
 * recovery and reboot restore read it here. It goes with the session.
 */
export const SESSION_ENTRIES_SQL = `
  CREATE TABLE IF NOT EXISTS session_entries (
    session_id TEXT PRIMARY KEY
                 CHECK(length(session_id) = 8 AND session_id NOT GLOB '*[^0-9a-f]*'),
    name       TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
    arg        TEXT NOT NULL CHECK(length(arg) BETWEEN 1 AND 80)
  );
  CREATE TRIGGER IF NOT EXISTS sessions_end_entry AFTER DELETE ON sessions
  BEGIN
    DELETE FROM session_entries WHERE session_id = old.id;
  END;
`

/**
 * v23: a root's explicit launch options (`model`, `reasoningEffort`,
 * `daybreak`, `agentHubContext` on `POST /v1/roots`), so crash recovery,
 * restart, wakes and reboot restore launch the agent with them as the create
 * did. Written once, with the root's reservation; null fields were not given.
 */
export const SESSION_LAUNCH_OPTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS session_launch_options (
    session_id        TEXT PRIMARY KEY
                        CHECK(length(session_id) = 8 AND session_id NOT GLOB '*[^0-9a-f]*'),
    model             TEXT CHECK(model IS NULL OR length(model) BETWEEN 1 AND 200),
    reasoning_effort  TEXT CHECK(reasoning_effort IS NULL OR length(reasoning_effort) BETWEEN 1 AND 40),
    daybreak          INTEGER CHECK(daybreak IS NULL OR daybreak IN (0, 1)),
    agent_hub_context INTEGER CHECK(agent_hub_context IS NULL OR agent_hub_context IN (0, 1))
  );
  CREATE TRIGGER IF NOT EXISTS sessions_end_launch_options AFTER DELETE ON sessions
  BEGIN
    DELETE FROM session_launch_options WHERE session_id = old.id;
  END;
`

/**
 * v24: who ended a lane (src/lane-reports.ts). `session_end_requests` holds
 * the `endedBy` an End names (the session that asked for it) while that End
 * runs; the delete trigger copies it into `lane_outbox.ended_by`, and the
 * reporter sends that session no `ended` line. The handler removes the mark
 * once End answers, and startup clears any left by a crash. Rows written
 * before v24 have no `ended_by` and report as before.
 */
export const LANE_ENDED_BY_COLUMNS: readonly { table: string; column: string; sql: string }[] = [
  {
    table: 'lane_outbox',
    column: 'ended_by',
    sql: "ALTER TABLE lane_outbox ADD COLUMN ended_by TEXT CHECK(ended_by IS NULL OR (length(ended_by) = 8 AND ended_by NOT GLOB '*[^0-9a-f]*'))",
  },
]

export const LANE_ENDED_BY_SQL = `
  CREATE TABLE IF NOT EXISTS session_end_requests (
    session_id TEXT PRIMARY KEY
                 CHECK(length(session_id) = 8 AND session_id NOT GLOB '*[^0-9a-f]*'),
    ended_by   TEXT NOT NULL
                 CHECK(length(ended_by) = 8 AND ended_by NOT GLOB '*[^0-9a-f]*'),
    at         INTEGER NOT NULL CHECK(at >= 0)
  );
  DROP TRIGGER IF EXISTS sessions_end_lane;
  CREATE TRIGGER sessions_end_lane AFTER DELETE ON sessions
  WHEN (old.launched = 1 AND old.coordinator_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM lane_watches WHERE lane = old.id AND mode = 'watch')
  BEGIN
    INSERT INTO lane_outbox (lane, at, coordinator_id, parent_id, launched, title, request_id, ended_by)
      VALUES (
        old.id,
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
        old.coordinator_id,
        old.parent_id,
        old.launched,
        COALESCE((SELECT title FROM lane_reports WHERE host = '' AND lane = old.id), old.name),
        COALESCE(
          (SELECT request_id FROM lane_reports WHERE host = '' AND lane = old.id),
          (SELECT request_id FROM root_requests WHERE widget_id = old.id)
        ),
        (SELECT ended_by FROM session_end_requests WHERE session_id = old.id)
      );
  END;
`

/**
 * v25: repeat went-idle lines back off (src/lane-reports.ts).
 * `lane_reports.finished_streak` counts the went-idle lines sent since the
 * lane's receiver last acted on it (a send, a wait on it), its generation
 * changed, or it was blocked or ended; a repeat needs a longer quiet idle.
 */
export const LANE_STREAK_COLUMNS: readonly { table: string; column: string; sql: string }[] = [
  {
    table: 'lane_reports',
    column: 'finished_streak',
    sql: 'ALTER TABLE lane_reports ADD COLUMN finished_streak INTEGER NOT NULL DEFAULT 0 CHECK(finished_streak >= 0)',
  },
]

/**
 * v26: model switches (src/model-switch.ts). `lane_reports.model_key` is the
 * last model switch a lane's line went out for (its `modelSwitch.key`), so
 * each switch is told once.
 */
export const LANE_MODEL_COLUMNS: readonly { table: string; column: string; sql: string }[] = [
  {
    table: 'lane_reports',
    column: 'model_key',
    sql: 'ALTER TABLE lane_reports ADD COLUMN model_key TEXT',
  },
]

/**
 * v27: a `--block` client's session (src/waits.ts). `waits.armed_by` is the
 * session a blocking wait was armed from (the request's `by`; a wait with a
 * waiter hears through that waiter): the session that hears the line, so a
 * lane line it already gets from the wait isn't sent again
 * (src/lane-reports.ts), and its wait counts as acting on the lane.
 */
export const WAITS_ARMED_BY_COLUMNS: readonly { table: string; column: string; sql: string }[] = [
  {
    table: 'waits',
    column: 'armed_by',
    sql: "ALTER TABLE waits ADD COLUMN armed_by TEXT CHECK(armed_by IS NULL OR (length(armed_by) = 8 AND armed_by NOT GLOB '*[^0-9a-f]*'))",
  },
]

/**
 * v28: delivery classes (src/wakes.ts). `wakes.ride` marks an event line as
 * ride-along (1): it never pastes or wakes a session on its own, and joins the
 * session's next wake paste or its next natural turn (`GET /v1/sessions/:id/due?ride=1`).
 * Rows from before v28 are 0: wake class, as before.
 */
export const WAKES_RIDE_COLUMNS: readonly { table: string; column: string; sql: string }[] = [
  {
    table: 'wakes',
    column: 'ride',
    sql: 'ALTER TABLE wakes ADD COLUMN ride INTEGER NOT NULL DEFAULT 0 CHECK(ride IN (0, 1))',
  },
]

/**
 * v21: deliveries (src/deliveries.ts). A line another owner queued on a
 * session's delivery queue (`POST /v1/sessions/:id/deliveries`): its id is
 * the wakes row's, and the row here says when and how it went out (`via`:
 * the gated paste, an Agent Hub turn or a native puller). Undelivered with no
 * wakes row left means it was dropped (the session ended). Pruned after 7 days.
 */
export const DELIVERIES_SQL = `
  CREATE TABLE IF NOT EXISTS deliveries (
    id           TEXT PRIMARY KEY
                   CHECK(length(id) = 12 AND id NOT GLOB '*[^0-9a-f]*'),
    session_id   TEXT NOT NULL
                   CHECK(length(session_id) = 8 AND session_id NOT GLOB '*[^0-9a-f]*'),
    source       TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 120),
    queued_at    INTEGER NOT NULL CHECK(queued_at >= 0),
    delivered_at INTEGER,
    via          TEXT CHECK(via IS NULL OR via IN ('paste', 'turn', 'native'))
  );
  CREATE INDEX IF NOT EXISTS deliveries_queued_at ON deliveries(queued_at);
`

/**
 * v22: where an ask's answer goes once its session has ended (src/asks.ts).
 * `launcher_id` is the session that launched the asker (its lineage when the
 * ask was filed, or when the asker ended with it open: the hand-off);
 * `answer_to` the session the answer was queued to; `coordinator_id` the
 * asker's coordinator when filed, the last one up the chain to take it.
 */
export const ASK_HANDOFF_COLUMNS: readonly { table: string; column: string; sql: string }[] = [
  {
    table: 'asks',
    column: 'launcher_id',
    sql: "ALTER TABLE asks ADD COLUMN launcher_id TEXT CHECK(launcher_id IS NULL OR (length(launcher_id) = 8 AND launcher_id NOT GLOB '*[^0-9a-f]*'))",
  },
  {
    table: 'asks',
    column: 'answer_to',
    sql: "ALTER TABLE asks ADD COLUMN answer_to TEXT CHECK(answer_to IS NULL OR (length(answer_to) = 8 AND answer_to NOT GLOB '*[^0-9a-f]*'))",
  },
  {
    table: 'asks',
    column: 'coordinator_id',
    sql: "ALTER TABLE asks ADD COLUMN coordinator_id TEXT CHECK(coordinator_id IS NULL OR (length(coordinator_id) = 8 AND coordinator_id NOT GLOB '*[^0-9a-f]*'))",
  },
]
