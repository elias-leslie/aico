// Tether's session lifecycle engine, extracted from Aico electron/main/index.ts
// at dfe73a3. The functions keep Aico's names, ordering and comments; only the
// Electron view/PTY parts are gone and three things are parameterized:
//   * the instance paths (state dir, tmux dir, pane-exit marker dir);
//   * the tmux server environment, applied through `/usr/bin/env -i` inside the
//     systemd-run argv (src/env.ts);
//   * failure reporting, which returns typed results for the API instead of
//     writing to a window.
// One daemon process serves one instance, so module state here is per instance
// (exactly as it was per Electron process). There is ONE LifecycleOwnerLock.

import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir, uptime } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { agentExitMarkerDir, ownsTmuxServerUnit, type TetherPaths } from '../config'
import {
  cleanEnvArgv,
  passthroughFromEnv,
  sessionEnvironment,
  shimDirectory,
  tmuxServerEnvironment,
  withShimPath,
} from '../env'
import type { EventBus } from '../events'
import {
  type AdmissionRequest,
  type AdmissionTicket,
  AgentAdmission,
  AgentAdmissionDenied,
  nightshiftAdmissionPath,
  observeAgentScopes,
  readNightshiftAdmission,
} from './agent-admission'
import {
  activateTmuxServer,
  adoptActiveLegacyTmuxServer,
  bindWidgetTmuxServer,
  clearCrashedTmuxServerBinding,
  clearReconciledDeadTmuxServerBinding,
  clearReconciledHistoricalTmuxServerBinding,
  clearWidgetPendingScope,
  compareAndSetWidgetLaunchMetadata,
  compareAndSetWidgetOwnership,
  getCurrentManagedTmuxServer,
  getTmuxServer,
  getWidget,
  insertLegacyUnclassifiedWidget,
  insertProvisioningTmuxServer,
  listLanes,
  listTmuxServers,
  listWidgets,
  markTmuxServerDead,
  removeWidgetIfOwnership,
  setWidgetPendingScope,
  setWidgetProject,
  setWidgetTool,
  type TmuxServerRow,
  type WidgetOwnershipGeneration,
  type WidgetRow,
} from './catalog'
import { displayTitle } from './display'
import {
  CoalescedLifecycleIntent,
  decideManagedGateRecovery,
  hasPersistedScopeCleanupEvidence,
  isNeverAllocatedWidget,
  LifecycleOwnerLock,
  type LifecycleOwnerToken,
  type ManagedGateState,
  mayClearMatchingPendingScope,
} from './lifecycle-guard'
import {
  ownershipGeneration,
  type RetirementOperations,
  type RetirementResult,
  retireOwnedSession,
  type SessionState,
} from './owner-retirement'
import { readCgroupPopulated, scopeIdentity, stopOwnedPaneScope } from './owner-scope'
import {
  currentLifecycleInstance,
  durableTmuxServerArgs,
  durableTmuxServerUnit,
  isOwnedPaneControlGroup,
  isOwnedPaneScope,
  isOwnedTmuxServerControlGroup,
  isSystemdInvocationId,
  MANAGED_LIFECYCLE_VERSION,
  ownershipEnvironment,
  paneScopeFromCgroup,
  parseScopeResources,
} from './ownership'
import { PaneExitReconciliationQueue } from './pane-exit-queue'
import {
  cgroupProcessIds,
  isExactLaunchGateProcess,
  processControlGroup,
  processEnvironment,
  processInControlGroup,
  processStartTime,
  processStartTimeFromStat,
} from './procfs'
import {
  hasLaunchPrompt,
  initialLaunchLine,
  rootLaunchEnvironment,
  rootPromptReady,
} from './root-launch'
import { terminalClientEnv } from './terminal-env'
import {
  hasTargetArgs,
  internalTarget,
  isTmuxTransportUnavailable,
  killTargetArgs,
  listSessionPaneDetailsTargetArgs,
  listSessionPanesTargetArgs,
  matchesServerIdentityEnvironment,
  newDetachedTargetArgs,
  paneExitedEventPath,
  paneExitedHookCommand,
  paneExitedHookTargetArgs,
  panePidTargetArgs,
  respawnTargetArgs,
  runInPaneTargetArgs,
  serverIdentityEnvironmentTargetArgs,
  serverRosterArgs,
  sessionIdTargetArgs,
  sessionName,
  showPaneExitedHookTargetArgs,
  TMUX_SOCKET,
  type TmuxTarget,
  tmuxConf,
  tmuxProfileTargetArgs,
  widgetIdFromSession,
} from './tmux'
import {
  classifyTmuxServerState,
  type TmuxServerProcessEvidence,
  type TmuxServerRosterEvidence,
  type TmuxServerRuntimeState,
  type TmuxServerUnitEvidence,
} from './tmux-server-state'
import { ensureContext } from './tui/context'
import { detectTuiFromProcessNames, parseProcessTable, processTreeNames } from './tui/detect'
import { launchLine, paneCommand, paneGatePath } from './tui/launch'
import { getTui, listTuis } from './tui/registry'
import type { ContextStatus, TuiSpec } from './tui/spec'

const execFileAsync = promisify(execFile)
const LOGINCTL_BIN = '/usr/bin/loginctl'
const PS_BIN = '/usr/bin/ps'
const SYSTEMCTL_BIN = '/usr/bin/systemctl'
const SYSTEMD_RUN_BIN = '/usr/bin/systemd-run'
const TMUX_BIN = '/usr/bin/tmux'
const SYSTEMD_QUERY_TIMEOUT_MS = 2_000
const SYSTEMD_STOP_TIMEOUT_MS = 5_000

export interface PtySize {
  cols: number
  rows: number
}

// --- configuration ---------------------------------------------------------

interface EngineConfig {
  paths: TetherPaths
  events: EventBus | null
  /** Base environment the server allow-list filters (the daemon's own). */
  env: NodeJS.ProcessEnv
  /** Resolve a project id to its root (SummitFlow/local provider cache). */
  projectRoot: (projectId: string) => string | null
  /** The desktop session's current graphical variables; they win over `env`. */
  graphicalEnv?: () => Record<string, string>
}

let config: EngineConfig | null = null

function cfg(): EngineConfig {
  if (!config) throw new Error('lifecycle engine is not configured')
  return config
}

function stateDir(): string {
  return cfg().paths.stateDir
}

function tmuxConfPath(): string {
  return join(stateDir(), 'tmux.conf')
}

/** Bind the instance. The daemon calls this once before `startLifecycle`. */
export function configureEngine(next: EngineConfig): void {
  config = next
}

// --- Aico index.ts state ---------------------------------------------------

/** Latest deferral reason per session; cleared on each new start attempt. */
const agentAdmissionReasons = new Map<string, string>()
const agentAdmission = new AgentAdmission(
  {
    meminfo: () => readFile('/proc/meminfo', 'utf8'),
    memoryPressure: () => readFile('/proc/pressure/memory', 'utf8'),
    activeAgentScopes: () => {
      const uid = process.getuid?.()
      if (uid === undefined) throw new Error('uid unavailable')
      return observeAgentScopes({
        fs: {
          listDirectories: async (path) =>
            (await readdir(path, { withFileTypes: true }))
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name),
          readFile: (path) => readFile(path, 'utf8'),
        },
        appSliceDir: `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`,
        isPaneScope: isOwnedPaneScope,
        agentProcessNames: new Set(
          listTuis()
            .filter((tui) => tui.slug !== 'shell' && tui.processName)
            .map((tui) => tui.processName),
        ),
      })
    },
    nightshiftVerdict: () => readNightshiftAdmission(nightshiftAdmissionPath()),
  },
  {
    // Numbers and identifiers only: never prompt, session or terminal content.
    record: (observation) => console.log(`[tether:admission] ${JSON.stringify(observation)}`),
  },
)

/** Reserve host capacity for a new agent TUI. Shells and live reconnects never call this. */
async function reserveAgentLaunch(request: AdmissionRequest): Promise<AdmissionTicket> {
  try {
    const ticket = await agentAdmission.reserve(request)
    agentAdmissionReasons.delete(request.widgetId)
    return ticket
  } catch (error) {
    const message =
      error instanceof AgentAdmissionDenied
        ? error.message
        : 'Tether deferred this agent launch: host admission failed unexpectedly. Nothing was started; retry shortly.'
    agentAdmissionReasons.set(request.widgetId, message)
    throw error instanceof AgentAdmissionDenied
      ? error
      : new AgentAdmissionDenied('host admission failed unexpectedly.')
  }
}

const sessionStartPromises = new Map<string, Promise<boolean>>()
// Serialize destructive operations per durable session. One lock per process:
// the v1 API, the legacy owner socket, the root routes and pane-exit
// reconciliation all go through it.
export const lifecycleOwners = new LifecycleOwnerLock()
// A confirmed retirement is an explicit caller intent, not a best-effort probe.
// Coalesce repeat requests while another lifecycle operation owns the session,
// and consume the intent only after retirement acquires that exact token.
const widgetRetireIntents = new CoalescedLifecycleIntent()
let quitting = false
let durableUserManager = false

function detectDurableUserManager(): boolean {
  const uid = process.getuid?.()
  if (uid === undefined) return false
  try {
    return (
      execFileSync(LOGINCTL_BIN, ['show-user', String(uid), '--property=Linger', '--value'], {
        encoding: 'utf8',
        timeout: SYSTEMD_QUERY_TIMEOUT_MS,
      }).trim() === 'yes'
    )
  } catch {
    return false
  }
}

function logWidgetEvent(widgetId: string, event: string, data: Record<string, unknown>): void {
  // Aico forwarded these to its sidecar's per-widget JSONL log. Tether keeps
  // them in its journal: identifiers only, never content.
  console.log(`[tether:event] ${JSON.stringify({ widget: widgetId, event, ...data })}`)
}

function ensureTmuxConf(): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  writeFileSync(tmuxConfPath(), tmuxConf())
}

function syncManagedTmuxProfile(server: TmuxServerRow): boolean {
  try {
    if (!ensurePaneExitFsWatcher()) return false
    execFileSync(TMUX_BIN, tmuxProfileTargetArgs(server.socketPath), {
      env: terminalClientEnv(),
      timeout: TMUX_QUERY_TIMEOUT_MS,
      stdio: 'ignore',
    })
    execFileSync(TMUX_BIN, paneExitedHookTargetArgs(server.socketPath, server.id), {
      env: terminalClientEnv(),
      timeout: TMUX_QUERY_TIMEOUT_MS,
      stdio: 'ignore',
    })
    paneExitEventReady.add(server.id)
    if (paneExitEventMarkerExists(server.id)) observePaneExitEvent(server.id)
    return true
  } catch (error) {
    paneExitEventReady.delete(server.id)
    console.error(
      `[tether:lifecycle] managed tmux profile/event bridge failed for server=${server.id}:`,
      error,
    )
    return false
  }
}

export function tmuxTargetForWidget(widgetId: string): TmuxTarget {
  const row = getWidget(widgetId)
  const server = row?.tmuxServerId ? getTmuxServer(row.tmuxServerId) : undefined
  const target = internalTarget(widgetId)
  return {
    socket: server?.socketPath ?? target.socket,
    session: row?.tmuxSessionId ?? target.session,
  }
}

/** Commands that operate on a pane (rather than the whole session) use the
 * server-stable pane id after ownership promotion. This prevents a manually
 * selected/active pane from redirecting replacement or launch work. */
export function tmuxPaneTargetForWidget(widgetId: string): TmuxTarget {
  const target = tmuxTargetForWidget(widgetId)
  const paneId = getWidget(widgetId)?.paneId
  return paneId ? { ...target, session: paneId } : target
}

type InternalSessionState = 'present' | 'absent' | 'unknown'

const TMUX_QUERY_TIMEOUT_MS = 2_000
const tmuxServerRuntimeStates = new Map<string, TmuxServerRuntimeState>()

interface TmuxServerRosterEntry {
  serverPid: number
  sessionId: string
  sessionName: string
  createdAt: number
}

const tmuxServerRosters = new Map<string, readonly TmuxServerRosterEntry[]>()
const paneExitEventReady = new Set<string>()
const paneExitQueue = new PaneExitReconciliationQueue({
  reconcile: (serverId) => handlePaneExitWatcherCompletion(serverId),
  isQuitting: () => quitting,
  onError: (serverId, error) =>
    console.error(
      `[tether:lifecycle] pane-exit reconciliation failed for server=${serverId}:`,
      error,
    ),
})
let paneExitFsWatcher: FSWatcher | null = null
let paneExitWatcherRecoveryAttempted = false
let tmuxServerAllocationTail: Promise<void> = Promise.resolve()

async function serializeTmuxServerAllocation<T>(operation: () => Promise<T>): Promise<T> {
  const predecessor = tmuxServerAllocationTail
  let release = (): void => {}
  tmuxServerAllocationTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await predecessor
  try {
    return await operation()
  } finally {
    release()
  }
}

/** Where pane supervisors record each agent's fate (crash recovery reads it). */
function supervisorExitDir(): string | null {
  return config ? agentExitMarkerDir(config.paths) : null
}

/** Tether: `/run/user/<uid>/aico` on `default`, the instance's own
 * `pane-exits` directory otherwise (src/config.ts). */
function paneExitEventDirectory(): string | null {
  return config?.paths.paneExitMarkerDir ?? null
}

function paneExitEventMarkerExists(serverId: string): boolean {
  try {
    return statSync(paneExitedEventPath(serverId)).isFile()
  } catch {
    return false
  }
}

function observePaneExitEvent(serverId: string): void {
  // The marker is level-triggered evidence and deliberately remains on disk.
  // Unlinking before a successful pass allowed a transient tmux/systemd query
  // failure to acknowledge the event and strand a tree until app restart. A
  // later `touch` still emits a watcher event, while startup sees the marker.
  // Tether: a marker for another instance's generation is never this
  // instance's work; only catalogued servers are reconciled.
  if (!getTmuxServer(serverId)) return
  paneExitQueue.observe(serverId)
}

function observePersistedPaneExitEvents(directory: string): void {
  for (const name of readdirSync(directory)) {
    const match = /^pane-exited-([0-9a-f]{8,64})$/.exec(name)
    if (match) observePaneExitEvent(match[1])
  }
}

function ensurePaneExitFsWatcher(): boolean {
  if (paneExitFsWatcher) return true
  const directory = paneExitEventDirectory()
  if (!directory) return false
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const watcher = watch(directory, (_event, filename) => {
      if (filename === null) {
        // Linux normally supplies a name, but Node documents it as optional.
        // Rescan the private directory so an overflow/backend omission cannot
        // strand a durable marker until the next daemon restart.
        try {
          observePersistedPaneExitEvents(directory)
        } catch (error) {
          console.error('[tether:lifecycle] pane-exit event rescan failed:', error)
        }
        return
      }
      const name = filename.toString()
      const match = /^pane-exited-([0-9a-f]{8,64})$/.exec(name)
      if (match) observePaneExitEvent(match[1])
    })
    watcher.once('error', (error) => {
      if (paneExitFsWatcher === watcher) paneExitFsWatcher = null
      paneExitEventReady.clear()
      console.error(
        '[tether:lifecycle] pane-exit event watcher failed; new launches are blocked:',
        error,
      )
      // One backend recreation is justified by this observed watcher failure;
      // a guard prevents a persistent inotify/runtime-directory fault from
      // becoming a retry loop. Attach/diagnostics remain concrete later retry
      // triggers and startup always rescans the retained markers.
      if (!quitting && !paneExitWatcherRecoveryAttempted) {
        paneExitWatcherRecoveryAttempted = true
        setTimeout(() => ensurePaneExitFsWatcher(), 0)
      }
    })
    paneExitFsWatcher = watcher
    observePersistedPaneExitEvents(directory)
    return true
  } catch (error) {
    console.error('[tether:lifecycle] could not start pane-exit event watcher:', error)
    return false
  }
}

async function handlePaneExitWatcherCompletion(serverId: string): Promise<boolean> {
  const rows = listWidgets().filter((row) => row.tmuxServerId === serverId)
  for (const row of rows) {
    if (lifecycleOwners.isHeld(row.id)) {
      // Respawn/retire can itself emit pane-exited. Its explicit path owns the
      // exact cleanup; queue one follow-up pass after that ownership token is
      // released instead of spinning or dropping the detached-exit signal.
      paneExitQueue.defer(serverId)
      continue
    }
    await settleServerAfterSessionStop(row)
    await reconcileManagedWidget(row)
  }
  for (const row of listWidgets().filter((candidate) => candidate.tmuxServerId === serverId)) {
    if (lifecycleOwners.isHeld(row.id)) return false
    // Lifecycle-v0 work is deliberately observation-only and cannot have been
    // launched by this managed generation's hook.
    if (row.lifecycleVersion < MANAGED_LIFECYCLE_VERSION) continue
    const state = await internalSessionState(row.id)
    const current = getWidget(row.id)
    if (!current) continue
    if (state === 'unknown' || current.pendingScopeUnit) return false
    if (state === 'absent' && current.scopeUnit) return false
    if (state === 'present' && !(await verifiedCurrentManagedPane(current))) return false
  }
  publishCatalogChanges()
  return !paneExitQueue.isDeferred(serverId)
}

function retryUnresolvedPaneExitReconciliation(serverId: string | null): void {
  if (!serverId) return
  if (!paneExitFsWatcher) ensurePaneExitFsWatcher()
  if (paneExitEventMarkerExists(serverId)) {
    observePaneExitEvent(serverId)
  } else {
    paneExitQueue.retryUnresolved(serverId)
  }
}

export function releaseLifecycleOwner(
  widgetId: string,
  owner: LifecycleOwnerToken,
  knownServerId?: string | null,
): void {
  if (!lifecycleOwners.release(owner)) return
  // A confirmed retire has priority over watcher reconciliation for the same
  // session. Acquire it synchronously after release; the watcher then observes
  // the held token and defers instead of repeatedly winning the race.
  if (widgetRetireIntents.isPending(widgetId)) drainWidgetRetire(widgetId)
  const serverId = knownServerId ?? getWidget(widgetId)?.tmuxServerId
  if (serverId) paneExitQueue.releaseDeferred(serverId)
}

function tmuxErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const value = (error as { stderr?: string | Buffer }).stderr
  return Buffer.isBuffer(value) ? value.toString('utf8') : (value ?? '')
}

/** Resolve session presence only through a freshly revalidated server
 * generation. A cached successful probe or a bare `has-session` response is
 * not cleanup authority: a socket path can be unlinked and rebound to another
 * tmux server while the persisted generation remains alive elsewhere. */
export async function internalSessionState(widgetId: string): Promise<InternalSessionState> {
  const row = getWidget(widgetId)
  if (!row) return 'unknown'
  if (row.tmuxServerId) {
    const server = getTmuxServer(row.tmuxServerId)
    if (server?.phase === 'dead') return 'absent'
    if (!server || server.phase !== 'active') return 'unknown'
    // Tether: a row bound to another instance's server is never probed.
    if (!ownsServerRow(server)) return 'unknown'
    await observeTmuxServer(server)
  }
  return observedInternalSessionState(row)
}

/** Interpret only a roster snapshot that was already proven against its exact
 * server tuple. Startup uses this for present sessions; an absent result is
 * always freshly re-probed before it can authorize cleanup. */
function observedInternalSessionState(row: WidgetRow): InternalSessionState {
  if (row.tmuxServerId) {
    const server = getTmuxServer(row.tmuxServerId)
    if (server?.phase === 'dead') return 'absent'
    if (!server || tmuxServerRuntimeStates.get(server.id) !== 'reachable') return 'unknown'
    const roster = tmuxServerRosters.get(server.id)
    if (!roster) return 'unknown'
    const present = row.tmuxSessionId
      ? roster.some((entry) => entry.sessionId === row.tmuxSessionId)
      : roster.some((entry) => entry.sessionName === sessionName(row.id))
    return present ? 'present' : 'absent'
  }
  // Only a row created by the current schema and never allocated is known not
  // to have durable tmux work. Migrated legacy rows remain unclassified until a
  // verified historical roster binds them; name lookup failure is not absence.
  return row.tmuxAllocationState === 'unallocated' ? 'absent' : 'unknown'
}

/**
 * Tether: which catalogued servers this instance may observe and reconcile.
 * Managed rows must carry this instance's unit name; legacy-observed rows (the
 * historical shared socket) belong to `default` only. Anything else is foreign
 * evidence, kept but never probed, adopted or stopped.
 */
export function ownsServerRow(server: TmuxServerRow): boolean {
  if (server.kind === 'legacy-observed') return currentLifecycleInstance() === 'default'
  return ownsTmuxServerUnit(currentLifecycleInstance(), server.scopeUnit)
}

const TMUX_SERVER_SETTLE_MS = 5_000
const TMUX_SERVER_POLL_MS = 50

function tmuxServerEnvironmentMatches(pid: number, serverId: string): boolean {
  const values = processEnvironment(pid)
  return (
    values?.get('AICO_OWNER') === 'aico' &&
    values.get('AICO_WORKLOAD_CLASS') === 'durable-tmux-server' &&
    values.get('AICO_TMUX_SERVER_ID') === serverId
  )
}

async function recoverProvisioningTmuxServer(
  server: TmuxServerRow,
  allowDeadTransition: boolean,
): Promise<TmuxServerRow | null> {
  if (server.kind !== 'managed' || server.phase !== 'provisioning') return null
  if (!ownsServerRow(server)) return null
  const roster = readTmuxServerRoster(server.socketPath)
  if (roster.evidence.status === 'reachable') {
    const pid = roster.evidence.serverPid
    try {
      const startTime = processStartTimeFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      const processCgroup = processControlGroup(pid)
      const identity = await scopeIdentity(server.scopeUnit)
      const uid = process.getuid?.() ?? -1
      if (
        !startTime ||
        !processCgroup ||
        !identity ||
        identity.activeState !== 'active' ||
        !isSystemdInvocationId(identity.invocationId) ||
        !isOwnedTmuxServerControlGroup(server.scopeUnit, identity.controlGroup, uid) ||
        processCgroup !== identity.controlGroup ||
        !tmuxServerEnvironmentMatches(pid, server.id)
      ) {
        return null
      }
      if (
        !activateTmuxServer(server.id, {
          controlGroup: identity.controlGroup,
          invocationId: identity.invocationId,
          serverPid: pid,
          procStartTime: startTime,
        })
      ) {
        return null
      }
      const active = getTmuxServer(server.id)
      if (!active || (await observeTmuxServer(active)) !== 'reachable') return null
      if (!syncManagedTmuxProfile(active)) return null
      return active
    } catch {
      return null
    }
  }

  if (allowDeadTransition && roster.evidence.status === 'transport-failure') {
    const identity = await scopeIdentity(server.scopeUnit)
    const uid = process.getuid?.() ?? -1
    const expectedControlGroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${server.scopeUnit}`
    if (
      identity?.loadState === 'not-found' &&
      identity.job === '' &&
      readCgroupPopulated(expectedControlGroup) === false
    ) {
      markTmuxServerDead(server.id)
      tmuxServerRuntimeStates.set(server.id, 'dead')
    }
  }
  return null
}

async function provisioningTmuxServerProvablyAbsent(server: TmuxServerRow): Promise<boolean> {
  const roster = readTmuxServerRoster(server.socketPath)
  if (roster.evidence.status !== 'transport-failure') return false
  const identity = await scopeIdentity(server.scopeUnit)
  const uid = process.getuid?.() ?? -1
  const controlGroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${server.scopeUnit}`
  return Boolean(
    identity?.loadState === 'not-found' &&
      identity.job === '' &&
      readCgroupPopulated(controlGroup) === false,
  )
}

/** Only startup reconciliation may tombstone an incomplete generation, after
 * the socket, exact unit/job, and exact cgroup have all remained absent for the
 * same intrinsic server-placement settle window used by creation. Runtime
 * allocators preserve an unresolved provisioning record and never race it with
 * a competing generation. */
async function reconcileProvisioningTmuxServer(
  server: TmuxServerRow,
): Promise<TmuxServerRow | null> {
  const deadline = Date.now() + TMUX_SERVER_SETTLE_MS
  do {
    const recovered = await recoverProvisioningTmuxServer(server, false)
    if (recovered) return recovered
    if (!(await provisioningTmuxServerProvablyAbsent(server))) return null
    await new Promise((resolve) => setTimeout(resolve, TMUX_SERVER_POLL_MS))
  } while (Date.now() < deadline)
  await recoverProvisioningTmuxServer(server, true)
  return null
}

function createManagedServerDirectory(serverId: string): string {
  const parent = cfg().paths.tmuxDir
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  chmodSync(parent, 0o700)
  const directory = join(parent, serverId)
  mkdirSync(directory, { mode: 0o700 })
  return directory
}

/** Tether: the exact environment a new tmux server starts with. It becomes the
 * tmux global environment and so reaches every pane; the user manager's own
 * block (which systemd-run services otherwise inherit) is replaced. */
export function serverEnvironmentPrefix(serverId: string): string[] {
  const base = { ...cfg().env, ...cfg().graphicalEnv?.() }
  return cleanEnvArgv({
    ...tmuxServerEnvironment(base, passthroughFromEnv(base)),
    AICO_OWNER: 'aico',
    AICO_WORKLOAD_CLASS: 'durable-tmux-server',
    AICO_TMUX_SERVER_ID: serverId,
  })
}

async function provisionManagedServerWithSession(
  widgetId: string,
  expectedServerId: string | null,
  size: PtySize,
  cwd: string,
  environment: Record<string, string>,
): Promise<TmuxServerRow> {
  const serverId = randomBytes(16).toString('hex')
  const directory = createManagedServerDirectory(serverId)
  const socketPath = join(directory, 'server.sock')
  const scopeUnit = durableTmuxServerUnit(serverId)
  const provisioning = insertProvisioningTmuxServer({ id: serverId, socketPath, scopeUnit })
  if (!bindWidgetTmuxServer(widgetId, expectedServerId, serverId)) {
    markTmuxServerDead(serverId)
    throw new Error(`could not bind ${widgetId} to new tmux server generation`)
  }

  const target: TmuxTarget = { socket: socketPath, session: sessionName(widgetId) }
  const tmuxArgs = newDetachedTargetArgs(target, size.cols, size.rows, tmuxConfPath(), cwd, {
    ...environment,
    AICO_TMUX_SERVER_ID: serverId,
  })
  let launchError: unknown = null
  try {
    execFileSync(
      SYSTEMD_RUN_BIN,
      durableTmuxServerArgs(serverId, tmuxArgs, serverEnvironmentPrefix(serverId)),
      {
        env: terminalClientEnv(),
        timeout: SYSTEMD_STOP_TIMEOUT_MS,
      },
    )
  } catch (error) {
    launchError = error
  }

  const deadline = Date.now() + TMUX_SERVER_SETTLE_MS
  do {
    const active = await recoverProvisioningTmuxServer(provisioning, false)
    if (active) {
      console.log(
        `[tether:lifecycle] tmux server=${active.id} pid=${active.serverPid} ` +
          `unit=${active.scopeUnit} invocation=${active.invocationId} class=durable-tmux-server`,
      )
      logWidgetEvent(widgetId, 'lifecycle_tmux_server_owned', {
        tmux_server_id: active.id,
        pid: active.serverPid,
        scope_unit: active.scopeUnit,
        scope_invocation_id: active.invocationId,
        workload_class: 'durable-tmux-server',
      })
      return active
    }
    await new Promise((resolve) => setTimeout(resolve, TMUX_SERVER_POLL_MS))
  } while (Date.now() < deadline)

  // Preserve the provisioning generation on runtime failure. Only a future
  // single-instance startup reconciliation may prove it stayed wholly absent.
  throw new Error('Tether could not prove durable tmux-server ownership; launch remains gated', {
    cause: launchError,
  })
}

async function createInternalSessionOwned(
  widgetId: string,
  size: PtySize,
  cwd: string,
  environment: Record<string, string>,
): Promise<void> {
  let row = getWidget(widgetId)
  if (!row) throw new Error(`session ${widgetId} disappeared before tmux allocation`)

  if (row.tmuxServerId) {
    const bound = getTmuxServer(row.tmuxServerId)
    if (bound?.phase === 'provisioning') {
      const recovered = await recoverProvisioningTmuxServer(bound, false)
      if (recovered && (await internalSessionState(widgetId)) === 'present') return
      throw new Error(`bound tmux server ${row.tmuxServerId} is still provisioning`)
    } else if (
      bound?.phase === 'active' &&
      ownsServerRow(bound) &&
      (await observeTmuxServer(bound)) === 'reachable'
    ) {
      if (bound.scopeUnit.endsWith('.scope')) {
        // Caller-spawned v1 server scopes may have inherited Electron file
        // descriptors. Preserve and reconnect their existing sessions, but do
        // not allocate more work into them; unbound sessions use the clean-FD
        // manager-spawned service generation selected below.
        if (observedInternalSessionState(row) === 'present') return
        throw new Error(`historical tmux server ${bound.id} is observation-only`)
      }
      execFileSync(
        TMUX_BIN,
        newDetachedTargetArgs(
          { socket: bound.socketPath, session: sessionName(widgetId) },
          size.cols,
          size.rows,
          tmuxConfPath(),
          cwd,
          { ...environment, AICO_TMUX_SERVER_ID: bound.id },
        ),
        { env: terminalClientEnv(), timeout: TMUX_QUERY_TIMEOUT_MS },
      )
      return
    } else if (bound?.phase !== 'dead') {
      throw new Error(`bound tmux server ${row.tmuxServerId} is not safely reachable`)
    }
  }

  let current = getCurrentManagedTmuxServer()
  if (current && !ownsServerRow(current)) {
    // Tether: an imported/foreign generation occupies the one-live-service
    // slot. Never allocate beside it or into it from this instance.
    throw new Error(`current tmux server ${current.id} belongs to another instance`)
  }
  if (current?.phase === 'provisioning') {
    const recovered = await recoverProvisioningTmuxServer(current, false)
    if (!recovered) {
      throw new Error(
        `tmux server ${current.id} is still provisioning; refusing another generation`,
      )
    }
    current = recovered
  }
  if (current?.phase === 'active') {
    const state = await observeTmuxServer(current)
    if (state !== 'reachable') {
      throw new Error(`current tmux server ${current.id} is ${state}; refusing a competing server`)
    }
    if (!bindWidgetTmuxServer(widgetId, row.tmuxServerId, current.id)) {
      throw new Error(`could not bind ${widgetId} to current tmux server ${current.id}`)
    }
    execFileSync(
      TMUX_BIN,
      newDetachedTargetArgs(
        { socket: current.socketPath, session: sessionName(widgetId) },
        size.cols,
        size.rows,
        tmuxConfPath(),
        cwd,
        { ...environment, AICO_TMUX_SERVER_ID: current.id },
      ),
      { env: terminalClientEnv(), timeout: TMUX_QUERY_TIMEOUT_MS },
    )
    return
  }
  if (current) {
    throw new Error(`tmux server ${current.id} is unresolved; refusing another generation`)
  }

  row = getWidget(widgetId)
  await provisionManagedServerWithSession(
    widgetId,
    row?.tmuxServerId ?? null,
    size,
    cwd,
    environment,
  )
}

function createInternalSession(
  widgetId: string,
  size: PtySize,
  cwd: string,
  environment: Record<string, string>,
): Promise<void> {
  return serializeTmuxServerAllocation(() =>
    createInternalSessionOwned(widgetId, size, cwd, environment),
  )
}

/** Pane environment (docs/compat-contract.md "Pane environment markers"). */
export function managedEnvironment(
  widgetId: string,
  toolSlug: string,
  projectId?: string | null,
): Record<string, string> {
  const row = getWidget(widgetId)
  const environment = ownershipEnvironment({
    widgetId,
    sessionId: row?.sessionId ?? `aico-widget-${widgetId}`,
    projectId: projectId === undefined ? (row?.projectId ?? null) : projectId,
    tool: toolSlug,
  })
  // The launch gate and supervisor never source shell profiles. Pin the exact
  // service PATH onto every new/respawned pane so context verification and the
  // command that actually runs cannot resolve different launcher binaries.
  environment.PATH = paneGatePath(cfg().env)
  // Agent shims go first on PATH so a system-bus systemctl/systemd-run/pkexec
  // from an agent fails at once instead of popping the owner's polkit dialog
  // (scripts/shims/). Skipped until the installer has created the directory.
  const shimDir = shimDirectory(cfg().env)
  if (isDir(shimDir)) environment.PATH = withShimPath(environment.PATH, shimDir)
  // The durable tmux server starts under the user manager, whose HOME may
  // differ from this process (for example in an isolated test run). Keep the
  // pane's home aligned with the daemon profile and its chosen cwd.
  environment.HOME = cfg().env.HOME ?? homedir()
  // Clipboard image paste and desktop notifications need the live desktop
  // session, even in panes of a server that started before it existed.
  Object.assign(environment, cfg().graphicalEnv?.())
  Object.assign(environment, rootLaunchEnvironment(widgetId))
  if (row?.tmuxServerId) environment.AICO_TMUX_SERVER_ID = row.tmuxServerId
  // Tether: A-Term-created sessions carry A-Term's session id. AICO_TMUX_SOCKET
  // is never exported (it is Aico's process override, not a pane marker).
  if (row?.origin === 'a-term' && row.aTermSessionId) {
    environment.A_TERM_SESSION_ID = row.aTermSessionId
  }
  return sessionEnvironment(environment)
}

export interface ManagedPaneProcess {
  pid: number
  startTime: string
  scopeUnit: string | null
  tmuxSessionId: string
  paneId: string
}

/** Observe one exact server-side session/pane generation. The managed-session
 * contract is deliberately one pane; split sessions are preserved but no
 * lifecycle operation is authorized until the user resolves the ambiguity. */
function currentPaneProcess(widgetId: string): ManagedPaneProcess | null {
  try {
    const row = getWidget(widgetId)
    const target = tmuxTargetForWidget(widgetId)
    const paneLines = execFileSync(TMUX_BIN, listSessionPanesTargetArgs(target), {
      encoding: 'utf8',
      env: terminalClientEnv(),
      timeout: TMUX_QUERY_TIMEOUT_MS,
    })
      .split('\n')
      .filter(Boolean)
    if (paneLines.length !== 1) {
      console.warn(
        `[tether:lifecycle] preserving ${widgetId}: expected one pane, observed ${paneLines.length}`,
      )
      return null
    }
    const [paneId, pidText] = paneLines[0].split('\t')
    const pid = Number(pidText)
    const tmuxSessionId = execFileSync(TMUX_BIN, sessionIdTargetArgs(target), {
      encoding: 'utf8',
      env: terminalClientEnv(),
      timeout: TMUX_QUERY_TIMEOUT_MS,
    }).trim()
    if (!/^%\d+$/.test(paneId) || !/^\$\d+$/.test(tmuxSessionId)) return null
    if (!Number.isInteger(pid) || pid <= 0) return null
    if (row?.tmuxSessionId && row.tmuxSessionId !== tmuxSessionId) {
      console.warn(`[tether:lifecycle] preserving ${widgetId}: tmux session identity changed`)
      return null
    }
    if (row?.paneId && row.paneId !== paneId) {
      console.warn(`[tether:lifecycle] preserving ${widgetId}: tmux pane identity changed`)
      return null
    }
    const startTime = processStartTime(pid)
    if (!startTime) return null
    return {
      pid,
      startTime,
      scopeUnit: paneScopeFromCgroup(readFileSync(`/proc/${pid}/cgroup`, 'utf8')),
      tmuxSessionId,
      paneId,
    }
  } catch {
    return null
  }
}

/** Resolve only the narrow cgroup assigned to this exact tmux pane. Broad app,
 * GNOME, user, and session scopes are intentionally rejected by the parser. */
function currentPaneScope(widgetId: string): string | null {
  return currentPaneProcess(widgetId)?.scopeUnit ?? null
}

// Ubuntu tmux creates a systemd pane scope asynchronously. That ordering is the
// demonstrated escape path: an eagerly-started agent can fork before the move.
// Poll only this local /proc transition, and fail closed after a bounded wait
// rather than launching any workload in the broad desktop scope.
const PANE_SCOPE_SETTLE_MS = 5_000
const PANE_SCOPE_POLL_MS = 25

async function waitForCurrentPaneScope(widgetId: string): Promise<ManagedPaneProcess | null> {
  const deadline = Date.now() + PANE_SCOPE_SETTLE_MS
  const pane = currentPaneProcess(widgetId)
  if (!pane) return null
  if (pane.scopeUnit) return pane
  do {
    if (processStartTime(pane.pid) !== pane.startTime) return null
    try {
      const scopeUnit = paneScopeFromCgroup(readFileSync(`/proc/${pane.pid}/cgroup`, 'utf8'))
      if (scopeUnit) {
        const current = currentPaneProcess(widgetId)
        if (
          !current ||
          current.pid !== pane.pid ||
          current.startTime !== pane.startTime ||
          current.tmuxSessionId !== pane.tmuxSessionId ||
          current.paneId !== pane.paneId ||
          current.scopeUnit !== scopeUnit
        ) {
          return null
        }
        return current
      }
    } catch {
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, PANE_SCOPE_POLL_MS))
  } while (Date.now() < deadline)
  return null
}

interface TmuxRosterRead {
  evidence: TmuxServerRosterEvidence
  entries: readonly TmuxServerRosterEntry[]
  detail: string
}

function readTmuxServerRoster(
  socketPath: string,
  expected?: { serverId: string; serverPid: number },
): TmuxRosterRead {
  try {
    const stdout = execFileSync(TMUX_BIN, serverRosterArgs(socketPath), {
      encoding: 'utf8',
      env: terminalClientEnv(),
      timeout: TMUX_QUERY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const entries: TmuxServerRosterEntry[] = []
    for (const line of stdout.split('\n').filter(Boolean)) {
      const [pidText, sessionId, sessionName, createdText] = line.split('\t')
      const serverPid = Number(pidText)
      const createdSeconds = Number(createdText)
      if (
        !Number.isInteger(serverPid) ||
        serverPid <= 0 ||
        !/^\$\d+$/.test(sessionId) ||
        !sessionName ||
        !Number.isFinite(createdSeconds) ||
        createdSeconds < 0
      ) {
        return { evidence: { status: 'unavailable' }, entries: [], detail: 'malformed roster' }
      }
      entries.push({
        serverPid,
        sessionId,
        sessionName,
        createdAt: createdSeconds * 1000,
      })
    }
    if (entries.length === 0) {
      if (!expected) {
        return { evidence: { status: 'unavailable' }, entries: [], detail: 'empty roster' }
      }
      const identity = execFileSync(TMUX_BIN, serverIdentityEnvironmentTargetArgs(socketPath), {
        encoding: 'utf8',
        env: terminalClientEnv(),
        timeout: TMUX_QUERY_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (!matchesServerIdentityEnvironment(identity, expected.serverId)) {
        return {
          evidence: { status: 'unavailable' },
          entries: [],
          detail: 'empty roster identity mismatch',
        }
      }
      return {
        evidence: { status: 'reachable', serverPid: expected.serverPid },
        entries: [],
        detail: '',
      }
    }
    const serverPids = new Set(entries.map((entry) => entry.serverPid))
    if (serverPids.size !== 1) {
      return { evidence: { status: 'unavailable' }, entries: [], detail: 'mixed roster' }
    }
    return {
      evidence: { status: 'reachable', serverPid: entries[0].serverPid },
      entries,
      detail: '',
    }
  } catch (error) {
    const detail = tmuxErrorText(error)
    return {
      evidence: {
        status: isTmuxTransportUnavailable(detail) ? 'transport-failure' : 'unavailable',
      },
      entries: [],
      detail,
    }
  }
}

function tmuxServerProcessEvidence(server: TmuxServerRow): TmuxServerProcessEvidence {
  const pid = server.serverPid ?? -1
  if (pid <= 0) return { status: 'unavailable', pid }
  try {
    const startTime = processStartTimeFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    if (!startTime) return { status: 'unavailable', pid }
    const controlGroup = processControlGroup(pid)
    if (!controlGroup) return { status: 'unavailable', pid }
    return { status: 'present', pid, procStartTime: startTime, controlGroup }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing', pid }
      : { status: 'unavailable', pid }
  }
}

async function tmuxServerUnitEvidence(server: TmuxServerRow): Promise<TmuxServerUnitEvidence> {
  const identity = await scopeIdentity(server.scopeUnit)
  if (!identity) return { status: 'unavailable', scopeUnit: server.scopeUnit }
  if (identity.loadState === 'not-found') {
    return { status: 'missing', scopeUnit: server.scopeUnit }
  }
  if (identity.activeState !== 'active') {
    return { status: 'inactive', scopeUnit: server.scopeUnit }
  }
  return {
    status: 'active',
    scopeUnit: server.scopeUnit,
    controlGroup: identity.controlGroup,
    invocationId: identity.invocationId,
  }
}

async function observeTmuxServer(server: TmuxServerRow): Promise<TmuxServerRuntimeState> {
  if (server.phase === 'dead') {
    tmuxServerRuntimeStates.set(server.id, 'dead')
    tmuxServerRosters.delete(server.id)
    return 'dead'
  }
  if (server.phase !== 'active' || !ownsServerRow(server)) {
    tmuxServerRuntimeStates.set(server.id, 'ambiguous')
    return 'ambiguous'
  }
  const roster = readTmuxServerRoster(
    server.socketPath,
    server.serverPid ? { serverId: server.id, serverPid: server.serverPid } : undefined,
  )
  const state = classifyTmuxServerState(server, {
    process: tmuxServerProcessEvidence(server),
    unit: await tmuxServerUnitEvidence(server),
    roster: roster.evidence,
  })
  tmuxServerRuntimeStates.set(server.id, state)
  if (state === 'reachable') {
    tmuxServerRosters.set(server.id, roster.entries)
  } else {
    tmuxServerRosters.delete(server.id)
  }
  if (state === 'dead') markTmuxServerDead(server.id)
  if (state !== 'reachable') {
    console.warn(
      `[tether:lifecycle] tmux server=${server.id} kind=${server.kind} state=${state}` +
        (roster.detail ? ` detail=${roster.detail.trim()}` : ''),
    )
  }
  return state
}

async function settleServerAfterSessionStop(row: WidgetRow): Promise<void> {
  if (!row.tmuxServerId) return
  const deadline = Date.now() + SYSTEMD_QUERY_TIMEOUT_MS
  do {
    const server = getTmuxServer(row.tmuxServerId)
    if (!server || server.phase === 'dead') return
    const state = await observeTmuxServer(server)
    if (state === 'reachable' || state === 'dead') return
    if (state !== 'live-unreachable') return
    await new Promise((resolve) => setTimeout(resolve, PANE_SCOPE_POLL_MS))
  } while (Date.now() < deadline)
}

function solePaneId(socketPath: string, stableSessionId: string): string | null {
  try {
    const rows = execFileSync(
      TMUX_BIN,
      listSessionPanesTargetArgs({ socket: socketPath, session: stableSessionId }),
      {
        encoding: 'utf8',
        env: terminalClientEnv(),
        timeout: TMUX_QUERY_TIMEOUT_MS,
      },
    )
      .split('\n')
      .filter(Boolean)
    if (rows.length !== 1) return null
    const [paneId, pidText] = rows[0].split('\t')
    return /^%\d+$/.test(paneId) && Number(pidText) > 0 ? paneId : null
  } catch {
    return null
  }
}

function bindVerifiedServerRoster(
  server: TmuxServerRow,
  entries: readonly TmuxServerRosterEntry[],
): void {
  for (const entry of entries) {
    const widgetId = widgetIdFromSession(entry.sessionName)
    if (!widgetId || !/^[a-f0-9]{8}$/.test(widgetId)) continue
    let row = getWidget(widgetId)
    if (!row) row = insertLegacyUnclassifiedWidget(widgetId, 'shell', entry.createdAt)
    if (row.tmuxServerId && row.tmuxServerId !== server.id) {
      console.warn(
        `[tether:lifecycle] preserving ${entry.sessionName}: session is already bound to server=${row.tmuxServerId}, refusing roster collision with server=${server.id}`,
      )
      continue
    }
    const paneId = solePaneId(server.socketPath, entry.sessionId)
    if (!paneId) {
      console.warn(
        `[tether:lifecycle] preserving ${entry.sessionName}: expected one pane while adopting server=${server.id}`,
      )
      continue
    }
    if (!bindWidgetTmuxServer(row.id, row.tmuxServerId, server.id, entry.sessionId, paneId)) {
      console.warn(
        `[tether:lifecycle] could not bind ${entry.sessionName} to observed server=${server.id}`,
      )
    }
  }
}

/** Default instance only: the historical shared socket is Aico's. */
async function adoptHistoricalTmuxServer(): Promise<TmuxServerRow | null> {
  if (currentLifecycleInstance() !== 'default') return null
  const existing = listTmuxServers().find((server) => server.socketPath === TMUX_SOCKET)
  if (existing) return existing.phase === 'active' ? existing : null

  // Double-read the legacy roster before recording identity. No profile update,
  // key send, respawn, or scope mutation occurs on this observation path.
  const first = readTmuxServerRoster(TMUX_SOCKET)
  const second = readTmuxServerRoster(TMUX_SOCKET)
  if (
    first.evidence.status !== 'reachable' ||
    second.evidence.status !== 'reachable' ||
    first.evidence.serverPid !== second.evidence.serverPid ||
    JSON.stringify(first.entries) !== JSON.stringify(second.entries)
  ) {
    return null
  }
  const pid = first.evidence.serverPid
  try {
    const procStartTime = processStartTimeFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    const controlGroup = processControlGroup(pid)
    const scopeUnit = controlGroup?.split('/').filter(Boolean).at(-1) ?? null
    if (!procStartTime || !controlGroup || !scopeUnit?.endsWith('.scope')) return null
    const identity = await scopeIdentity(scopeUnit)
    if (
      !identity ||
      identity.activeState !== 'active' ||
      identity.controlGroup !== controlGroup ||
      !isSystemdInvocationId(identity.invocationId)
    ) {
      return null
    }
    const adopted = adoptActiveLegacyTmuxServer({
      id: randomBytes(16).toString('hex'),
      socketPath: TMUX_SOCKET,
      scopeUnit,
      controlGroup,
      invocationId: identity.invocationId,
      serverPid: pid,
      procStartTime,
    })
    tmuxServerRuntimeStates.set(adopted.id, 'reachable')
    tmuxServerRosters.set(adopted.id, first.entries)
    bindVerifiedServerRoster(adopted, first.entries)
    console.log(
      `[tether:lifecycle] adopted legacy tmux server=${adopted.id} pid=${pid} ` +
        `scope=${scopeUnit} sessions=${first.entries.length} observation_only=true`,
    )
    return adopted
  } catch (error) {
    console.warn('[tether:lifecycle] legacy tmux server adoption failed closed:', error)
    return null
  }
}

async function reconcileTmuxServers(): Promise<void> {
  for (const server of listTmuxServers()) {
    if (!ownsServerRow(server)) continue
    if (server.phase === 'provisioning') {
      await reconcileProvisioningTmuxServer(server)
      continue
    }
    if (server.phase === 'active') await observeTmuxServer(server)
  }

  const legacy = await adoptHistoricalTmuxServer()
  if (legacy && (await observeTmuxServer(legacy)) === 'reachable') {
    bindVerifiedServerRoster(legacy, tmuxServerRosters.get(legacy.id) ?? [])
  }
  const managed = getCurrentManagedTmuxServer()
  if (
    managed?.phase === 'active' &&
    ownsServerRow(managed) &&
    (await observeTmuxServer(managed)) === 'reachable'
  ) {
    syncManagedTmuxProfile(managed)
    bindVerifiedServerRoster(managed, tmuxServerRosters.get(managed.id) ?? [])
  }
}

function managedPaneMarkersMatch(row: WidgetRow, pid: number): boolean {
  const environment = processEnvironment(pid)
  return (
    environment?.get('AICO_OWNER') === 'aico' &&
    environment.get('AICO_WORKLOAD_CLASS') === 'durable-session' &&
    environment.get('AICO_WIDGET_ID') === row.id &&
    environment.get('AICO_SESSION_ID') === row.sessionId &&
    (!row.tmuxServerId || environment.get('AICO_TMUX_SERVER_ID') === row.tmuxServerId) &&
    environment.get('AICO_LIFECYCLE_VERSION') === String(MANAGED_LIFECYCLE_VERSION)
  )
}

interface ManagedGateLaunchIntent {
  tool: TuiSpec
  projectId: string | null
}

function managedGateLaunchIntent(pid: number): ManagedGateLaunchIntent | null {
  const environment = processEnvironment(pid)
  const toolSlug = environment?.get('AICO_AGENT_SLUG')
  const projectMarker = environment?.get('AICO_PROJECT_ID')
  const tool = toolSlug ? getTui(toolSlug) : undefined
  if (!tool || projectMarker === undefined || projectMarker.includes('\0')) return null
  return { tool, projectId: projectMarker || null }
}

/** Commit launch intent from the verified gate process before sending Enter.
 * A crash after respawn can therefore recover the requested tool/project from
 * the immutable parent environment instead of replaying stale catalog data. */
function persistManagedGateLaunchIntent(row: WidgetRow, pid: number): WidgetRow | null {
  const intent = managedGateLaunchIntent(pid)
  if (!intent) return null
  const root =
    intent.projectId === row.projectId
      ? row.projectRoot
      : intent.projectId
        ? cfg().projectRoot(intent.projectId)
        : null
  if (
    !compareAndSetWidgetLaunchMetadata(
      row.id,
      ownershipGeneration(row),
      intent.tool.slug,
      intent.projectId,
      root,
    )
  ) {
    return null
  }
  return getWidget(row.id) ?? null
}

function markManagedGateDispatched(row: WidgetRow): WidgetRow | null {
  if (row.launchState !== 'gated' || !/^[0-9a-f]{32}$/.test(row.launchNonce ?? '')) return null
  if (!isPaneExitBridgeReady(row)) {
    console.error(
      `[tether:lifecycle] refusing gate dispatch for ${row.sessionId}: ` +
        'detached pane-exit reconciliation is unavailable',
    )
    return null
  }
  if (
    !compareAndSetWidgetOwnership(row.id, ownershipGeneration(row), {
      ...ownershipGeneration(row),
      launchState: 'dispatched',
    })
  ) {
    return null
  }
  return getWidget(row.id) ?? null
}

function isPaneExitBridgeReady(row: WidgetRow): boolean {
  if (
    quitting ||
    !paneExitFsWatcher ||
    !row.tmuxServerId ||
    !paneExitEventReady.has(row.tmuxServerId)
  ) {
    return false
  }
  const server = getTmuxServer(row.tmuxServerId)
  if (!server || server.kind !== 'managed' || server.phase !== 'active') return false
  try {
    const installed = execFileSync(TMUX_BIN, showPaneExitedHookTargetArgs(server.socketPath), {
      encoding: 'utf8',
      env: terminalClientEnv(),
      timeout: TMUX_QUERY_TIMEOUT_MS,
    }).trim()
    if (installed === paneExitedHookCommand(server.id)) return true
  } catch (error) {
    console.error(
      `[tether:lifecycle] could not verify pane-exit hook for server=${server.id}:`,
      error,
    )
  }
  paneExitEventReady.delete(server.id)
  console.error(
    `[tether:lifecycle] pane-exit hook changed for server=${server.id}; new launches are blocked`,
  )
  return false
}

/** Persist the exact pane scope only after successful gated-pane creation. The
 * caller supplies its pre-launch ownership snapshot so a stale completion can
 * never overwrite a newer cleanup generation. */
async function recordManagedPane(
  widgetId: string,
  expected: WidgetOwnershipGeneration,
): Promise<ManagedPaneProcess | null> {
  const row = getWidget(widgetId)
  if (!row) return null
  const pane = await waitForCurrentPaneScope(widgetId)
  const scopeUnit = pane?.scopeUnit ?? null
  const identity = scopeUnit ? await scopeIdentity(scopeUnit) : null
  const launchIntent = pane ? managedGateLaunchIntent(pane.pid) : null
  const uid = process.getuid?.() ?? -1
  const owned = Boolean(
    pane &&
      scopeUnit &&
      identity?.activeState === 'active' &&
      isOwnedPaneControlGroup(scopeUnit, identity.controlGroup, uid) &&
      isSystemdInvocationId(identity.invocationId) &&
      processInControlGroup(pane.pid, identity.controlGroup) &&
      managedPaneMarkersMatch(row, pane.pid) &&
      launchIntent,
  )
  if (!owned || !pane || !scopeUnit || !identity || !launchIntent) return null
  const launchNonce = randomBytes(16).toString('hex')
  const promoted = compareAndSetWidgetOwnership(widgetId, expected, {
    ...expected,
    scopeUnit,
    scopeInvocationId: identity.invocationId,
    lifecycleVersion: MANAGED_LIFECYCLE_VERSION,
    tmuxSessionId: pane.tmuxSessionId,
    paneId: pane.paneId,
    launchState: 'gated',
    launchNonce,
  })
  if (!promoted) {
    console.error(`[tether:lifecycle] refusing stale ownership promotion for ${widgetId}`)
    return null
  }
  console.log(
    `[tether:lifecycle] session=${row.sessionId} widget=${widgetId} ` +
      `project=${launchIntent.projectId ?? 'unbound'} tool=${launchIntent.tool.slug} ` +
      `tmux_session=${pane.tmuxSessionId} pane=${pane.paneId} ` +
      `scope=${scopeUnit} invocation=${identity.invocationId} ` +
      `lifecycle=${MANAGED_LIFECYCLE_VERSION}`,
  )
  logWidgetEvent(widgetId, 'lifecycle_scope_owned', {
    session_id: row.sessionId,
    project_id: launchIntent.projectId,
    agent_slug: launchIntent.tool.slug,
    tmux_session_id: pane.tmuxSessionId,
    pane_id: pane.paneId,
    scope_unit: scopeUnit,
    scope_invocation_id: identity.invocationId,
    lifecycle_version: MANAGED_LIFECYCLE_VERSION,
    launch_nonce: launchNonce,
  })
  return pane
}

export async function verifiedCurrentManagedPane(
  row: WidgetRow,
): Promise<ManagedPaneProcess | null> {
  if (
    row.lifecycleVersion < MANAGED_LIFECYCLE_VERSION ||
    !row.scopeUnit ||
    !row.scopeInvocationId ||
    !row.tmuxSessionId ||
    !row.paneId
  ) {
    return null
  }
  const pane = currentPaneProcess(row.id)
  if (
    !pane ||
    pane.scopeUnit !== row.scopeUnit ||
    pane.tmuxSessionId !== row.tmuxSessionId ||
    pane.paneId !== row.paneId ||
    !managedPaneMarkersMatch(row, pane.pid)
  ) {
    return null
  }
  const identity = await scopeIdentity(row.scopeUnit)
  const uid = process.getuid?.() ?? -1
  if (
    !identity ||
    identity.activeState !== 'active' ||
    identity.invocationId !== row.scopeInvocationId ||
    !isOwnedPaneControlGroup(row.scopeUnit, identity.controlGroup, uid) ||
    !processInControlGroup(pane.pid, identity.controlGroup)
  ) {
    return null
  }
  return pane
}

/** Drain only a former scope after proving the catalog's current pane/scope is
 * exact and distinct. An identical current/pending tuple is cleared only when
 * the pre-respawn workload is still active. A gate in that tuple could instead
 * be a same-cgroup respawn with surviving descendants, so it fails closed. */
async function reconcileSupersededPendingScope(row: WidgetRow): Promise<boolean> {
  if (!row.pendingScopeUnit) return true
  const current = getWidget(row.id)
  if (!current?.pendingScopeUnit) return true
  const live = await verifiedCurrentManagedPane(current)
  if (!live || !current.scopeUnit || !current.scopeInvocationId) return false

  if (current.pendingScopeUnit === current.scopeUnit) {
    if (current.pendingScopeInvocationId !== current.scopeInvocationId) return false
    const identity = await scopeIdentity(current.scopeUnit)
    if (!identity || !mayClearMatchingPendingScope(managedGateState(live, identity.controlGroup))) {
      return false
    }
    return clearWidgetPendingScope(
      current.id,
      current.pendingScopeUnit,
      current.pendingScopeInvocationId,
    )
  }

  const clean = await stopOwnedPaneScope(
    current.pendingScopeUnit,
    current.pendingScopeInvocationId,
    `superseded generation ${current.sessionId}`,
  )
  return Boolean(
    clean &&
      clearWidgetPendingScope(
        current.id,
        current.pendingScopeUnit,
        current.pendingScopeInvocationId,
      ),
  )
}

function managedGateState(pane: ManagedPaneProcess, controlGroup: string): ManagedGateState {
  try {
    const isGate = isExactLaunchGateProcess(pane.pid)
    if (isGate === null) return 'ambiguous'
    if (!isGate) return 'active-workload'
    const processIds = cgroupProcessIds(controlGroup)
    return processIds?.length === 1 && processIds[0] === pane.pid ? 'inert' : 'ambiguous'
  } catch {
    return 'ambiguous'
  }
}

/** `deferred`: host admission refused the agent for now; the pane stays at its
 * inert gate and a later attach retries. Not an ownership problem. */
type ManagedPaneRecovery = 'recovered' | 'legacy' | 'blocked' | 'blocked-replay' | 'deferred'

/** Recover a crash between gated pane creation, DB promotion, and the one-time
 * launcher send. Exact AICO markers distinguish a managed gate from historical
 * user work; cgroup singleton state prevents replaying a launcher that may have
 * already run. */
async function recoverInterruptedManagedPane(
  row: WidgetRow,
  options: { dispatchGate?: boolean } = {},
): Promise<ManagedPaneRecovery> {
  const observed = currentPaneProcess(row.id)
  if (!observed) return row.lifecycleVersion === 0 ? 'legacy' : 'blocked'
  if (!managedPaneMarkersMatch(row, observed.pid)) {
    return row.lifecycleVersion === 0 ? 'legacy' : 'blocked'
  }

  let current = row
  let pane = observed
  if (
    current.lifecycleVersion < MANAGED_LIFECYCLE_VERSION ||
    current.scopeUnit !== pane.scopeUnit ||
    current.tmuxSessionId !== pane.tmuxSessionId ||
    current.paneId !== pane.paneId
  ) {
    const promoted = await recordManagedPane(row.id, ownershipGeneration(current))
    if (!promoted) return 'blocked'
    pane = promoted
    const latest = getWidget(row.id)
    if (!latest) return 'blocked'
    current = latest
  }

  let verified = await verifiedCurrentManagedPane(current)
  if (!verified || !current.scopeUnit) return 'blocked'
  let identity = await scopeIdentity(current.scopeUnit)
  if (!identity) return 'blocked'

  let gateState = managedGateState(verified, identity.controlGroup)
  let decision = decideManagedGateRecovery({
    gateState,
    launchState: current.launchState,
    pendingMatchesCurrent: Boolean(
      current.pendingScopeUnit &&
        current.pendingScopeUnit === current.scopeUnit &&
        current.pendingScopeInvocationId === current.scopeInvocationId,
    ),
    dispatchGate: options.dispatchGate !== false,
  })
  if (decision === 'blocked' || decision === 'blocked-replay') {
    if (decision === 'blocked-replay' && options.dispatchGate !== false) {
      console.error(
        `[tether:lifecycle] preserving non-replayable gate for ${current.sessionId}; ` +
          'the prior launcher outcome or cgroup generation is unknowable',
      )
    }
    return decision
  }
  if (decision === 'dispatch') {
    // A distinct former generation must be drained before advancing the new
    // gate, otherwise restart recovery could briefly run two workloads.
    if (current.pendingScopeUnit) {
      if (!(await reconcileSupersededPendingScope(current))) return 'blocked'
      const latest = getWidget(current.id)
      if (!latest) return 'blocked'
      current = latest
      const reverified = await verifiedCurrentManagedPane(current)
      if (!reverified || !current.scopeUnit) return 'blocked'
      const reverifiedIdentity = await scopeIdentity(current.scopeUnit)
      if (!reverifiedIdentity || reverified.pid !== verified.pid) return 'blocked'
      verified = reverified
      identity = reverifiedIdentity
      gateState = managedGateState(verified, identity.controlGroup)
      decision = decideManagedGateRecovery({
        gateState,
        launchState: current.launchState,
        pendingMatchesCurrent: false,
        dispatchGate: options.dispatchGate !== false,
      })
      if (decision !== 'dispatch') return decision
    }
    // Admission precedes dispatch only; a recovery that reattaches never reaches here.
    let admission: AdmissionTicket | undefined
    if ((getTui(current.tool ?? 'shell')?.slug ?? 'shell') !== 'shell') {
      try {
        admission = await reserveAgentLaunch({ widgetId: current.id, kind: 'recovery' })
      } catch {
        return 'deferred'
      }
    }
    try {
      const intentRow = persistManagedGateLaunchIntent(current, verified.pid)
      if (!intentRow) return 'blocked'
      const dispatchedRow = markManagedGateDispatched(intentRow)
      if (!dispatchedRow) return 'blocked'
      current = dispatchedRow
      const tool = getTui(current.tool ?? 'shell')
      const line = tool ? initialLaunchLine(current.id, tool) : null
      // Re-observe immediately before the one-time transition out of the gate.
      const immediatelyCurrent = await verifiedCurrentManagedPane(current)
      if (
        !immediatelyCurrent ||
        immediatelyCurrent.pid !== verified.pid ||
        managedGateState(immediatelyCurrent, identity.controlGroup) !== 'inert' ||
        !isPaneExitBridgeReady(current)
      ) {
        return 'blocked'
      }
      execFileSync(
        TMUX_BIN,
        runInPaneTargetArgs(
          tmuxPaneTargetForWidget(row.id),
          paneCommand(line, supervisorExitDir()),
        ),
        {
          env: terminalClientEnv(),
          timeout: TMUX_QUERY_TIMEOUT_MS,
        },
      )
      admission?.commit(current.scopeUnit)
      console.log(
        `[tether:lifecycle] resumed verified launch gate for session=${current.sessionId}`,
      )
      if (tool && line) reportContext(row.id, tool)
    } finally {
      admission?.release()
    }
  }
  if (decision === 'recovered' && current.pendingScopeUnit) {
    // Reattach is a concrete recovery trigger for a former generation whose
    // post-replacement cleanup was interrupted. Preserve attachment even if
    // cleanup remains unprovable, but do not leave the old tree unnoticed.
    if (!(await reconcileSupersededPendingScope(current))) {
      console.warn(
        `[tether:lifecycle] attachment preserved with unresolved former scope ${current.pendingScopeUnit}`,
      )
    }
  }
  return 'recovered'
}

const SCOPE_RESOURCE_PROPERTIES = [
  'ActiveState',
  'ActiveEnterTimestampMonotonic',
  'ControlGroup',
  'CPUUsageNSec',
  'MemoryCurrent',
  'MemoryPeak',
  'MemorySwapCurrent',
  'MemorySwapPeak',
  'TasksCurrent',
] as const

async function accountedScopeResources(
  scopeUnit: string,
): Promise<(ReturnType<typeof parseScopeResources> & { processCount: number | null }) | null> {
  try {
    const { stdout } = await execFileAsync(
      SYSTEMCTL_BIN,
      [
        '--user',
        'show',
        scopeUnit,
        '--no-pager',
        ...SCOPE_RESOURCE_PROPERTIES.map((property) => `--property=${property}`),
      ],
      { timeout: SYSTEMD_QUERY_TIMEOUT_MS },
    )
    const resources = parseScopeResources(stdout, uptime())
    const processIds = resources.controlGroup ? cgroupProcessIds(resources.controlGroup) : null
    return { ...resources, processCount: processIds?.length ?? null }
  } catch {
    return null
  }
}

export async function sessionDiagnostics(widgetId: string): Promise<Record<string, unknown>> {
  const row = getWidget(widgetId)
  if (!row) return { capturedAt: new Date().toISOString(), error: 'session not found' }
  retryUnresolvedPaneExitReconciliation(row.tmuxServerId)
  const target = tmuxTargetForWidget(widgetId)
  const sessionState: InternalSessionState = await internalSessionState(widgetId)
  const exists = sessionState === 'present'
  let pane: { pid: number | null; command: string; cwd: string; paneCount: number } = {
    pid: null,
    command: '',
    cwd: '',
    paneCount: 0,
  }
  if (exists) {
    try {
      const { stdout } = await execFileAsync(TMUX_BIN, listSessionPaneDetailsTargetArgs(target), {
        env: terminalClientEnv(),
        timeout: TMUX_QUERY_TIMEOUT_MS,
      })
      const rows = stdout.split('\n').filter(Boolean)
      const [_paneId, pid, command, cwd] = rows[0]?.split('\t') ?? []
      pane = {
        pid: Number(pid) || null,
        command: command ?? '',
        cwd: cwd ?? '',
        paneCount: rows.length,
      }
    } catch {
      // The session can disappear between the existence check and inspection.
    }
  }

  const resources = isOwnedPaneScope(row.scopeUnit)
    ? await accountedScopeResources(row.scopeUnit)
    : null
  const pendingResources = isOwnedPaneScope(row.pendingScopeUnit)
    ? await accountedScopeResources(row.pendingScopeUnit)
    : null

  const warnings: string[] = []
  if (!durableUserManager) {
    warnings.push(
      'User linger is disabled or unverified; new durable sessions are blocked because logout could destroy them.',
    )
  }
  if (sessionState === 'unknown') {
    warnings.push('tmux state is unknown; Tether will preserve the workload and refuse cleanup.')
  }
  const server = row.tmuxServerId ? getTmuxServer(row.tmuxServerId) : undefined
  const serverRuntimeState = server
    ? (tmuxServerRuntimeStates.get(server.id) ?? (server.phase === 'dead' ? 'dead' : 'ambiguous'))
    : null
  const serverResources =
    server && ownsServerRow(server) ? await accountedScopeResources(server.scopeUnit) : null
  if (serverRuntimeState === 'live-unreachable') {
    warnings.push(
      'The exact tmux server process is alive but its socket is unreachable; no replacement or cleanup is allowed.',
    )
  } else if (serverRuntimeState === 'socket-collision') {
    warnings.push(
      'The persisted tmux socket answered as a different server; all mutations are blocked.',
    )
  } else if (serverRuntimeState === 'ambiguous' && server) {
    warnings.push('The tmux server generation identity is ambiguous; all mutations are blocked.')
  }
  if (
    server?.kind === 'managed' &&
    server.phase === 'active' &&
    serverRuntimeState === 'reachable' &&
    !paneExitEventReady.has(server.id)
  ) {
    warnings.push(
      'Detached pane-exit monitoring is unavailable for this server; restart Tether before leaving work unattended.',
    )
  }
  if (row.lifecycleVersion < MANAGED_LIFECYCLE_VERSION) {
    warnings.push(
      'Legacy containment is preserved read-only. Create a new managed session and move work deliberately; retirement stays blocked because historical descendants are unattributable.',
    )
  } else if (!row.scopeUnit) {
    warnings.push('Managed session has no narrow pane scope; whole-tree cleanup is unavailable.')
  }
  if (row.pendingScopeUnit) {
    warnings.push(`Former scope ${row.pendingScopeUnit} is still pending verified cleanup.`)
  }
  if (row.launchState === 'dispatched' && pane.pid !== null && isExactLaunchGateProcess(pane.pid)) {
    warnings.push(
      'A launch was dispatched but the pane still resembles its gate; Tether will not auto-replay it. Inspect before retrying manually.',
    )
  }
  if (pane.paneCount > 1) {
    warnings.push(
      `This managed session has ${pane.paneCount} panes; destructive lifecycle actions are blocked.`,
    )
  }
  if (!exists && resources?.activeState === 'active') {
    warnings.push(
      'Owned scope is active without its tmux session; startup reconciliation is pending.',
    )
  }
  if (resources?.swapCurrent && resources.swapCurrent > 0) {
    warnings.push(
      'This session is consuming swap; inspect its processes before host pressure grows.',
    )
  }
  const averageCores =
    resources?.cpuUsageNSec != null && resources.ageSeconds && resources.ageSeconds >= 300
      ? resources.cpuUsageNSec / 1_000_000_000 / resources.ageSeconds
      : null
  if (averageCores !== null && averageCores >= 0.9) {
    warnings.push('Lifetime CPU use averages at least 90% of one core; check for a stuck workload.')
  }
  const admission = agentAdmissionReasons.get(row.id)
  if (admission) warnings.push(admission)

  return {
    capturedAt: new Date().toISOString(),
    ownership: {
      owner: 'aico',
      workloadClass: 'durable-session',
      widgetId: row.id,
      sessionId: row.sessionId,
      agentSlug: row.tool,
      agentSessionId: null,
      projectId: row.projectId,
      projectRoot: row.projectRoot,
      lifecycleVersion: row.lifecycleVersion,
      scopeUnit: row.scopeUnit,
      scopeInvocationId: row.scopeInvocationId,
      pendingScopeUnit: row.pendingScopeUnit,
      pendingScopeInvocationId: row.pendingScopeInvocationId,
      tmuxAllocationState: row.tmuxAllocationState,
      tmuxServerId: row.tmuxServerId,
      tmuxSessionId: row.tmuxSessionId,
      paneId: row.paneId,
      launchState: row.launchState,
      launchNonce: row.launchNonce,
    },
    tmux: {
      socket: target.socket,
      session: target.session,
      state: sessionState,
      exists,
      server: server
        ? {
            id: server.id,
            kind: server.kind,
            phase: server.phase,
            runtimeState: serverRuntimeState,
            pid: server.serverPid,
            scopeUnit: server.scopeUnit,
            invocationId: server.invocationId,
          }
        : null,
      ...pane,
    },
    resources: resources ? { ...resources, averageCores } : null,
    pendingResources,
    serverResources,
    warnings,
  }
}

// The directory a session's pane spawns in: the project root cached on its
// row (resolved once at create/switch time, so no provider call runs on the
// create/respawn path). A vanished root falls back to $HOME so a stale binding
// never strands the pane. (Aico's unbound fallback was the global `st` active
// project; Tether has no global active project.)
export function cwdForWidget(widgetId: string): string {
  const row = getWidget(widgetId)
  const root = row?.projectRoot
  if (root && isDir(root)) return root
  return cfg().env.HOME ?? homedir()
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// Detect the TUI actually running in a session's pane from its live process
// tree. Best-effort — any failure resolves to undefined.
async function liveTuiForWidget(widgetId: string): Promise<TuiSpec | undefined> {
  try {
    const { stdout: pidOut } = await execFileAsync(
      TMUX_BIN,
      panePidTargetArgs(tmuxPaneTargetForWidget(widgetId)),
      { env: terminalClientEnv(), timeout: TMUX_QUERY_TIMEOUT_MS },
    )
    const rootPid = Number(pidOut.trim())
    if (!Number.isFinite(rootPid) || rootPid <= 0) return undefined
    const { stdout: psOut } = await execFileAsync(PS_BIN, ['-eo', 'pid=,ppid=,comm='], {
      timeout: TMUX_QUERY_TIMEOUT_MS,
    })
    const names = processTreeNames(parseProcessTable(psOut), rootPid)
    return detectTuiFromProcessNames(listTuis(), names)
  } catch {
    return undefined
  }
}

// If the user exits one TUI manually and starts another inside the shell, tmux
// keeps the same session but the stored `tool` slug can go stale. Use the live
// process tree to repair the metadata on attach. Resolves true when it changed.
export async function reconcileWidgetTool(widgetId: string): Promise<boolean> {
  const row = getWidget(widgetId)
  if (!row) return false
  const live = await liveTuiForWidget(widgetId)
  if (!live || live.slug === row.tool) return false
  setWidgetTool(widgetId, live.slug)
  console.log(`[tether] reconciled ${widgetId} TUI metadata: ${row.tool} -> ${live.slug}`)
  publishSession(widgetId)
  return true
}

/** Why the last ensure for a session did not launch (API error mapping). */
export type EnsureFailure =
  | { code: 'admission_denied'; reason: string }
  | { code: 'linger_required'; reason: string }
  | { code: 'workload_unavailable'; reason: string }
  | { code: 'outcome_uncertain'; reason: string }
const ensureFailures = new Map<string, EnsureFailure>()

function fail(widgetId: string, failure: EnsureFailure): false {
  ensureFailures.set(widgetId, failure)
  return false
}

export function lastEnsureFailure(widgetId: string): EnsureFailure | undefined {
  return ensureFailures.get(widgetId)
}

// Ensure the session's tmux session exists, launching its TUI exactly once on
// first create. Reattaching finds the session already running and sends
// nothing — so a live agent is never relaunched.
async function ensureOwnedInternalSession(widgetId: string, size: PtySize): Promise<boolean> {
  ensureFailures.delete(widgetId)
  const rowBeforeCreate = getWidget(widgetId)
  if (!rowBeforeCreate) {
    return fail(widgetId, { code: 'workload_unavailable', reason: 'session not found' })
  }
  retryUnresolvedPaneExitReconciliation(rowBeforeCreate.tmuxServerId)
  const state = await internalSessionState(widgetId)
  if (state === 'present') {
    const recovery = await recoverInterruptedManagedPane(rowBeforeCreate)
    if (recovery === 'deferred') {
      console.warn(
        `[tether:lifecycle] ${widgetId} agent launch deferred by host admission; attaching its inert gate`,
      )
    } else if (recovery === 'blocked' || recovery === 'blocked-replay') {
      console.warn(
        `[tether:lifecycle] attaching ${widgetId} read/write without lifecycle authority: ` +
          (recovery === 'blocked-replay'
            ? 'an interrupted gate is preserved without replay; explicitly replace it to continue'
            : 'managed pane identity is ambiguous; replace/retire/replay remain blocked'),
      )
      const latest = getWidget(widgetId)
      if (latest?.pendingScopeUnit && !(await reconcileSupersededPendingScope(latest))) {
        console.warn(`[tether:lifecycle] pending cleanup remains blocked for ${latest.sessionId}`)
      }
    }
    return true // legacy reattach or exact managed recovery; never replay live work
  }
  if (state === 'unknown') {
    console.error(
      `[tether:lifecycle] tmux state unknown for ${widgetId}; refusing duplicate launch`,
    )
    return fail(widgetId, { code: 'workload_unavailable', reason: 'tmux state is unknown' })
  }
  if (!isNeverAllocatedWidget(rowBeforeCreate)) {
    console.error(
      `[tether:lifecycle] ${rowBeforeCreate.sessionId} was previously allocated but its tmux session is absent; refusing implicit relaunch`,
    )
    return fail(widgetId, {
      code: 'workload_unavailable',
      reason: 'previously allocated session is absent; it is never implicitly relaunched',
    })
  }
  if (!rootPromptReady(widgetId)) {
    return fail(widgetId, { code: 'workload_unavailable', reason: 'root prompt is not available' })
  }
  // A session crash recovery owns starts only with its resume prompt, so an
  // attach in the meantime cannot launch a fresh agent in its place.
  if (launchGuard?.(widgetId) && !hasLaunchPrompt(widgetId)) {
    return fail(widgetId, {
      code: 'workload_unavailable',
      reason: 'crash recovery will resume this session',
    })
  }
  if (!durableUserManager) {
    console.error(
      '[tether:lifecycle] user linger is not enabled; refusing a session that would die on logout',
    )
    return fail(widgetId, { code: 'linger_required', reason: 'user linger is not enabled' })
  }
  const cwd = cwdForWidget(widgetId)
  // Lifecycle ordering is deliberate: create a bare pane first, let tmux move it
  // into its dedicated cgroup, then launch the TUI through that contained shell.
  // Embedding the TUI in new-session lets it fork before tmux's asynchronous
  // cgroup move and was the path that put every tool in app-aico-9189.scope.
  const tool = getTui(rowBeforeCreate.tool ?? 'shell')
  const line = tool ? initialLaunchLine(widgetId, tool) : null
  if (hasPersistedScopeCleanupEvidence(rowBeforeCreate)) {
    console.error(
      `[tether:lifecycle] refusing to recreate absent ${widgetId}: persisted scope cleanup is unresolved`,
    )
    return fail(widgetId, {
      code: 'workload_unavailable',
      reason: 'persisted scope cleanup is unresolved',
    })
  }
  // Admission precedes tmux allocation, so a deferred agent leaves nothing behind.
  let admission: AdmissionTicket | undefined
  if ((tool?.slug ?? 'shell') !== 'shell') {
    try {
      admission = await reserveAgentLaunch({ widgetId, kind: 'launch' })
    } catch {
      return fail(widgetId, {
        code: 'admission_denied',
        reason: agentAdmissionReasons.get(widgetId) ?? 'host admission deferred the launch',
      })
    }
  }
  try {
    await createInternalSession(
      widgetId,
      size,
      cwd,
      managedEnvironment(widgetId, tool?.slug ?? 'shell'),
    )
    const allocatedRow = getWidget(widgetId)
    if (!allocatedRow?.tmuxServerId || allocatedRow.tmuxAllocationState !== 'bound') {
      throw new Error('tmux server generation was not durably bound before pane promotion')
    }
    const pane = await recordManagedPane(widgetId, ownershipGeneration(allocatedRow))
    if (!pane) {
      // Preserve the inert gate session. A timeout or crash can occur after
      // tmux has created a valid scope; killing before its identity is durable
      // would erase the only route to its descendants. Startup recovery can
      // promote a gate carrying this session's exact ownership markers.
      throw new Error(
        'tmux did not place the new pane in a narrow systemd scope; workload launch refused',
      )
    }
    const gateRow = getWidget(widgetId)
    const gateIdentity = pane.scopeUnit ? await scopeIdentity(pane.scopeUnit) : null
    const verifiedGate = gateRow ? await verifiedCurrentManagedPane(gateRow) : null
    if (
      !gateRow ||
      !gateIdentity ||
      !verifiedGate ||
      verifiedGate.pid !== pane.pid ||
      managedGateState(verifiedGate, gateIdentity.controlGroup) !== 'inert'
    ) {
      throw new Error('new session gate changed before launch')
    }
    const intentRow = persistManagedGateLaunchIntent(gateRow, pane.pid)
    const dispatchedRow = intentRow ? markManagedGateDispatched(intentRow) : null
    if (!dispatchedRow) throw new Error('new session gate dispatch could not be persisted')
    const immediatelyCurrent = await verifiedCurrentManagedPane(dispatchedRow)
    if (
      !immediatelyCurrent ||
      immediatelyCurrent.pid !== pane.pid ||
      managedGateState(immediatelyCurrent, gateIdentity.controlGroup) !== 'inert' ||
      !isPaneExitBridgeReady(dispatchedRow)
    ) {
      throw new Error('new session gate changed after dispatch persistence')
    }
    execFileSync(
      TMUX_BIN,
      runInPaneTargetArgs(
        tmuxPaneTargetForWidget(widgetId),
        paneCommand(line, supervisorExitDir()),
      ),
      {
        env: terminalClientEnv(),
        timeout: TMUX_QUERY_TIMEOUT_MS,
      },
    )
    admission?.commit(pane.scopeUnit)
  } catch (e) {
    console.error(`[tether] failed to create tmux session for ${widgetId}:`, e)
    return fail(widgetId, {
      code: 'outcome_uncertain',
      reason: e instanceof Error ? e.message : String(e),
    })
  } finally {
    admission?.release()
  }
  // Best-effort observability only: context failure is visible but never
  // prevents the native TUI from launching.
  if (tool && line) reportContext(widgetId, tool)
  return true
}

async function ensureSession(widgetId: string, size: PtySize): Promise<boolean> {
  // Presence checks can recover and launch an interrupted gate, so even an
  // apparent reattach is a lifecycle mutation. Hold the same per-session token
  // used by replace/retire for the entire decision and recovery sequence.
  const lifecycleOwner = await lifecycleOwners.acquireWhenAvailable(widgetId)
  const knownServerId = getWidget(widgetId)?.tmuxServerId
  try {
    return await ensureOwnedInternalSession(widgetId, size)
  } finally {
    // Reconciliation may deliberately clear a dead/historical server binding.
    // Retain the acquired generation so a pane-exit event deferred behind this
    // owner is queued after release rather than stranded by the successful CAS.
    releaseLifecycleOwner(widgetId, lifecycleOwner, knownServerId)
    publishSession(widgetId)
  }
}

export function ensureSessionSerialized(widgetId: string, size: PtySize): Promise<boolean> {
  const current = sessionStartPromises.get(widgetId)
  if (current) return current
  const started = ensureSession(widgetId, size).finally(() => {
    if (sessionStartPromises.get(widgetId) === started) sessionStartPromises.delete(widgetId)
  })
  sessionStartPromises.set(widgetId, started)
  return started
}

// Latest best-effort TUI context state per session. Missing state is visible
// degradation, never authority to block the native model launch.
export type ContextHookStatus = ContextStatus & {
  slug: string
  applicable: boolean
  checkedAt: number
}

const contextStatuses = new Map<string, ContextHookStatus>()

export function contextStatus(widgetId: string): ContextHookStatus | null {
  return contextStatuses.get(widgetId) ?? null
}

function publishContextStatus(widgetId: string, tool: TuiSpec, status: ContextStatus): void {
  console.log(`[tether] ${tool.slug} context ${status.state}: ${status.detail}`)
  const previous = contextStatuses.get(widgetId)
  contextStatuses.set(widgetId, {
    slug: tool.slug,
    state: status.state,
    detail: status.detail,
    applicable: tool.command.length > 0,
    checkedAt: Date.now(),
  })
  // The generation does not change, so announce the new status explicitly.
  const changed =
    !previous ||
    previous.slug !== tool.slug ||
    previous.state !== status.state ||
    previous.detail !== status.detail
  publishSession(widgetId, { force: changed })
}

// Independently probe a TUI's source chain and live delivery availability. This
// does not claim what an already-running native session received. The native
// model always continues. It never gates launch.
export function probeContext(widgetId: string, tool: TuiSpec): Promise<void> {
  return ensureContext(tool, {
    cwd: cwdForWidget(widgetId),
    session: getWidget(widgetId)?.sessionId,
  })
    .then((status) => publishContextStatus(widgetId, tool, status))
    .catch((error) =>
      publishContextStatus(widgetId, tool, {
        state: 'missing',
        detail: `post-launch context verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    )
}

function reportContext(widgetId: string, tool: TuiSpec): void {
  void probeContext(widgetId, tool)
}

/** Re-probe every running session's context hook, one at a time, so a daemon
 * restart reports the same badge Aico used to compute on window load. */
async function probeRunningContexts(): Promise<void> {
  for (const row of listWidgets()) {
    if (quitting) return
    if (cachedSessionStatus(row) !== 'running') continue
    const tool = getTui(row.tool)
    if (tool) await probeContext(row.id, tool)
  }
}

/** Result of an explicit replacement (respawn, load-tui, switch-project). */
export type RespawnResult =
  | { status: 'replaced' }
  | { status: 'not_found' }
  | { status: 'busy' }
  | { status: 'stale' }
  | { status: 'legacy_session' }
  | { status: 'workload_unavailable'; reason: string }
  | { status: 'admission_denied'; reason: string }
  | { status: 'blocked'; reason: string }
  | { status: 'outcome_uncertain'; reason: string }

// Respawn a live session's pane (kills the current foreground program, fresh
// shell in the session's current cwd) and relaunch `tool` in it. One pane = one
// foreground program, so load-tui and switch-project both go through here.
// Metadata changes are committed only after the new contained pane and its TUI
// launch both succeed, so catalog state never claims a replacement that failed
// partway through.
export async function respawnAndRelaunch(
  widgetId: string,
  tool: TuiSpec | undefined,
  options: {
    cwd?: string
    projectId?: string | null
    commitMetadata?: () => void
    /** Launch with the session's root prompt and resume ID (crash recovery). */
    initialLaunch?: boolean
    /** Tether: the generation the caller read; checked under the lock. */
    expectedGeneration?: string
    generationOf?: (row: WidgetRow) => string
  } = {},
): Promise<RespawnResult> {
  const lifecycleOwner = lifecycleOwners.acquire(widgetId)
  if (!lifecycleOwner) {
    console.warn(`[tether:lifecycle] ${widgetId} already has a lifecycle operation in progress`)
    return { status: 'busy' }
  }
  try {
    let previous = getWidget(widgetId)
    if (!previous) return { status: 'not_found' }
    if (
      options.expectedGeneration !== undefined &&
      options.generationOf?.(previous) !== options.expectedGeneration
    ) {
      return { status: 'stale' }
    }
    if (previous.lifecycleVersion < MANAGED_LIFECYCLE_VERSION) return { status: 'legacy_session' }
    const initialState = await internalSessionState(widgetId)
    if (initialState !== 'present') {
      console.error(
        `[tether:lifecycle] replacement blocked: tmux session state is ${initialState}; ` +
          'no persisted generation will be overwritten',
      )
      return {
        status: 'workload_unavailable',
        reason: `tmux session state is ${initialState}`,
      }
    }

    // An explicit replacement supersedes an interrupted gate; it must inspect
    // that gate but never replay the previously requested launcher first.
    const recovery = await recoverInterruptedManagedPane(previous, { dispatchGate: false })
    previous = getWidget(widgetId)
    if (!previous) return { status: 'not_found' }
    // `deferred` cannot arise without dispatch; treat it as blocked regardless.
    if (recovery === 'blocked' || recovery === 'deferred') {
      if (previous.pendingScopeUnit) await reconcileSupersededPendingScope(previous)
      console.error(
        `[tether:lifecycle] replacement blocked: interrupted launch state for ${previous.sessionId} is ambiguous`,
      )
      return { status: 'blocked', reason: 'interrupted launch state is ambiguous' }
    }
    if (recovery === 'legacy') return { status: 'legacy_session' }

    let previousWasInertGate = false
    if (recovery === 'blocked-replay') {
      if (
        previous.pendingScopeUnit === previous.scopeUnit &&
        previous.pendingScopeInvocationId === previous.scopeInvocationId
      ) {
        console.error(
          `[tether:lifecycle] replacement blocked: ${previous.sessionId} has an inert gate in an ` +
            'unresolved same-scope respawn generation; create a new managed session instead',
        )
        return {
          status: 'blocked',
          reason: 'inert gate in an unresolved same-scope respawn generation',
        }
      }
      const exactGate = await verifiedCurrentManagedPane(previous)
      const exactIdentity = previous.scopeUnit ? await scopeIdentity(previous.scopeUnit) : null
      previousWasInertGate = Boolean(
        exactGate &&
          exactIdentity &&
          managedGateState(exactGate, exactIdentity.controlGroup) === 'inert',
      )
      if (!previousWasInertGate) {
        console.error(
          `[tether:lifecycle] replacement blocked: interrupted gate for ${previous.sessionId} changed during verification`,
        )
        return { status: 'blocked', reason: 'interrupted gate changed during verification' }
      }
    }

    // A prior crash can leave the former generation pending. Drain it only
    // after recovery proved which exact scope is current; never create a third tree.
    if (previous.pendingScopeUnit) {
      if (!(await reconcileSupersededPendingScope(previous))) {
        console.error(
          `[tether:lifecycle] replacement blocked by unresolved pending scope ${previous.pendingScopeUnit}`,
        )
        return { status: 'blocked', reason: 'unresolved pending scope' }
      }
      previous = getWidget(widgetId)
      if (!previous) return { status: 'not_found' }
    }

    if (!(await verifiedCurrentManagedPane(previous))) {
      console.error(
        `[tether:lifecycle] replacement blocked: current pane ownership is not exact for ${previous.sessionId}`,
      )
      return { status: 'blocked', reason: 'current pane ownership is not exact' }
    }
    const previousScope = previous.scopeUnit
    const previousScopeInvocationId = previous.scopeInvocationId
    if (!previousScope || !previousScopeInvocationId) {
      return { status: 'blocked', reason: 'current scope identity is missing' }
    }

    // Admission precedes the destructive respawn. The scope being replaced is
    // excluded from the count, so a replacement never waits on itself.
    let admission: AdmissionTicket | undefined
    if ((tool?.slug ?? 'shell') !== 'shell') {
      try {
        admission = await reserveAgentLaunch({
          widgetId,
          kind: 'replacement',
          replacingScope: previousScope,
        })
      } catch {
        return {
          status: 'admission_denied',
          reason: agentAdmissionReasons.get(widgetId) ?? 'host admission deferred the launch',
        }
      }
    }

    let result: RespawnResult = { status: 'replaced' }
    try {
      if (
        !setWidgetPendingScope(
          widgetId,
          ownershipGeneration(previous),
          previousScope,
          previousScopeInvocationId,
        )
      ) {
        console.error(
          `[tether:lifecycle] replacement blocked: ownership changed before pending scope persistence`,
        )
        return { status: 'stale' }
      }
      const expected = getWidget(widgetId)
      if (!expected?.pendingScopeUnit) return { status: 'stale' }

      const line = tool
        ? options.initialLaunch
          ? initialLaunchLine(widgetId, tool)
          : launchLine(tool)
        : null
      let promoted: ManagedPaneProcess | null = null
      let sameScopeReplacementProven = false
      try {
        // The target is the persisted pane id, not the mutable active pane. The
        // replacement starts in the inert gate and cannot fork before promotion.
        execFileSync(
          TMUX_BIN,
          respawnTargetArgs(
            tmuxPaneTargetForWidget(widgetId),
            options.cwd ?? cwdForWidget(widgetId),
            managedEnvironment(widgetId, tool?.slug ?? 'shell', options.projectId),
          ),
          { env: terminalClientEnv(), timeout: TMUX_QUERY_TIMEOUT_MS },
        )
        promoted = await recordManagedPane(widgetId, ownershipGeneration(expected))
        if (!promoted?.scopeUnit) {
          throw new Error(
            'replacement gate could not be promoted; it is preserved for startup recovery',
          )
        }
        if (promoted.scopeUnit === previousScope && !previousWasInertGate) {
          throw new Error(`tmux reused pane scope ${promoted.scopeUnit}; replacement remains gated`)
        }

        const promotedRow = getWidget(widgetId)
        const promotedIdentity = promoted.scopeUnit ? await scopeIdentity(promoted.scopeUnit) : null
        const verifiedGate = promotedRow ? await verifiedCurrentManagedPane(promotedRow) : null
        if (
          !promotedRow ||
          !promotedIdentity ||
          !verifiedGate ||
          verifiedGate.pid !== promoted.pid ||
          managedGateState(verifiedGate, promotedIdentity.controlGroup) !== 'inert'
        ) {
          throw new Error('replacement gate received input or descendants before launch')
        }
        sameScopeReplacementProven = Boolean(
          promoted.scopeUnit === previousScope && previousWasInertGate,
        )
        const intentRow = persistManagedGateLaunchIntent(promotedRow, promoted.pid)
        if (!intentRow) {
          throw new Error('replacement gate launch intent could not be persisted before send')
        }
        const dispatchedRow = markManagedGateDispatched(intentRow)
        if (!dispatchedRow) {
          throw new Error('replacement gate dispatch generation changed before send')
        }

        const immediatelyCurrent = await verifiedCurrentManagedPane(dispatchedRow)
        if (
          !immediatelyCurrent ||
          immediatelyCurrent.pid !== promoted.pid ||
          managedGateState(immediatelyCurrent, promotedIdentity.controlGroup) !== 'inert' ||
          !isPaneExitBridgeReady(dispatchedRow)
        ) {
          throw new Error('replacement gate changed after launch intent persistence')
        }

        execFileSync(
          TMUX_BIN,
          runInPaneTargetArgs(
            tmuxPaneTargetForWidget(widgetId),
            paneCommand(line, supervisorExitDir()),
          ),
          { env: terminalClientEnv(), timeout: TMUX_QUERY_TIMEOUT_MS },
        )
        admission?.commit(promoted?.scopeUnit ?? null)
        options.commitMetadata?.()
        if (tool && line) reportContext(widgetId, tool)
      } catch (error) {
        // Never kill an unrecorded gate: its markers + tmux identity are the
        // recovery handle. The old exact scope remains pending until promotion.
        console.error(`[tether] failed to respawn pane for ${widgetId}:`, error)
        result = {
          status: 'outcome_uncertain',
          reason: error instanceof Error ? error.message : String(error),
        }
      }

      // Once the new exact scope is durable, the former scope is no longer the
      // live pane and can be emptied even if the TUI send itself failed.
      if (promoted?.scopeUnit && promoted.scopeUnit !== previousScope) {
        const clean = await stopOwnedPaneScope(
          previousScope,
          previousScopeInvocationId,
          `replace session ${previous.sessionId}`,
        )
        if (clean) clearWidgetPendingScope(widgetId, previousScope, previousScopeInvocationId)
      } else if (promoted?.scopeUnit === previousScope && sameScopeReplacementProven) {
        // The old generation was recursively proven to be a singleton gate, so
        // tmux's same-scope reuse could not retain a detached descendant. Clear
        // once the replacement gate is also proven singleton. Launch failure is
        // retained in launchState, but must not make explicit repair impossible.
        clearWidgetPendingScope(widgetId, previousScope, previousScopeInvocationId)
      }
      return result
    } finally {
      admission?.release()
    }
  } finally {
    releaseLifecycleOwner(widgetId, lifecycleOwner)
    publishSession(widgetId)
  }
}

/** Replace whatever runs in a live session's pane with `tool`. The stored tool
 * is updated so a later End + new session uses it. */
export function loadTui(
  widgetId: string,
  tool: TuiSpec,
  fence: { expectedGeneration: string; generationOf: (row: WidgetRow) => string },
): Promise<RespawnResult> {
  return respawnAndRelaunch(widgetId, tool, {
    ...fence,
    commitMetadata: () => setWidgetTool(widgetId, tool.slug),
  })
}

/** Move a live session to another project: respawn there with the SAME tool. */
export function switchProject(
  widgetId: string,
  projectId: string | null,
  root: string | null,
  fence: { expectedGeneration: string; generationOf: (row: WidgetRow) => string },
): Promise<RespawnResult> {
  if (!root)
    console.warn(`[tether] project ${projectId ?? '(none)'} root unresolved; using default cwd`)
  const cwd = root && isDir(root) ? root : (cfg().env.HOME ?? homedir())
  return respawnAndRelaunch(widgetId, getTui(getWidget(widgetId)?.tool ?? 'shell'), {
    ...fence,
    cwd,
    projectId,
    commitMetadata: () => setWidgetProject(widgetId, projectId, root),
  })
}

export async function rootManagedGateState(row: WidgetRow): Promise<ManagedGateState | null> {
  if ((await internalSessionState(row.id)) !== 'present') return null
  const pane = await verifiedCurrentManagedPane(row)
  const identity = row.scopeUnit ? await scopeIdentity(row.scopeUnit) : null
  return pane && identity ? managedGateState(pane, identity.controlGroup) : null
}

// --- retirement (Aico discardWidget / drainWidgetRetire / discardWidgetOwned) ---

export type EndResult = RetirementResult | { status: 'busy' }

const RETIRE_WAIT_MS = 5_000
const retireRequests = new Map<
  string,
  { generation: string | undefined; resolve: (result: EndResult) => void }
>()

/**
 * End one session. The intent is coalesced and has priority over watcher
 * reconciliation (Aico `discardWidget`); a caller waits at most RETIRE_WAIT_MS
 * for the lifecycle token and otherwise gets `busy` with nothing applied.
 */
export function endSession(widgetId: string, generation?: string): Promise<EndResult> {
  if (retireRequests.has(widgetId)) return Promise.resolve({ status: 'busy' })
  return new Promise<EndResult>((resolve) => {
    const request = {
      generation,
      resolve: (result: EndResult) => {
        clearTimeout(timer)
        resolve(result)
      },
    }
    const timer = setTimeout(() => {
      if (retireRequests.get(widgetId) === request) {
        retireRequests.delete(widgetId)
        resolve({ status: 'busy' })
      }
    }, RETIRE_WAIT_MS)
    retireRequests.set(widgetId, request)
    widgetRetireIntents.request(widgetId)
    drainWidgetRetire(widgetId)
  })
}

function drainWidgetRetire(id: string): void {
  const request = retireRequests.get(id)
  const lifecycleOwner = widgetRetireIntents.take(id, lifecycleOwners)
  if (!lifecycleOwner) return
  retireRequests.delete(id)
  if (!request) {
    // A timed-out request leaves its coalesced intent behind; consume it.
    widgetRetireIntents.complete(id)
    releaseLifecycleOwner(id, lifecycleOwner)
    return
  }
  void discardWidgetOwned(id, lifecycleOwner, request.generation)
    .then(request.resolve)
    .catch((error: unknown) => {
      // The owned path releases its token in finally, but an unexpected tmux,
      // systemd, or store exception must still be observed.
      console.error(`[tether:lifecycle] retirement failed widget=${id}:`, error)
      request.resolve({ status: 'blocked', reason: 'retirement failed unexpectedly' })
    })
}

/** Tether's retirement operations: the engine's own fresh verification. */
export const engineRetirementOperations: RetirementOperations = {
  async sessionState(widgetId: string): Promise<SessionState> {
    return internalSessionState(widgetId)
  },
  async verifiedCurrentPane(row: WidgetRow): Promise<boolean> {
    return Boolean(await verifiedCurrentManagedPane(row))
  },
  async stopTmuxSession(row: WidgetRow): Promise<void> {
    if (!(await verifiedCurrentManagedPane(row)) || !row.tmuxServerId || !row.tmuxSessionId) {
      throw new Error('managed pane identity changed before stop')
    }
    const server = getTmuxServer(row.tmuxServerId)
    if (!server) throw new Error('managed tmux server is unavailable')
    await execFileAsync(
      TMUX_BIN,
      killTargetArgs({ socket: server.socketPath, session: row.tmuxSessionId }),
      { env: terminalClientEnv(), timeout: TMUX_QUERY_TIMEOUT_MS },
    )
  },
  settleServer: settleServerAfterSessionStop,
}

async function discardWidgetOwned(
  id: string,
  lifecycleOwner: LifecycleOwnerToken,
  generation: string | undefined,
): Promise<RetirementResult> {
  const knownServerId = getWidget(id)?.tmuxServerId
  try {
    const row = getWidget(id)
    if (!row) return { status: 'absent' }
    const result = await retireOwnedSession(id, engineRetirementOperations, generation)
    if (result.status === 'ended') {
      logWidgetEvent(id, 'lifecycle_retired', {
        session_id: row.sessionId,
        scope_unit: row.scopeUnit,
        scope_invocation_id: row.scopeInvocationId,
      })
      statusCache.delete(id)
      contextStatuses.delete(id)
      ensureFailures.delete(id)
      publishSession(id, { ended: true })
    } else if (result.status === 'blocked') {
      console.error(`[tether:lifecycle] retaining ${row.sessionId}: ${result.reason}`)
    } else if (result.status === 'stale') {
      console.error(`[tether:lifecycle] retaining ${row.sessionId}: ownership generation changed`)
    }
    return result
  } finally {
    widgetRetireIntents.complete(id)
    releaseLifecycleOwner(id, lifecycleOwner, knownServerId)
  }
}

/** Remove a never-allocated row (create refused before allocation). */
export function discardNeverAllocated(widgetId: string): boolean {
  const row = getWidget(widgetId)
  if (!row || !isNeverAllocatedWidget(row)) return false
  return removeWidgetIfOwnership(widgetId, ownershipGeneration(row))
}

// --- startup reconciliation (Aico adoptOrphans / reconcileManagedWidget) ---

// Adopt any live `aico-*` tmux sessions not yet in the catalog as legacy rows,
// preserving their creation time.
function adoptOrphans(): void {
  for (const server of listTmuxServers()) {
    if (!ownsServerRow(server)) continue
    if (tmuxServerRuntimeStates.get(server.id) !== 'reachable') continue
    bindVerifiedServerRoster(server, tmuxServerRosters.get(server.id) ?? [])
  }
}

// Clean only a persisted, narrow scope whose managed tmux session is provably
// gone. Age, process name, CPU use, and detachment are never cleanup authority:
// durable user sessions remain valid indefinitely. Existing lifecycle-v0 rows
// are observed but never targeted because their descendants may live in a broad
// legacy scope shared with unrelated work.
async function reconcileManagedWidget(row: WidgetRow, useServerSnapshot = false): Promise<void> {
  const lifecycleOwner = lifecycleOwners.acquire(row.id)
  if (!lifecycleOwner) {
    if (row.tmuxServerId) paneExitQueue.defer(row.tmuxServerId)
    console.warn(`[tether:lifecycle] deferring reconciliation for busy session ${row.id}`)
    return
  }
  const knownServerId = getWidget(row.id)?.tmuxServerId ?? row.tmuxServerId
  try {
    let current = getWidget(row.id)
    if (!current) return
    if (current.tmuxServerId) {
      const server = getTmuxServer(current.tmuxServerId)
      // Tether: a session bound to another instance's server is never touched.
      if (server && !ownsServerRow(server)) return
      if (server?.phase === 'provisioning') {
        await recoverProvisioningTmuxServer(server, false)
      }
      current = getWidget(row.id) ?? current
    }
    let state = useServerSnapshot
      ? observedInternalSessionState(current)
      : await internalSessionState(current.id)
    // Snapshot absence is never destructive authority. Revalidate the exact
    // server tuple/socket immediately before any cleanup path.
    if (useServerSnapshot && state === 'absent') {
      state = await internalSessionState(current.id)
    }
    if (state === 'unknown') {
      console.warn(`[tether:lifecycle] preserving ${current.sessionId}: tmux state is unknown`)
      return
    }

    if (state === 'present') {
      const recovery = await recoverInterruptedManagedPane(current)
      if (recovery === 'deferred') {
        console.warn(
          `[tether:lifecycle] preserving ${current.sessionId}: agent launch deferred by host admission`,
        )
        return
      }
      if (recovery === 'blocked' || recovery === 'blocked-replay') {
        const latest = getWidget(current.id)
        if (latest?.pendingScopeUnit) await reconcileSupersededPendingScope(latest)
        console.warn(
          `[tether:lifecycle] preserving ${current.sessionId}: ` +
            (recovery === 'blocked-replay'
              ? 'interrupted launch gate will not be replayed'
              : 'live pane ownership is ambiguous'),
        )
        return
      }
      current = getWidget(current.id) ?? current
      if (recovery === 'legacy' && !current.pendingScopeUnit) return
    }

    if (current.lifecycleVersion < MANAGED_LIFECYCLE_VERSION) {
      const pending = current.pendingScopeUnit
      if (!pending) {
        const server = current.tmuxServerId ? getTmuxServer(current.tmuxServerId) : undefined
        if (
          state === 'absent' &&
          server?.phase === 'dead' &&
          !current.scopeUnit &&
          current.tmuxServerId
        ) {
          const cleared = compareAndSetWidgetOwnership(current.id, ownershipGeneration(current), {
            ...ownershipGeneration(current),
            tmuxSessionId: null,
            paneId: null,
          })
          if (cleared) clearReconciledDeadTmuxServerBinding(current.id, current.tmuxServerId)
        }
        return
      }
      if (state === 'present') {
        const observed = currentPaneScope(current.id)
        if (!observed) {
          console.warn(
            `[tether:lifecycle] preserving legacy pending ${pending}: live pane scope is unknown`,
          )
          return
        }
        if (observed === pending) {
          // Respawn failed before replacing the old pane; it is still current.
          clearWidgetPendingScope(current.id, pending, current.pendingScopeInvocationId)
          return
        }
      }
      const clean = await stopOwnedPaneScope(
        pending,
        current.pendingScopeInvocationId,
        `startup legacy pending cleanup ${current.sessionId}`,
      )
      if (clean) clearWidgetPendingScope(current.id, pending, current.pendingScopeInvocationId)
      return
    }

    if (state === 'present') {
      if (!(await verifiedCurrentManagedPane(current))) {
        console.warn(
          `[tether:lifecycle] preserving ${current.sessionId}: live pane scope is unverified`,
        )
        return
      }

      if (current.pendingScopeUnit && !(await reconcileSupersededPendingScope(current))) {
        console.warn(
          `[tether:lifecycle] preserving unresolved pending generation for ${current.sessionId}`,
        )
      }
      return
    }

    // Definitively absent tmux session: drain every persisted generation. No
    // age/name/CPU heuristic participates in this decision.
    if (current.pendingScopeUnit) {
      const clean = await stopOwnedPaneScope(
        current.pendingScopeUnit,
        current.pendingScopeInvocationId,
        `startup pending cleanup ${current.sessionId}`,
      )
      if (!clean) return
      clearWidgetPendingScope(
        current.id,
        current.pendingScopeUnit,
        current.pendingScopeInvocationId,
      )
      current = getWidget(current.id) ?? current
    }
    if (current.scopeUnit) {
      console.warn(
        `[tether:lifecycle] reconciling abandoned scope=${current.scopeUnit} session=${current.sessionId}`,
      )
      logWidgetEvent(current.id, 'lifecycle_reconcile_abandoned', {
        session_id: current.sessionId,
        scope_unit: current.scopeUnit,
        scope_invocation_id: current.scopeInvocationId,
      })
      reportAbandonedScope(current)
      const clean = await stopOwnedPaneScope(
        current.scopeUnit,
        current.scopeInvocationId,
        `startup reconciliation ${current.sessionId}`,
      )
      if (!clean) return
    }
    const latest = getWidget(current.id)
    if (
      latest?.scopeUnit === current.scopeUnit &&
      latest.scopeInvocationId === current.scopeInvocationId &&
      !latest.pendingScopeUnit &&
      (await internalSessionState(current.id)) === 'absent'
    ) {
      const cleared = compareAndSetWidgetOwnership(current.id, ownershipGeneration(latest), {
        ...ownershipGeneration(latest),
        scopeUnit: null,
        scopeInvocationId: null,
        tmuxSessionId: null,
        paneId: null,
        launchState: 'none',
        launchNonce: null,
      })
      if (cleared && latest.tmuxServerId) {
        const server = getTmuxServer(latest.tmuxServerId)
        if (server?.phase === 'dead') {
          clearReconciledDeadTmuxServerBinding(current.id, latest.tmuxServerId)
        } else if (
          server?.kind === 'managed' &&
          server.phase === 'active' &&
          server.scopeUnit.endsWith('.scope')
        ) {
          clearReconciledHistoricalTmuxServerBinding(current.id, latest.tmuxServerId)
        }
      }
    }
  } finally {
    releaseLifecycleOwner(row.id, lifecycleOwner, knownServerId)
  }
}

/** A session whose pane scope is gone, seen before Tether clears the scope
 * fields: the exact unit and invocation crash recovery looks up in the
 * journal. `startup` marks startup reconciliation (a reboot or a daemon
 * restart), which crash recovery leaves to reboot continuity. */
export interface AbandonedScope {
  widgetId: string
  scopeUnit: string
  scopeInvocationId: string | null
  tmuxServerId: string | null
  serverUnit: string | null
  serverInvocationId: string | null
  serverDead: boolean
  startup: boolean
  at: number
}

let launchGuard: ((widgetId: string) => boolean) | null = null

/** Crash recovery: sessions whose fresh start must wait for its resume. */
export function setLaunchGuard(guard: ((widgetId: string) => boolean) | null): void {
  launchGuard = guard
}

let abandonedScopeListener: ((event: AbandonedScope) => void) | null = null

export function onAbandonedScope(listener: ((event: AbandonedScope) => void) | null): void {
  abandonedScopeListener = listener
}

function reportAbandonedScope(row: WidgetRow): void {
  if (!abandonedScopeListener || !row.scopeUnit) return
  const server = row.tmuxServerId ? getTmuxServer(row.tmuxServerId) : undefined
  try {
    abandonedScopeListener({
      widgetId: row.id,
      scopeUnit: row.scopeUnit,
      scopeInvocationId: row.scopeInvocationId,
      tmuxServerId: row.tmuxServerId,
      serverUnit: server?.scopeUnit ?? null,
      serverInvocationId: server?.invocationId ?? null,
      serverDead: server?.phase === 'dead',
      startup: lifecycleState !== 'ready',
      at: Date.now(),
    })
  } catch (error) {
    console.error('[tether:lifecycle] abandoned-scope listener failed:', error)
  }
}

/** Reconcile one session now (crash recovery uses it to notice a tmux server
 * that died while Tether kept running). A busy session is deferred. */
export async function reconcileSessionNow(widgetId: string): Promise<void> {
  if (lifecycleState !== 'ready') return
  const row = getWidget(widgetId)
  if (row) await reconcileManagedWidget(row)
}

/** Crash recovery only: after reconciliation drained a crashed session's
 * scope on a live managed server, return the row to never-allocated so the
 * next ensure recreates it in place. Same CAS as the historical-server path
 * plus an exact absence re-check under the lifecycle lock. `busy` means
 * another lifecycle operation holds the session; try again later. */
export async function releaseCrashedSessionBinding(
  widgetId: string,
): Promise<'released' | 'busy' | 'refused'> {
  const owner = lifecycleOwners.acquire(widgetId)
  if (!owner) return 'busy'
  const knownServerId = getWidget(widgetId)?.tmuxServerId ?? null
  try {
    const row = getWidget(widgetId)
    if (!row) return 'refused'
    if (isNeverAllocatedWidget(row)) return 'released'
    if (!row.tmuxServerId || row.scopeUnit || row.pendingScopeUnit) return 'refused'
    if ((await internalSessionState(widgetId)) !== 'absent') return 'refused'
    const server = getTmuxServer(row.tmuxServerId)
    const cleared =
      server?.phase === 'dead'
        ? clearReconciledDeadTmuxServerBinding(widgetId, row.tmuxServerId)
        : clearCrashedTmuxServerBinding(widgetId, row.tmuxServerId)
    return cleared ? 'released' : 'refused'
  } finally {
    releaseLifecycleOwner(widgetId, owner, knownServerId)
    publishSession(widgetId)
  }
}

async function reconcileAbandonedScopes(): Promise<void> {
  // Sequential startup keeps tmux/systemd load bounded and makes each row's
  // ownership transition independently observable in logs.
  for (const row of listWidgets()) await reconcileManagedWidget(row, true)
}

// --- status cache and events (Tether) ---------------------------------------

export type SessionStatus = 'running' | 'pending' | 'uncertain' | 'legacy'

/** Last verified status per session, keyed by the generation it was computed
 * for. List answers from here; GET re-verifies. */
const statusCache = new Map<string, { generation: string; status: SessionStatus }>()
let generationOf: (row: WidgetRow) => string = () => ''

export function setGenerationFunction(fn: (row: WidgetRow) => string): void {
  generationOf = fn
}

export async function verifySessionStatus(row: WidgetRow): Promise<SessionStatus> {
  let status: SessionStatus
  if (isNeverAllocatedWidget(row)) status = 'pending'
  else if (row.lifecycleVersion < MANAGED_LIFECYCLE_VERSION) status = 'legacy'
  else if (
    row.launchState === 'dispatched' &&
    (await rootManagedGateState(row)) === 'active-workload'
  )
    status = 'running'
  else status = 'uncertain'
  statusCache.set(row.id, { generation: generationOf(row), status })
  return status
}

export function cachedSessionStatus(row: WidgetRow): SessionStatus {
  const cached = statusCache.get(row.id)
  if (cached && cached.generation === generationOf(row)) return cached.status
  if (isNeverAllocatedWidget(row)) return 'pending'
  if (row.lifecycleVersion < MANAGED_LIFECYCLE_VERSION) return 'legacy'
  return 'uncertain'
}

/** True when the status cache holds an answer for the row's current generation. */
export function hasVerifiedStatus(row: WidgetRow): boolean {
  return statusCache.get(row.id)?.generation === generationOf(row)
}

/** Builds the session snapshot carried by session events (the API descriptor).
 * Set by the daemon; without it events carry ids and generations only. */
let snapshotOf: ((row: WidgetRow) => Record<string, unknown>) | null = null

export function setSessionSnapshotFunction(
  fn: ((row: WidgetRow) => Record<string, unknown>) | null,
): void {
  snapshotOf = fn
}

const publishedGenerations = new Map<string, string>()
let sessionEventChain: Promise<void> = Promise.resolve()

interface PublishOptions {
  /** Publish `session.updated` even when the generation is unchanged. */
  force?: boolean
  /** Publish `session.ended` for an absent row even if never announced. */
  ended?: boolean
}

/**
 * Announce a session change. Session events go through one ordered queue so a
 * status check that has to touch tmux can never reorder them. The event carries
 * the session's descriptor (`session`) with a status verified for the exact
 * generation it announces.
 */
function publishSession(widgetId: string, options: PublishOptions = {}): void {
  sessionEventChain = sessionEventChain
    .then(() => publishSessionNow(widgetId, options))
    .catch((error) => console.error(`[tether] session event for ${widgetId} failed:`, error))
}

const publishedTitles = new Map<string, string>()

async function publishSessionNow(widgetId: string, options: PublishOptions): Promise<void> {
  const events = config?.events
  if (!events) return
  let row = getWidget(widgetId)
  if (!row) {
    if (publishedGenerations.delete(widgetId) || options.ended)
      events.publish('session.ended', { id: widgetId })
    return
  }
  const generation = generationOf(row)
  if (publishedGenerations.get(widgetId) === generation && !options.force) return
  if (snapshotOf && !hasVerifiedStatus(row) && lifecycleState !== 'disabled') {
    try {
      await verifySessionStatus(row)
    } catch {
      // The snapshot reports the cached (uncertain) status.
    }
    row = getWidget(widgetId)
    if (!row) {
      if (publishedGenerations.delete(widgetId) || options.ended)
        events.publish('session.ended', { id: widgetId })
      return
    }
  }
  const current = generationOf(row)
  if (publishedGenerations.get(widgetId) === current && !options.force) return
  const created = !publishedGenerations.has(widgetId)
  publishedGenerations.set(widgetId, current)
  const data: Record<string, unknown> = { id: widgetId, generation: current }
  if (snapshotOf) data.session = snapshotOf(row)
  events.publish(created ? 'session.created' : 'session.updated', data)
  // A lane's badge names its coordinator: a renamed coordinator retitles them.
  const title = displayTitle(row)
  const before = publishedTitles.get(widgetId)
  publishedTitles.set(widgetId, title)
  if (row.coordinator && before !== undefined && before !== title)
    for (const lane of listLanes(widgetId)) publishSession(lane, { force: true })
}

/** Resolves once every queued session event has been published (tests, shutdown). */
export function flushSessionEvents(): Promise<void> {
  return sessionEventChain
}

function publishCatalogChanges(): void {
  const live = new Set<string>()
  for (const row of listWidgets()) {
    live.add(row.id)
    publishSession(row.id)
  }
  for (const id of [...publishedGenerations.keys()]) if (!live.has(id)) publishSession(id)
}

/** Announce a session change made outside the engine (rename, view title). */
export function notifySessionChanged(widgetId: string, options: PublishOptions = {}): void {
  publishSession(widgetId, options)
}

// --- startup (Aico app.whenReady lifecycle half) ------------------------------

export type LifecycleState = 'reconciling' | 'ready' | 'disabled'
let lifecycleState: LifecycleState = 'reconciling'
let readyPromise: Promise<void> = Promise.resolve()

export function lifecycleStatus(): LifecycleState {
  return lifecycleState
}

/** Mutations await startup reconciliation. */
export function whenReady(): Promise<void> {
  return readyPromise
}

export function lingerEnabled(): boolean {
  return durableUserManager
}

/**
 * Startup: tmux.conf, linger, server reconciliation (with historical adoption
 * on `default`), the pane-exit watcher, then per-session scope reconciliation.
 * `reconcile: false` (TETHER_RECONCILE=off) keeps a test instance from
 * observing, adopting or stopping anything; it still serves its own catalog.
 */
export function startLifecycle(options: { reconcile: boolean }): Promise<void> {
  quitting = false
  ensureTmuxConf()
  durableUserManager = detectDurableUserManager()
  console.log(
    `[tether:lifecycle] durable user manager: ${
      durableUserManager ? 'linger enabled' : 'unavailable; new sessions blocked'
    }`,
  )
  for (const row of listWidgets()) publishedGenerations.set(row.id, generationOf(row))
  if (!options.reconcile) {
    lifecycleState = 'disabled'
    console.warn('[tether:lifecycle] reconciliation disabled (TETHER_RECONCILE=off)')
    readyPromise = Promise.resolve()
    return readyPromise
  }
  lifecycleState = 'reconciling'
  readyPromise = (async () => {
    try {
      await reconcileTmuxServers()
      ensurePaneExitFsWatcher()
      await reconcileAbandonedScopes()
      adoptOrphans()
      for (const row of listWidgets()) {
        try {
          await verifySessionStatus(row)
        } catch {
          // Status stays uncertain until a later verification.
        }
      }
      publishCatalogChanges()
    } catch (error) {
      console.error('[tether:lifecycle] startup reconciliation failed:', error)
    } finally {
      lifecycleState = 'ready'
    }
    // Best effort and in the background: readiness never waits for it.
    void probeRunningContexts().catch((error) =>
      console.error('[tether:lifecycle] context probe failed:', error),
    )
  })()
  return readyPromise
}

export function stopLifecycle(): void {
  quitting = true
  paneExitFsWatcher?.close()
  paneExitFsWatcher = null
  paneExitEventReady.clear()
}

/** Test/diagnostic: has-session through the exact bound target. */
export function hasSessionArgsFor(widgetId: string): string[] {
  return hasTargetArgs(tmuxTargetForWidget(widgetId))
}
