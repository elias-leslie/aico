import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { MAX_UNIX_SOCKET_PATH_BYTES } from '../config'
import { durableTmuxServerUnit, MANAGED_LIFECYCLE_VERSION } from './ownership'

// Session catalog, extracted from Aico's electron/main/store.ts. Aico's
// `widgets` identity columns live in Tether's `sessions` table with identical
// names (src/schema.ts); view columns (bounds, display, open) and settings stay
// in Aico. `external_tmux_*` rows are never imported, so the external fields of
// WidgetRow are always null and `sessionGeneration` stays byte-compatible.
// The function names are kept so the extracted lifecycle code reads unchanged.
// One daemon process binds one database (`bindCatalog`).

export type TmuxAllocationState = 'unallocated' | 'legacy-unclassified' | 'bound' | 'external'
export type LaunchState = 'none' | 'gated' | 'dispatched'

export interface WidgetRow {
  id: string
  seq: number
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
  /** Tether: which client created the session. */
  origin: SessionOrigin
  /** Tether: A-Term's session UUID when A-Term created it (pane marker). */
  aTermSessionId: string | null
  /** Tether: this session coordinates lanes (docs/api-v1.md Coordinators). */
  coordinator: boolean
  /** Tether: the root coordinator that launched this session, if any. */
  coordinatorId: string | null
  /** Tether: the coordinator's palette colour (its own, or its launcher's). */
  coordinatorColor: string | null
}

export type SessionOrigin = 'aico' | 'a-term' | 'root' | 'cli'

interface Raw {
  id: string
  seq: number
  created_at: number
  tool: string
  name: string | null
  project_id: string | null
  project_root: string | null
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
  origin: SessionOrigin
  a_term_session_id: string | null
  coordinator: number | null
  coordinator_id: string | null
  coordinator_color: string | null
}

let db: DatabaseSync

/** Bind the catalog to the daemon's database (src/store.ts owns the schema). */
export function bindCatalog(database: DatabaseSync): void {
  db = database
}

function toRow(r: Raw): WidgetRow {
  return {
    id: r.id,
    seq: r.seq,
    createdAt: r.created_at,
    tool: r.tool,
    name: r.name ?? null,
    projectId: r.project_id ?? null,
    projectRoot: r.project_root ?? null,
    externalTmuxSocket: null,
    externalTmuxSession: null,
    tmuxServerId: r.tmux_server_id ?? null,
    tmuxAllocationState: r.tmux_allocation_state ?? 'legacy-unclassified',
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
    origin: r.origin,
    aTermSessionId: r.a_term_session_id ?? null,
    coordinator: r.coordinator === 1,
    coordinatorId: r.coordinator_id ?? null,
    coordinatorColor: r.coordinator_color ?? null,
  }
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

function assertTmuxServerId(id: string): void {
  if (!TMUX_SERVER_ID_RE.test(id)) throw new Error(`invalid tmux server id: ${id}`)
}

function assertSocketPath(socketPath: string): void {
  if (
    !socketPath.startsWith('/') ||
    socketPath.includes('\0') ||
    Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES
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
      `UPDATE sessions
       SET tmux_server_id = ?, tmux_allocation_state = 'bound',
           tmux_session_id = COALESCE(tmux_session_id, ?),
           pane_id = COALESCE(pane_id, ?)
       WHERE id = ? AND tmux_server_id IS ? 
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
    .prepare('SELECT COUNT(*) AS count FROM sessions WHERE tmux_server_id = ?')
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
      `UPDATE sessions
       SET tmux_server_id = NULL, tmux_allocation_state = 'unallocated',
           launch_state = 'none', launch_nonce = NULL
       WHERE id = ? AND tmux_server_id = ? AND tmux_allocation_state = 'bound'
         
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
      `UPDATE sessions
       SET tmux_server_id = NULL, tmux_allocation_state = 'unallocated',
           launch_state = 'none', launch_nonce = NULL
       WHERE id = ? AND tmux_server_id = ? AND tmux_allocation_state = 'bound'
         
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

/** Crash recovery: detach a session whose pane crashed from the live managed
 * server it was on, so it can be recreated in place. The caller has proven a
 * crash from the journal, freshly proven the session absent from the server
 * roster under the lifecycle lock, and drained its scopes; peers on the
 * server are untouched. */
export function clearCrashedTmuxServerBinding(id: string, expectedTmuxServerId: string): boolean {
  assertTmuxServerId(expectedTmuxServerId)
  const result = db
    .prepare(
      `UPDATE sessions
       SET tmux_server_id = NULL, tmux_allocation_state = 'unallocated',
           launch_state = 'none', launch_nonce = NULL
       WHERE id = ? AND tmux_server_id = ? AND tmux_allocation_state = 'bound'
         AND lifecycle_version >= ?
         AND scope_unit IS NULL AND scope_invocation_id IS NULL
         AND pending_scope_unit IS NULL AND pending_scope_invocation_id IS NULL
         AND tmux_session_id IS NULL AND pane_id IS NULL
         AND EXISTS (
           SELECT 1 FROM tmux_servers
           WHERE tmux_servers.id = ?
             AND tmux_servers.kind = 'managed'
             AND tmux_servers.phase = 'active'
         )`,
    )
    .run(id, expectedTmuxServerId, MANAGED_LIFECYCLE_VERSION, expectedTmuxServerId)
  return result.changes === 1
}

/** All widgets, oldest first. */
export function listWidgets(): WidgetRow[] {
  return (db.prepare('SELECT * FROM sessions ORDER BY created_at ASC').all() as unknown[]).map(
    (r) => toRow(r as Raw),
  )
}

export function getWidget(id: string): WidgetRow | undefined {
  const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Raw | undefined
  return r ? toRow(r) : undefined
}

/**
 * A fresh eight-hex widget ID that no widget and no root request (including an
 * ended root's tombstone) has used. Reusing a tombstone's ID would make the new
 * widget answer for the ended root.
 */
export function allocateWidgetId(
  random: () => string = () => randomBytes(4).toString('hex'),
): string {
  const taken = db.prepare(
    `SELECT 1 FROM sessions WHERE id = ?1
     UNION ALL SELECT 1 FROM root_requests WHERE widget_id = ?1
     UNION ALL SELECT 1 FROM retired_session_ids WHERE id = ?1`,
  )
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const id = random()
    if (taken.get(id) === undefined) return id
  }
  throw new Error('could not allocate an unused widget ID')
}

export function hasWidget(id: string): boolean {
  return db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id) !== undefined
}

function nextSeq(): number {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM sessions').get() as { n: number }
  return r.n
}

export interface SessionInsertOptions {
  origin?: SessionOrigin
  aTermSessionId?: string | null
}

function insertInternalWidget(
  id: string,
  tool: string,
  createdAt: number,
  allocationState: Extract<TmuxAllocationState, 'unallocated' | 'legacy-unclassified'>,
  options: SessionInsertOptions = {},
): WidgetRow {
  db.prepare(
    `INSERT INTO sessions (
       id, seq, created_at, tool, session_id, tmux_allocation_state, origin, a_term_session_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    nextSeq(),
    createdAt,
    tool,
    `aico-widget-${id}`,
    allocationState,
    options.origin ?? 'aico',
    options.aTermSessionId ?? null,
  )
  return getWidget(id) as WidgetRow
}

/** Insert a genuinely new session. Only this state can prove no tmux allocation
 * ever existed and therefore authorize a first launch after a crash. */
export function insertWidget(
  id: string,
  tool: string,
  createdAt = Date.now(),
  options: SessionInsertOptions = {},
): WidgetRow {
  return insertInternalWidget(id, tool, createdAt, 'unallocated', options)
}

export interface RootRequestRow {
  requestId: string
  digest: string
  widgetId: string
  logicalSessionId: string
  role: string
  leadRootReference: string | null
  facetCapsuleRef: string | null
  createdAt: number
  /** Tether: requesting app (schema v3). Imported Aico rows are `aico`. */
  origin: 'aico' | 'a-term'
}

function rootRequestRow(row: Record<string, unknown>): RootRequestRow {
  return {
    requestId: row.request_id as string,
    digest: row.digest as string,
    widgetId: row.widget_id as string,
    logicalSessionId: row.logical_session_id as string,
    role: row.role as string,
    leadRootReference: row.lead_root_reference as string | null,
    facetCapsuleRef: row.facet_capsule_ref as string | null,
    createdAt: row.created_at as number,
    origin: row.origin === 'a-term' ? 'a-term' : 'aico',
  }
}

export function getRootRequest(requestId: string): RootRequestRow | undefined {
  const row = db.prepare('SELECT * FROM root_requests WHERE request_id = ?').get(requestId)
  return row ? rootRequestRow(row) : undefined
}

export function rootRequestForWidget(widgetId: string): RootRequestRow | undefined {
  const row = db.prepare('SELECT * FROM root_requests WHERE widget_id = ?').get(widgetId)
  return row ? rootRequestRow(row) : undefined
}

export function listRootRequests(): RootRequestRow[] {
  return db
    .prepare('SELECT * FROM root_requests ORDER BY created_at, request_id')
    .all()
    .map(rootRequestRow)
}

/** One transaction reserves the key and its never-allocated widget. */
export function reserveRootRequest(
  request: RootRequestRow,
  tool: string,
  projectId: string,
  projectRoot: string,
  aTermSessionId: string | null = null,
): RootRequestRow {
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = getRootRequest(request.requestId)
    if (existing) {
      db.exec('COMMIT')
      return existing
    }
    insertWidget(request.widgetId, tool, request.createdAt, {
      origin: request.origin === 'a-term' ? 'a-term' : 'root',
      aTermSessionId: request.origin === 'a-term' ? aTermSessionId : null,
    })
    setWidgetProject(request.widgetId, projectId, projectRoot)
    db.prepare(`INSERT INTO root_requests
      (request_id, digest, widget_id, logical_session_id, role, lead_root_reference, facet_capsule_ref, created_at, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      request.requestId,
      request.digest,
      request.widgetId,
      request.logicalSessionId,
      request.role,
      request.leadRootReference,
      request.facetCapsuleRef,
      request.createdAt,
      request.origin ?? 'aico',
    )
    db.exec('COMMIT')
    return request
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Insert a row observed in a pre-catalog tmux roster. A crash before the
 * subsequent generation bind remains fail-closed rather than turning live
 * orphaned work into an apparently fresh widget. */
export function insertLegacyUnclassifiedWidget(
  id: string,
  tool: string,
  createdAt = Date.now(),
): WidgetRow {
  return insertInternalWidget(id, tool, createdAt, 'legacy-unclassified')
}

/** Update a widget's TUI slug (e.g. after "Replace with <TUI>" in the widget),
 * so a later kill+recreate launches the TUI that's actually running there now. */
export function setWidgetTool(id: string, tool: string): void {
  db.prepare('UPDATE sessions SET tool = ? WHERE id = ?').run(tool, id)
}

/** Coordinator colours, in order of assignment. The first is Aico's original
 * coordinator blue. Readable as text and as a 16% tint on dark chrome. */
export const COORDINATOR_COLORS = [
  '#6fa8ff',
  '#f0a35e',
  '#5ccf94',
  '#d48cf0',
  '#e6c55a',
  '#5ccfd6',
  '#f07f8f',
  '#a9b4ff',
] as const

/** The first palette colour no live coordinator holds (wrapping when all are
 * taken), so coordinators on screen together never share a colour. */
function freeCoordinatorColor(): string {
  const taken = new Set(
    (
      db.prepare('SELECT coordinator_color AS color FROM sessions WHERE coordinator = 1').all() as {
        color: string | null
      }[]
    ).map((row) => row.color),
  )
  return (
    COORDINATOR_COLORS.find((color) => !taken.has(color)) ??
    COORDINATOR_COLORS[taken.size % COORDINATOR_COLORS.length]
  )
}

/** Mark or unmark a coordinator. Marking keeps an existing colour, else takes
 * a free one; lanes keep the colour they were launched with. */
export function setCoordinator(id: string, coordinator: boolean): void {
  const row = getWidget(id)
  if (!row || row.coordinator === coordinator) return
  if (!coordinator) {
    db.prepare('UPDATE sessions SET coordinator = 0 WHERE id = ?').run(id)
    return
  }
  // A lane's colour is its coordinator's; a lane promoted to coordinator
  // takes its own.
  const color =
    row.coordinatorId === null && row.coordinatorColor
      ? row.coordinatorColor
      : freeCoordinatorColor()
  db.prepare(
    'UPDATE sessions SET coordinator = 1, coordinator_id = NULL, coordinator_color = ? WHERE id = ?',
  ).run(color, id)
}

/** Ids of the sessions that belong to coordinator `id`. */
export function listLanes(id: string): string[] {
  return (
    db.prepare('SELECT id FROM sessions WHERE coordinator_id = ?').all(id) as { id: string }[]
  ).map((lane) => lane.id)
}

/** Make an existing session a lane of `coordinatorId`'s root coordinator
 * (for sessions launched before lineage was recorded). The session stops
 * being a coordinator and its own lanes move with it. Returns the ids whose
 * descriptors changed; empty when the coordinator is unknown or is the
 * session itself. */
export function joinCoordinator(id: string, coordinatorId: string): string[] {
  const row = getWidget(id)
  const lead = getWidget(coordinatorId)
  if (!row || !lead) return []
  const rootId = lead.coordinatorId ?? lead.id
  if (rootId === id) return []
  if (!getWidget(rootId)?.coordinator && rootId === lead.id) setCoordinator(rootId, true)
  const color = getWidget(rootId)?.coordinatorColor ?? lead.coordinatorColor
  const lanes = listLanes(id)
  db.prepare(
    'UPDATE sessions SET coordinator = 0, coordinator_id = ?, coordinator_color = ? WHERE id = ? OR coordinator_id = ?',
  ).run(rootId, color, id, id)
  return [id, rootId, ...lanes]
}

/** Record who launched a new session: its root coordinator is the launcher's
 * coordinator, or the launcher itself, which then becomes a coordinator.
 * Returns the ids whose descriptors changed. A launcher Tether does not know
 * leaves the session without a coordinator. */
export function recordLauncher(id: string, launchedBy: string): string[] {
  const launcher = getWidget(launchedBy)
  if (!launcher || launcher.id === id) return []
  const changed = [id]
  let rootId = launcher.coordinatorId
  let color = launcher.coordinatorColor
  // A lane hands down its root coordinator, even one that has ended.
  if (rootId === null) {
    if (!launcher.coordinator) changed.push(launcher.id)
    setCoordinator(launcher.id, true)
    rootId = launcher.id
    color = getWidget(launcher.id)?.coordinatorColor ?? null
  }
  db.prepare('UPDATE sessions SET coordinator_id = ?, coordinator_color = ? WHERE id = ?').run(
    rootId,
    color,
    id,
  )
  return changed
}

/** Set (or clear, with null/empty) a widget's user-chosen title-bar name. */
export function setWidgetName(id: string, name: string | null): void {
  const trimmed = name?.trim()
  db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(trimmed || null, id)
}

/** Bind a widget to a workspace/project (slug + its resolved fs root), or clear
 * both with null to fall back to the global `st` active project. The root is
 * resolved once here (at switch time) so the per-widget cwd is later cheap. */
export function setWidgetProject(
  id: string,
  projectId: string | null,
  projectRoot: string | null,
): void {
  db.prepare('UPDATE sessions SET project_id = ?, project_root = ? WHERE id = ?').run(
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
      `UPDATE sessions
       SET scope_unit = ?, scope_invocation_id = ?, lifecycle_version = ?,
           tmux_session_id = ?, pane_id = ?
       WHERE id = ?`,
    ).run(scopeUnit, scopeInvocationId, lifecycleVersion, tmuxSessionId, paneId, id)
    return
  }
  assertTmuxServerId(tmuxServerId)
  db.prepare(
    `UPDATE sessions
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
      `UPDATE sessions
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
      `UPDATE sessions
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
      `UPDATE sessions
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
      `DELETE FROM sessions
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
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}
