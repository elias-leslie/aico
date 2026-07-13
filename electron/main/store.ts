import { DatabaseSync } from 'node:sqlite'
import { durableTmuxServerUnit, MANAGED_LIFECYCLE_VERSION } from './ownership'

// Widget catalog persisted in SQLite (~/.local/state/aico/aico.db). A widget's
// identity is a stable id (not the volatile BrowserWindow id), so its tmux
// session survives close/reopen and app restarts. Bounds restore position/size;
// `open` records which widgets were live at last quit so they can be restored.

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export type TmuxAllocationState = 'unallocated' | 'legacy-unclassified' | 'bound' | 'external'
export type LaunchState = 'none' | 'gated' | 'dispatched'

export interface WidgetRow {
  id: string
  seq: number
  bounds: Bounds | null
  displayId: string | null
  open: boolean
  createdAt: number
  /** TUI slug this widget runs (see electron/main/tui). */
  tool: string
  /** User-chosen title-bar name; null falls back to `Widget ${seq}`. */
  name: string | null
  /** Workspace/project slug this widget is bound to; null = the global `st`
   * active project (legacy fallback). Identity for the flyout/marker. */
  projectId: string | null
  /** The bound workspace/project fs root, resolved once at switch time and
   * stored so the per-widget cwd is a cheap column read (no `st` subprocess on session create).
   * Null when unbound or unresolved; a vanished root falls back at use. */
  projectRoot: string | null
  /** Non-null when this widget attaches a session owned by another tmux server. */
  externalTmuxSocket: string | null
  externalTmuxSession: string | null
  /** Persistent generation of the internal tmux server that owns this widget.
   * Null identifies a legacy/unclassified row and never authorizes inferring
   * session absence from a socket transport error. */
  tmuxServerId: string | null
  /** Distinguishes a fresh row that has never attempted allocation from work
   * migrated before server generations existed. Null server ids alone cannot
   * safely make that distinction after a crash. */
  tmuxAllocationState: TmuxAllocationState
  /** Stable tmux server-side session id (for example `$3`). Managed operations
   * target this instead of the mutable display name once ownership is proven. */
  tmuxSessionId: string | null
  /** Stable id of the sole managed pane (for example `%7`). Aico's lifecycle
   * contract is intentionally one pane per widget; extra panes fail closed. */
  paneId: string | null
  /** Stable Aico ownership id. Unlike a PID or tmux pane id, this survives
   * Electron restarts and normal detach/reattach cycles. */
  sessionId: string
  /** Exact per-pane systemd scope observed after a managed launch. Null means
   * legacy/unverified containment and must never be used as a broad kill target. */
  scopeUnit: string | null
  /** systemd InvocationID observed with scopeUnit; prevents a stale/reused unit
   * name from becoming cleanup authority for another workload. */
  scopeInvocationId: string | null
  /** Former scope retained until verified empty. This makes pane replacement
   * crash-safe: the new current scope never overwrites the only cleanup proof. */
  pendingScopeUnit: string | null
  pendingScopeInvocationId: string | null
  /** Exactly-once transition for a promoted no-RC gate. `gated` may be
   * dispatched once; a persisted `dispatched` gate is never auto-replayed. */
  launchState: LaunchState
  launchNonce: string | null
  /** Lifecycle contract used to create the pane. Version 1 launches only after
   * tmux has placed the bare pane in its per-pane scope. */
  lifecycleVersion: number
}

interface Raw {
  id: string
  seq: number
  x: number | null
  y: number | null
  width: number | null
  height: number | null
  display_id: string | null
  open: number
  created_at: number
  tool: string
  name: string | null
  project_id: string | null
  project_root: string | null
  external_tmux_socket: string | null
  external_tmux_session: string | null
  tmux_server_id: string | null
  tmux_allocation_state: TmuxAllocationState | null
  tmux_session_id: string | null
  pane_id: string | null
  session_id: string | null
  scope_unit: string | null
  scope_invocation_id: string | null
  pending_scope_unit: string | null
  pending_scope_invocation_id: string | null
  launch_state: LaunchState | null
  launch_nonce: string | null
  lifecycle_version: number | null
}

const TMUX_SERVERS_TABLE_SQL = `
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

let db: DatabaseSync

/** SQLite cannot widen an existing CHECK constraint in place. Rebuild the
 * catalog atomically so old `.scope` generations remain byte-for-byte identity
 * evidence while new `.service` generations can be inserted. Any malformed
 * historical row fails the new exact-kind/unit constraint and rolls back. */
function ensureTmuxServerUnitSchema(): void {
  const current = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tmux_servers'")
    .get() as { sql: string } | undefined
  if (!current) {
    db.exec(TMUX_SERVERS_TABLE_SQL)
    return
  }
  if (current.sql.includes("|| '.service'")) return

  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      ALTER TABLE tmux_servers RENAME TO tmux_servers_scope_only;
      ${TMUX_SERVERS_TABLE_SQL};
      INSERT INTO tmux_servers (
        id, kind, phase, socket_path, scope_unit, control_group,
        invocation_id, server_pid, proc_starttime, created_at, dead_at
      )
      SELECT
        id, kind, phase, socket_path, scope_unit, control_group,
        invocation_id, server_pid, proc_starttime, created_at, dead_at
      FROM tmux_servers_scope_only;
      DROP TABLE tmux_servers_scope_only;
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function toRow(r: Raw): WidgetRow {
  const hasBounds = r.x !== null && r.y !== null && r.width !== null && r.height !== null
  return {
    id: r.id,
    seq: r.seq,
    bounds: hasBounds
      ? { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number }
      : null,
    displayId: r.display_id,
    open: r.open === 1,
    createdAt: r.created_at,
    tool: r.tool,
    name: r.name ?? null,
    projectId: r.project_id ?? null,
    projectRoot: r.project_root ?? null,
    externalTmuxSocket: r.external_tmux_socket ?? null,
    externalTmuxSession: r.external_tmux_session ?? null,
    tmuxServerId: r.tmux_server_id ?? null,
    tmuxAllocationState:
      r.tmux_allocation_state ?? (r.external_tmux_session ? 'external' : 'legacy-unclassified'),
    tmuxSessionId: r.tmux_session_id ?? null,
    paneId: r.pane_id ?? null,
    sessionId: r.session_id || `aico-widget-${r.id}`,
    scopeUnit: r.scope_unit ?? null,
    scopeInvocationId: r.scope_invocation_id ?? null,
    pendingScopeUnit: r.pending_scope_unit ?? null,
    pendingScopeInvocationId: r.pending_scope_invocation_id ?? null,
    launchState: r.launch_state ?? 'none',
    launchNonce: r.launch_nonce ?? null,
    lifecycleVersion: r.lifecycle_version ?? 0,
  }
}

export function initStore(dbPath: string): void {
  db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS widgets (
      id         TEXT PRIMARY KEY,
      seq        INTEGER NOT NULL,
      x          INTEGER,
      y          INTEGER,
      width      INTEGER,
      height     INTEGER,
      display_id TEXT,
      open       INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      tool         TEXT NOT NULL DEFAULT 'shell',
      name         TEXT,
      project_id   TEXT,
      project_root TEXT,
      external_tmux_socket  TEXT,
      external_tmux_session TEXT,
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
      lifecycle_version INTEGER NOT NULL DEFAULT 0
    )
  `)
  // Migrate pre-`tool` databases: existing widgets are bare shells. New widgets
  // pass their TUI slug explicitly (default Claude Code).
  const cols = db.prepare('PRAGMA table_info(widgets)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'tool')) {
    db.exec("ALTER TABLE widgets ADD COLUMN tool TEXT NOT NULL DEFAULT 'shell'")
  }
  // Migrate pre-`name` databases: no custom name (falls back to `Widget ${seq}`).
  if (!cols.some((c) => c.name === 'name')) {
    db.exec('ALTER TABLE widgets ADD COLUMN name TEXT')
  }
  // Migrate pre-`project_id` databases: no per-widget binding (widgets fall back
  // to the global `st` active project for their cwd). `project_root` caches the
  // bound project's resolved fs root so session create needs no `st` subprocess.
  if (!cols.some((c) => c.name === 'project_id')) {
    db.exec('ALTER TABLE widgets ADD COLUMN project_id TEXT')
  }
  if (!cols.some((c) => c.name === 'project_root')) {
    db.exec('ALTER TABLE widgets ADD COLUMN project_root TEXT')
  }
  if (!cols.some((c) => c.name === 'external_tmux_socket')) {
    db.exec('ALTER TABLE widgets ADD COLUMN external_tmux_socket TEXT')
  }
  if (!cols.some((c) => c.name === 'external_tmux_session')) {
    db.exec('ALTER TABLE widgets ADD COLUMN external_tmux_session TEXT')
  }
  if (!cols.some((c) => c.name === 'tmux_server_id')) {
    db.exec('ALTER TABLE widgets ADD COLUMN tmux_server_id TEXT')
  }
  if (!cols.some((c) => c.name === 'tmux_allocation_state')) {
    // Existing internal rows predate server-generation evidence and must never
    // look like a fresh crash-before-allocation row. Existing external rows are
    // reclassified immediately after the additive migration.
    db.exec(
      `ALTER TABLE widgets ADD COLUMN tmux_allocation_state TEXT NOT NULL
       DEFAULT 'legacy-unclassified'
       CHECK(tmux_allocation_state IN ('unallocated', 'legacy-unclassified', 'bound', 'external'))`,
    )
    db.exec(
      `UPDATE widgets SET tmux_allocation_state = 'external'
       WHERE external_tmux_session IS NOT NULL`,
    )
  }
  if (!cols.some((c) => c.name === 'tmux_session_id')) {
    db.exec('ALTER TABLE widgets ADD COLUMN tmux_session_id TEXT')
  }
  if (!cols.some((c) => c.name === 'pane_id')) {
    db.exec('ALTER TABLE widgets ADD COLUMN pane_id TEXT')
  }
  if (!cols.some((c) => c.name === 'session_id')) {
    db.exec('ALTER TABLE widgets ADD COLUMN session_id TEXT')
  }
  if (!cols.some((c) => c.name === 'scope_unit')) {
    db.exec('ALTER TABLE widgets ADD COLUMN scope_unit TEXT')
  }
  if (!cols.some((c) => c.name === 'scope_invocation_id')) {
    db.exec('ALTER TABLE widgets ADD COLUMN scope_invocation_id TEXT')
  }
  if (!cols.some((c) => c.name === 'pending_scope_unit')) {
    db.exec('ALTER TABLE widgets ADD COLUMN pending_scope_unit TEXT')
  }
  if (!cols.some((c) => c.name === 'pending_scope_invocation_id')) {
    db.exec('ALTER TABLE widgets ADD COLUMN pending_scope_invocation_id TEXT')
  }
  if (!cols.some((c) => c.name === 'launch_state')) {
    db.exec("ALTER TABLE widgets ADD COLUMN launch_state TEXT NOT NULL DEFAULT 'none'")
  }
  if (!cols.some((c) => c.name === 'launch_nonce')) {
    db.exec('ALTER TABLE widgets ADD COLUMN launch_nonce TEXT')
  }
  if (!cols.some((c) => c.name === 'lifecycle_version')) {
    db.exec('ALTER TABLE widgets ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0')
  }
  // Every catalogued session gets a durable identifier, including rows created
  // before ownership metadata existed. Existing work is deliberately labelled
  // lifecycle v0 until it is explicitly respawned through the managed path.
  db.exec(
    "UPDATE widgets SET session_id = 'aico-widget-' || id WHERE session_id IS NULL OR session_id = ''",
  )
  // Global app settings as a small key/value table. Used for the control
  // surface's pinned-action list (one row, shared across all widgets).
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
  // Each internal tmux server gets an immutable generation. A generation is
  // inserted as provisioning, activated exactly once after its process,
  // systemd, and socket identities agree, and then can only become dead. Dead
  // rows remain as absence evidence until every referencing widget is safely
  // reconciled. Legacy observations are inserted directly as active and are
  // never systemd cleanup authority.
  ensureTmuxServerUnitSchema()
  db.exec(`
    DROP INDEX IF EXISTS tmux_servers_one_live_managed;
    DROP INDEX IF EXISTS tmux_servers_one_live_managed_service;
    CREATE UNIQUE INDEX IF NOT EXISTS tmux_servers_one_live_managed_service
      ON tmux_servers(kind)
      WHERE kind = 'managed' AND phase <> 'dead' AND scope_unit GLOB '*.service';
    CREATE UNIQUE INDEX IF NOT EXISTS tmux_servers_managed_scope_once
      ON tmux_servers(scope_unit)
      WHERE kind = 'managed';
    CREATE INDEX IF NOT EXISTS widgets_tmux_server_id
      ON widgets(tmux_server_id);
  `)
}

export function getSetting(key: string): string | undefined {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return r?.value
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

export type TmuxServerKind = 'managed' | 'legacy-observed'
export type TmuxServerPhase = 'provisioning' | 'active' | 'dead'

export interface TmuxServerRow {
  id: string
  kind: TmuxServerKind
  phase: TmuxServerPhase
  socketPath: string
  /** Exact systemd unit name. The historical property name is retained for
   * compatibility: managed v1 rows end in `.scope`, while new manager-spawned
   * generations end in `.service`. */
  scopeUnit: string
  controlGroup: string | null
  invocationId: string | null
  serverPid: number | null
  procStartTime: string | null
  createdAt: number
  deadAt: number | null
}

interface RawTmuxServer {
  id: string
  kind: TmuxServerKind
  phase: TmuxServerPhase
  socket_path: string
  scope_unit: string
  control_group: string | null
  invocation_id: string | null
  server_pid: number | null
  proc_starttime: string | null
  created_at: number
  dead_at: number | null
}

export interface ProvisioningTmuxServer {
  id: string
  socketPath: string
  scopeUnit: string
  createdAt?: number
}

export interface ActiveTmuxServerIdentity {
  controlGroup: string
  invocationId: string
  serverPid: number
  procStartTime: string
}

export interface LegacyTmuxServerObservation extends ActiveTmuxServerIdentity {
  id: string
  socketPath: string
  scopeUnit: string
  createdAt?: number
}

const TMUX_SERVER_ID_RE = /^[0-9a-f]{8,64}$/
const SYSTEMD_INVOCATION_ID_RE = /^[0-9a-f]{32}$/i
const TMUX_STABLE_SESSION_ID_RE = /^\$\d+$/
const TMUX_STABLE_PANE_ID_RE = /^%\d+$/
const UNIX_SOCKET_PATH_MAX_BYTES = 107

function assertTmuxServerId(id: string): void {
  if (!TMUX_SERVER_ID_RE.test(id)) throw new Error(`invalid tmux server id: ${id}`)
}

function assertSocketPath(socketPath: string): void {
  if (
    !socketPath.startsWith('/') ||
    socketPath.includes('\0') ||
    Buffer.byteLength(socketPath) > UNIX_SOCKET_PATH_MAX_BYTES
  ) {
    throw new Error(`invalid tmux socket path: ${socketPath}`)
  }
}

function assertLegacyScopeUnit(scopeUnit: string): void {
  if (
    !scopeUnit.endsWith('.scope') ||
    scopeUnit.includes('/') ||
    scopeUnit.includes('\0') ||
    scopeUnit.length === '.scope'.length
  ) {
    throw new Error(`invalid legacy tmux server scope: ${scopeUnit}`)
  }
}

function assertCreatedAt(createdAt: number): void {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error(`invalid tmux server timestamp: ${createdAt}`)
  }
}

function assertActiveIdentity(scopeUnit: string, identity: ActiveTmuxServerIdentity): void {
  if (
    !identity.controlGroup.startsWith('/') ||
    !identity.controlGroup.endsWith(`/${scopeUnit}`) ||
    identity.controlGroup.includes('\0')
  ) {
    throw new Error(`invalid tmux server control group: ${identity.controlGroup}`)
  }
  if (!SYSTEMD_INVOCATION_ID_RE.test(identity.invocationId)) {
    throw new Error(`invalid tmux server invocation id: ${identity.invocationId}`)
  }
  if (!Number.isSafeInteger(identity.serverPid) || identity.serverPid <= 0) {
    throw new Error(`invalid tmux server pid: ${identity.serverPid}`)
  }
  if (!/^[1-9]\d*$/.test(identity.procStartTime)) {
    throw new Error(`invalid tmux server process starttime: ${identity.procStartTime}`)
  }
}

function toTmuxServerRow(row: RawTmuxServer): TmuxServerRow {
  return {
    id: row.id,
    kind: row.kind,
    phase: row.phase,
    socketPath: row.socket_path,
    scopeUnit: row.scope_unit,
    controlGroup: row.control_group,
    invocationId: row.invocation_id,
    serverPid: row.server_pid,
    procStartTime: row.proc_starttime,
    createdAt: row.created_at,
    deadAt: row.dead_at,
  }
}

/** Persist the launch intent before starting the first gate-only tmux session.
 * The partial unique index permits only one non-dead manager-spawned service
 * generation; historical `.scope` generations remain observation-only. */
export function insertProvisioningTmuxServer(input: ProvisioningTmuxServer): TmuxServerRow {
  assertTmuxServerId(input.id)
  assertSocketPath(input.socketPath)
  if (input.scopeUnit !== durableTmuxServerUnit(input.id)) {
    throw new Error(`managed tmux server unit does not match generation ${input.id}`)
  }
  const createdAt = input.createdAt ?? Date.now()
  assertCreatedAt(createdAt)
  db.prepare(
    `INSERT INTO tmux_servers (
       id, kind, phase, socket_path, scope_unit, created_at
     ) VALUES (?, 'managed', 'provisioning', ?, ?, ?)`,
  ).run(input.id, input.socketPath, input.scopeUnit, createdAt)
  return getTmuxServer(input.id) as TmuxServerRow
}

/** Promote exactly one still-provisioning managed generation. Identity fields
 * are never writable again after this compare-and-set succeeds. */
export function activateTmuxServer(id: string, identity: ActiveTmuxServerIdentity): boolean {
  assertTmuxServerId(id)
  const current = getTmuxServer(id)
  if (!current || current.kind !== 'managed' || current.phase !== 'provisioning') return false
  assertActiveIdentity(current.scopeUnit, identity)
  const result = db
    .prepare(
      `UPDATE tmux_servers
       SET phase = 'active', control_group = ?, invocation_id = ?,
           server_pid = ?, proc_starttime = ?
       WHERE id = ? AND kind = 'managed' AND phase = 'provisioning'
         AND control_group IS NULL AND invocation_id IS NULL
         AND server_pid IS NULL AND proc_starttime IS NULL`,
    )
    .run(
      identity.controlGroup,
      identity.invocationId,
      identity.serverPid,
      identity.procStartTime,
      id,
    )
  return result.changes === 1
}

/** Record a pre-existing server after a read-only observation proves its exact
 * socket, PID/starttime, cgroup, unit, and InvocationID. Legacy scope metadata
 * is identity evidence only; lifecycle code must never use it as kill authority. */
export function adoptActiveLegacyTmuxServer(input: LegacyTmuxServerObservation): TmuxServerRow {
  assertTmuxServerId(input.id)
  assertSocketPath(input.socketPath)
  assertLegacyScopeUnit(input.scopeUnit)
  assertActiveIdentity(input.scopeUnit, input)
  const createdAt = input.createdAt ?? Date.now()
  assertCreatedAt(createdAt)
  db.prepare(
    `INSERT INTO tmux_servers (
       id, kind, phase, socket_path, scope_unit, control_group,
       invocation_id, server_pid, proc_starttime, created_at
     ) VALUES (?, 'legacy-observed', 'active', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.socketPath,
    input.scopeUnit,
    input.controlGroup,
    input.invocationId,
    input.serverPid,
    input.procStartTime,
    createdAt,
  )
  return getTmuxServer(input.id) as TmuxServerRow
}

export function getTmuxServer(id: string): TmuxServerRow | undefined {
  const row = db.prepare('SELECT * FROM tmux_servers WHERE id = ?').get(id) as
    | RawTmuxServer
    | undefined
  return row ? toTmuxServerRow(row) : undefined
}

export function listTmuxServers(): TmuxServerRow[] {
  return (
    db.prepare('SELECT * FROM tmux_servers ORDER BY created_at ASC, id ASC').all() as unknown[]
  ).map((row) => toTmuxServerRow(row as RawTmuxServer))
}

export function getCurrentManagedTmuxServer(): TmuxServerRow | undefined {
  const row = db
    .prepare(
      `SELECT * FROM tmux_servers
       WHERE kind = 'managed' AND phase <> 'dead' AND scope_unit GLOB '*.service'`,
    )
    .get() as RawTmuxServer | undefined
  return row ? toTmuxServerRow(row) : undefined
}

/** Preserve the immutable tuple as a tombstone. Only a generation that has not
 * already died can transition; a stale duplicate observation returns false. */
export function markTmuxServerDead(id: string, deadAt = Date.now()): boolean {
  assertTmuxServerId(id)
  assertCreatedAt(deadAt)
  const result = db
    .prepare(
      `UPDATE tmux_servers
       SET phase = 'dead', dead_at = ?
       WHERE id = ? AND phase IN ('active', 'provisioning') AND created_at <= ?`,
    )
    .run(deadAt, id, deadAt)
  return result.changes === 1
}

/** Bind a widget to a non-dead server with compare-and-set semantics. Stable
 * tmux ids are write-once within a server generation: a verified roster may
 * fill missing ids or confirm the same pair, but can never retarget an owned
 * widget after a tmux name is reused or renamed. Switching generations is
 * allowed only after both current and pending pane-scope evidence are clear. */
export function bindWidgetTmuxServer(
  id: string,
  expectedTmuxServerId: string | null,
  tmuxServerId: string,
  tmuxSessionId: string | null = null,
  paneId: string | null = null,
): boolean {
  if (expectedTmuxServerId !== null) assertTmuxServerId(expectedTmuxServerId)
  assertTmuxServerId(tmuxServerId)
  if ((tmuxSessionId === null) !== (paneId === null)) {
    throw new Error('tmux stable session and pane ids must be set or cleared together')
  }
  if (tmuxSessionId !== null && !TMUX_STABLE_SESSION_ID_RE.test(tmuxSessionId)) {
    throw new Error(`invalid stable tmux session id: ${tmuxSessionId}`)
  }
  if (paneId !== null && !TMUX_STABLE_PANE_ID_RE.test(paneId)) {
    throw new Error(`invalid stable tmux pane id: ${paneId}`)
  }
  const result = db
    .prepare(
      `UPDATE widgets
       SET tmux_server_id = ?, tmux_allocation_state = 'bound',
           tmux_session_id = COALESCE(tmux_session_id, ?),
           pane_id = COALESCE(pane_id, ?)
       WHERE id = ? AND tmux_server_id IS ? AND external_tmux_session IS NULL
         AND tmux_allocation_state IN ('unallocated', 'legacy-unclassified', 'bound')
         AND EXISTS (
           SELECT 1 FROM tmux_servers
           WHERE tmux_servers.id = ? AND tmux_servers.phase <> 'dead'
         )
         AND (
           tmux_server_id IS ?
           OR (scope_unit IS NULL AND pending_scope_unit IS NULL)
         )
         AND (tmux_server_id IS NULL OR tmux_server_id IS ?)
         AND (
           ? IS NULL
           OR (tmux_session_id IS NULL AND pane_id IS NULL)
           OR (tmux_session_id IS ? AND pane_id IS ?)
         )`,
    )
    .run(
      tmuxServerId,
      tmuxSessionId,
      paneId,
      id,
      expectedTmuxServerId,
      tmuxServerId,
      tmuxServerId,
      tmuxServerId,
      tmuxSessionId,
      tmuxSessionId,
      paneId,
    )
  return result.changes === 1
}

export function countTmuxServerReferences(id: string): number {
  assertTmuxServerId(id)
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM widgets WHERE tmux_server_id = ?')
    .get(id) as { count: number }
  return row.count
}

/** Clear only a dead generation whose widget has already had every current and
 * pending pane identity reconciled. */
export function clearReconciledDeadTmuxServerBinding(
  id: string,
  expectedTmuxServerId: string,
): boolean {
  assertTmuxServerId(expectedTmuxServerId)
  const result = db
    .prepare(
      `UPDATE widgets
       SET tmux_server_id = NULL, tmux_allocation_state = 'unallocated',
           launch_state = 'none', launch_nonce = NULL
       WHERE id = ? AND tmux_server_id = ? AND tmux_allocation_state = 'bound'
         AND external_tmux_session IS NULL
         AND scope_unit IS NULL AND scope_invocation_id IS NULL
         AND pending_scope_unit IS NULL AND pending_scope_invocation_id IS NULL
         AND tmux_session_id IS NULL AND pane_id IS NULL
         AND EXISTS (
           SELECT 1 FROM tmux_servers
           WHERE tmux_servers.id = ? AND tmux_servers.phase = 'dead'
         )`,
    )
    .run(id, expectedTmuxServerId, expectedTmuxServerId)
  return result.changes === 1
}

/** Detach a missing widget from a historical caller-spawned managed server
 * without disturbing that server or any peer session still using it. The
 * caller must freshly prove this widget's session absent from the exact live
 * server roster and drain every persisted pane scope first. This database CAS
 * then permits only a lifecycle-managed, fully reconciled row bound to the
 * exact active `.scope` generation; clean-FD `.service` generations and broad
 * legacy observations can never use this migration path. */
export function clearReconciledHistoricalTmuxServerBinding(
  id: string,
  expectedTmuxServerId: string,
): boolean {
  assertTmuxServerId(expectedTmuxServerId)
  const result = db
    .prepare(
      `UPDATE widgets
       SET tmux_server_id = NULL, tmux_allocation_state = 'unallocated',
           launch_state = 'none', launch_nonce = NULL
       WHERE id = ? AND tmux_server_id = ? AND tmux_allocation_state = 'bound'
         AND external_tmux_session IS NULL
         AND lifecycle_version >= ?
         AND scope_unit IS NULL AND scope_invocation_id IS NULL
         AND pending_scope_unit IS NULL AND pending_scope_invocation_id IS NULL
         AND tmux_session_id IS NULL AND pane_id IS NULL
         AND EXISTS (
           SELECT 1 FROM tmux_servers
           WHERE tmux_servers.id = ?
             AND tmux_servers.kind = 'managed'
             AND tmux_servers.phase = 'active'
             AND tmux_servers.scope_unit =
               'aico-tmux-server-' || tmux_servers.id || '.scope'
         )`,
    )
    .run(id, expectedTmuxServerId, MANAGED_LIFECYCLE_VERSION, expectedTmuxServerId)
  return result.changes === 1
}

/** All widgets, oldest first. */
export function listWidgets(): WidgetRow[] {
  return (db.prepare('SELECT * FROM widgets ORDER BY created_at ASC').all() as unknown[]).map((r) =>
    toRow(r as Raw),
  )
}

export function getWidget(id: string): WidgetRow | undefined {
  const r = db.prepare('SELECT * FROM widgets WHERE id = ?').get(id) as Raw | undefined
  return r ? toRow(r) : undefined
}

export function hasWidget(id: string): boolean {
  return db.prepare('SELECT 1 FROM widgets WHERE id = ?').get(id) !== undefined
}

function nextSeq(): number {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM widgets').get() as { n: number }
  return r.n
}

function insertInternalWidget(
  id: string,
  open: boolean,
  tool: string,
  createdAt: number,
  allocationState: Extract<TmuxAllocationState, 'unallocated' | 'legacy-unclassified'>,
): WidgetRow {
  db.prepare(
    `INSERT INTO widgets (
       id, seq, open, created_at, tool, session_id, tmux_allocation_state
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, nextSeq(), open ? 1 : 0, createdAt, tool, `aico-widget-${id}`, allocationState)
  return getWidget(id) as WidgetRow
}

/** Insert a genuinely new widget. Only this state can prove no tmux allocation
 * ever existed and therefore authorize a first launch after a crash. */
export function insertWidget(
  id: string,
  open: boolean,
  tool: string,
  createdAt = Date.now(),
): WidgetRow {
  return insertInternalWidget(id, open, tool, createdAt, 'unallocated')
}

/** Insert a row observed in a pre-catalog tmux roster. A crash before the
 * subsequent generation bind remains fail-closed rather than turning live
 * orphaned work into an apparently fresh widget. */
export function insertLegacyUnclassifiedWidget(
  id: string,
  open: boolean,
  tool: string,
  createdAt = Date.now(),
): WidgetRow {
  return insertInternalWidget(id, open, tool, createdAt, 'legacy-unclassified')
}

/** Insert a widget that attaches an externally-owned tmux session. */
export function insertExternalWidget(
  id: string,
  open: boolean,
  externalTmuxSocket: string | null,
  externalTmuxSession: string,
  name: string | null,
  tool = 'shell',
  createdAt = Date.now(),
): WidgetRow {
  db.prepare(
    `INSERT INTO widgets (
      id, seq, open, created_at, tool, name, external_tmux_socket,
      external_tmux_session, session_id, tmux_allocation_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'external')`,
  ).run(
    id,
    nextSeq(),
    open ? 1 : 0,
    createdAt,
    tool,
    name,
    externalTmuxSocket,
    externalTmuxSession,
    `external-tmux-${id}`,
  )
  return getWidget(id) as WidgetRow
}

export function saveBounds(id: string, bounds: Bounds, displayId: string): void {
  db.prepare(
    'UPDATE widgets SET x = ?, y = ?, width = ?, height = ?, display_id = ? WHERE id = ?',
  ).run(bounds.x, bounds.y, bounds.width, bounds.height, displayId, id)
}

export function setOpen(id: string, open: boolean): void {
  db.prepare('UPDATE widgets SET open = ? WHERE id = ?').run(open ? 1 : 0, id)
}

/** Update a widget's TUI slug (e.g. after "Replace with <TUI>" in the widget),
 * so a later kill+recreate launches the TUI that's actually running there now. */
export function setWidgetTool(id: string, tool: string): void {
  db.prepare('UPDATE widgets SET tool = ? WHERE id = ?').run(tool, id)
}

/** Set (or clear, with null/empty) a widget's user-chosen title-bar name. */
export function setWidgetName(id: string, name: string | null): void {
  const trimmed = name?.trim()
  db.prepare('UPDATE widgets SET name = ? WHERE id = ?').run(trimmed || null, id)
}

/** Bind a widget to a workspace/project (slug + its resolved fs root), or clear
 * both with null to fall back to the global `st` active project. The root is
 * resolved once here (at switch time) so the per-widget cwd is later cheap. */
export function setWidgetProject(
  id: string,
  projectId: string | null,
  projectRoot: string | null,
): void {
  db.prepare('UPDATE widgets SET project_id = ?, project_root = ? WHERE id = ?').run(
    projectId || null,
    projectRoot || null,
    id,
  )
}

/** Persist only a scope that was observed after a successful managed launch.
 * Callers clear it after confirmed targeted cleanup. */
export function setWidgetOwnership(
  id: string,
  scopeUnit: string | null,
  lifecycleVersion: number,
  scopeInvocationId: string | null = null,
  tmuxSessionId: string | null = null,
  paneId: string | null = null,
  tmuxServerId?: string | null,
): void {
  // Omitted or null preserves the binding; clearing a non-null generation
  // requires one of the exact reconciled-server clearing APIs above.
  if (tmuxServerId === undefined || tmuxServerId === null) {
    db.prepare(
      `UPDATE widgets
       SET scope_unit = ?, scope_invocation_id = ?, lifecycle_version = ?,
           tmux_session_id = ?, pane_id = ?
       WHERE id = ?`,
    ).run(scopeUnit, scopeInvocationId, lifecycleVersion, tmuxSessionId, paneId, id)
    return
  }
  assertTmuxServerId(tmuxServerId)
  db.prepare(
    `UPDATE widgets
     SET scope_unit = ?, scope_invocation_id = ?, lifecycle_version = ?,
         tmux_session_id = ?, pane_id = ?, tmux_server_id = ?,
         tmux_allocation_state = 'bound'
     WHERE id = ?`,
  ).run(scopeUnit, scopeInvocationId, lifecycleVersion, tmuxSessionId, paneId, tmuxServerId, id)
}

export interface WidgetOwnershipGeneration {
  scopeUnit: string | null
  scopeInvocationId: string | null
  pendingScopeUnit: string | null
  pendingScopeInvocationId: string | null
  lifecycleVersion: number
  tmuxServerId: string | null
  tmuxAllocationState: TmuxAllocationState
  tmuxSessionId: string | null
  paneId: string | null
  launchState: LaunchState
  launchNonce: string | null
}

/** Promote a pane only if every persisted ownership field still matches the
 * caller's snapshot. A stale create/respawn completion must never overwrite the
 * only cleanup authority for another generation. */
export function compareAndSetWidgetOwnership(
  id: string,
  expected: WidgetOwnershipGeneration,
  next: WidgetOwnershipGeneration,
): boolean {
  // Server allocation has its own guarded bind/clear APIs. Pane promotion may
  // observe it as CAS authority but cannot smuggle in an allocation transition.
  if (
    next.tmuxServerId !== expected.tmuxServerId ||
    next.tmuxAllocationState !== expected.tmuxAllocationState
  ) {
    return false
  }
  const result = db
    .prepare(
      `UPDATE widgets
       SET scope_unit = ?, scope_invocation_id = ?,
           pending_scope_unit = ?, pending_scope_invocation_id = ?,
           lifecycle_version = ?, tmux_server_id = ?, tmux_allocation_state = ?,
           tmux_session_id = ?, pane_id = ?, launch_state = ?, launch_nonce = ?
       WHERE id = ?
         AND scope_unit IS ? AND scope_invocation_id IS ?
         AND pending_scope_unit IS ? AND pending_scope_invocation_id IS ?
         AND lifecycle_version = ? AND tmux_server_id IS ? AND tmux_allocation_state = ?
         AND tmux_session_id IS ? AND pane_id IS ?
         AND launch_state = ? AND launch_nonce IS ?`,
    )
    .run(
      next.scopeUnit,
      next.scopeInvocationId,
      next.pendingScopeUnit,
      next.pendingScopeInvocationId,
      next.lifecycleVersion,
      next.tmuxServerId,
      next.tmuxAllocationState,
      next.tmuxSessionId,
      next.paneId,
      next.launchState,
      next.launchNonce,
      id,
      expected.scopeUnit,
      expected.scopeInvocationId,
      expected.pendingScopeUnit,
      expected.pendingScopeInvocationId,
      expected.lifecycleVersion,
      expected.tmuxServerId,
      expected.tmuxAllocationState,
      expected.tmuxSessionId,
      expected.paneId,
      expected.launchState,
      expected.launchNonce,
    )
  return result.changes === 1
}

/** Persist the launch metadata carried by an already-promoted gate only if its
 * complete process-ownership generation is still current. This closes the
 * crash window between respawn and the UI callback that updates tool/project. */
export function compareAndSetWidgetLaunchMetadata(
  id: string,
  expected: WidgetOwnershipGeneration,
  tool: string,
  projectId: string | null,
  projectRoot: string | null,
): boolean {
  const result = db
    .prepare(
      `UPDATE widgets
       SET tool = ?, project_id = ?, project_root = ?
       WHERE id = ?
         AND scope_unit IS ? AND scope_invocation_id IS ?
         AND pending_scope_unit IS ? AND pending_scope_invocation_id IS ?
         AND lifecycle_version = ? AND tmux_server_id IS ? AND tmux_allocation_state = ?
         AND tmux_session_id IS ? AND pane_id IS ?
         AND launch_state = ? AND launch_nonce IS ?`,
    )
    .run(
      tool,
      projectId,
      projectRoot,
      id,
      expected.scopeUnit,
      expected.scopeInvocationId,
      expected.pendingScopeUnit,
      expected.pendingScopeInvocationId,
      expected.lifecycleVersion,
      expected.tmuxServerId,
      expected.tmuxAllocationState,
      expected.tmuxSessionId,
      expected.paneId,
      expected.launchState,
      expected.launchNonce,
    )
  return result.changes === 1
}

/** Save the former exact scope before any destructive respawn. It remains in
 * the row until whole-cgroup cleanup has been independently verified. */
export function setWidgetPendingScope(
  id: string,
  expected: WidgetOwnershipGeneration,
  scopeUnit: string | null,
  scopeInvocationId: string | null,
): boolean {
  return compareAndSetWidgetOwnership(id, expected, {
    ...expected,
    pendingScopeUnit: scopeUnit,
    pendingScopeInvocationId: scopeInvocationId,
  })
}

/** Clear only the pending value the caller actually cleaned, so an overlapping
 * lifecycle operation cannot erase a newer generation's cleanup authority. */
export function clearWidgetPendingScope(
  id: string,
  expectedScopeUnit: string,
  expectedScopeInvocationId: string | null,
): boolean {
  const result = db
    .prepare(
      `UPDATE widgets
       SET pending_scope_unit = NULL, pending_scope_invocation_id = NULL
       WHERE id = ? AND pending_scope_unit = ? AND pending_scope_invocation_id IS ?`,
    )
    .run(id, expectedScopeUnit, expectedScopeInvocationId)
  return result.changes === 1
}

/** Delete only the generation whose session/scope absence the caller verified. */
export function removeWidgetIfOwnership(id: string, expected: WidgetOwnershipGeneration): boolean {
  if (expected.pendingScopeUnit !== null || expected.pendingScopeInvocationId !== null) {
    return false
  }
  const result = db
    .prepare(
      `DELETE FROM widgets
       WHERE id = ?
         AND scope_unit IS ? AND scope_invocation_id IS ?
         AND pending_scope_unit IS ? AND pending_scope_invocation_id IS ?
         AND lifecycle_version = ? AND tmux_server_id IS ? AND tmux_allocation_state = ?
         AND tmux_session_id IS ? AND pane_id IS ?
         AND launch_state = ? AND launch_nonce IS ?`,
    )
    .run(
      id,
      expected.scopeUnit,
      expected.scopeInvocationId,
      expected.pendingScopeUnit,
      expected.pendingScopeInvocationId,
      expected.lifecycleVersion,
      expected.tmuxServerId,
      expected.tmuxAllocationState,
      expected.tmuxSessionId,
      expected.paneId,
      expected.launchState,
      expected.launchNonce,
    )
  return result.changes === 1
}

export function removeWidget(id: string): void {
  db.prepare('DELETE FROM widgets WHERE id = ?').run(id)
}
