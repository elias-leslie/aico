// Tether's SQLite schema. Tables that Phase 3 imports from Aico's aico.db keep
// Aico's column names, types, defaults and CHECK constraints so the importer
// copies rows byte for byte. The only widening is the tmux_servers unit CHECK,
// which additionally admits non-default instance unit names.

export const SCHEMA_VERSION = 3

/** Aico's tmux_servers table (electron/main/store.ts TMUX_SERVERS_TABLE_SQL),
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

/** Merged agent-tool registry (Aico TUI specs + A-Term agent_tools rows). */
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

/** v3: which app requested a root (A-Term or Aico). The tombstone keeps it. */
export const ROOT_ORIGIN_SQL = `
  ALTER TABLE root_requests ADD COLUMN origin TEXT NOT NULL DEFAULT 'aico'
    CHECK(origin IN ('aico', 'a-term'));
`
