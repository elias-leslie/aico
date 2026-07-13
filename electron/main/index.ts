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
import { homedir, uptime } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  session,
} from 'electron'
import { type IPty, spawn } from 'node-pty'
import { parseTerminalFontSettings } from '../shared/font-settings'
import {
  CoalescedLifecycleIntent,
  classifyPersistedScopePair,
  decideManagedGateRecovery,
  hasPersistedScopeCleanupEvidence,
  isReconciledSessionOwnershipAbsent,
  LifecycleOwnerLock,
  type LifecycleOwnerToken,
  type ManagedGateState,
  mayClearMatchingPendingScope,
} from './lifecycle-guard'
import { allowTrustedAudioMedia } from './media-permission'
import {
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
import {
  isDir,
  listProjects,
  listProjectsFresh,
  onProjectsRefreshed,
  PERSONAL_WORKSPACE_ID,
  type ProjectInfo,
  projectRoot,
  refreshProjects,
  widgetCwd,
} from './project'
import { compactRef, parseSse, type SelectionRecord } from './selection'
import { bundledSidecar, Sidecar } from './sidecar'
import {
  activateTmuxServer,
  adoptActiveLegacyTmuxServer,
  bindWidgetTmuxServer,
  clearReconciledDeadTmuxServerBinding,
  clearReconciledHistoricalTmuxServerBinding,
  clearWidgetPendingScope,
  compareAndSetWidgetLaunchMetadata,
  compareAndSetWidgetOwnership,
  getCurrentManagedTmuxServer,
  getSetting,
  getTmuxServer,
  getWidget,
  hasWidget,
  initStore,
  insertExternalWidget,
  insertLegacyUnclassifiedWidget,
  insertProvisioningTmuxServer,
  insertWidget,
  listTmuxServers,
  listWidgets,
  markTmuxServerDead,
  removeWidget,
  removeWidgetIfOwnership,
  saveBounds,
  setOpen,
  setSetting,
  setWidgetName,
  setWidgetPendingScope,
  setWidgetProject,
  setWidgetTool,
  type TmuxServerRow,
  type WidgetOwnershipGeneration,
  type WidgetRow,
} from './store'
import { terminalClientEnv } from './terminal-env'
import {
  A_TERM_SESSION_PREFIX,
  attachTargetArgs,
  capturePageTargetArgs,
  captureTargetArgs,
  hasTargetArgs,
  internalTarget,
  isATermSessionName,
  isTmuxTransportUnavailable,
  killTargetArgs,
  listClientsTargetArgs,
  listDefaultPanesArgs,
  listSessionPaneDetailsTargetArgs,
  listSessionPanesTargetArgs,
  newDetachedTargetArgs,
  paneExitedEventPath,
  paneExitedHookCommand,
  paneExitedHookTargetArgs,
  panePidTargetArgs,
  paneScrollbackInfoTargetArgs,
  refreshClientArgs,
  respawnTargetArgs,
  runInPaneTargetArgs,
  scrollbackPageBounds,
  sendTextTargetArgs,
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
import { createTray, refreshTray, setWidgetActivity, type TrayWidget } from './tray'
import {
  ensureContext,
  getTui,
  launchLine,
  listTuis,
  paneCommand,
  registerBuiltinTuis,
} from './tui'
import { detectTuiFromProcessNames, parseProcessTable, processTreeNames } from './tui/detect'

const execFileAsync = promisify(execFile)
const LOGINCTL_BIN = '/usr/bin/loginctl'
const PS_BIN = '/usr/bin/ps'
const SYSTEMCTL_BIN = '/usr/bin/systemctl'
const SYSTEMD_RUN_BIN = '/usr/bin/systemd-run'
const TMUX_BIN = '/usr/bin/tmux'
const SCROLLBACK_PAGE_DEFAULT_LINES = 5000
const SCROLLBACK_PAGE_MAX_LINES = 5000
const SYSTEMD_QUERY_TIMEOUT_MS = 2_000
const SYSTEMD_STOP_TIMEOUT_MS = 5_000

function scrollbackPageCount(input: unknown): number {
  const n = typeof input === 'number' ? input : SCROLLBACK_PAGE_DEFAULT_LINES
  if (!Number.isFinite(n)) return SCROLLBACK_PAGE_DEFAULT_LINES
  return Math.min(SCROLLBACK_PAGE_MAX_LINES, Math.max(1, Math.floor(n)))
}

function scrollbackPageFromLine(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'number' || !Number.isFinite(input)) return undefined
  return Math.max(0, Math.floor(input))
}

// One node-pty per open window. The PTY runs `tmux attach`; killing it only
// detaches the client, so the tmux session (and its shell) survives reload/close.
const ptys = new Map<number, IPty>()
const ptyStartGenerations = new Map<number, number>()
const sessionStartPromises = new Map<string, Promise<boolean>>()
// BrowserWindow.id -> stable widget id. The widget id (not the volatile window
// id) names the tmux session, so a widget reattaches the same session across
// close/reopen and app restarts.
const widgetOf = new Map<number, string>()
const boundsTimers = new Map<number, NodeJS.Timeout>()
// Serialize destructive operations per durable widget. A window may request a
// replace/reopen while discard cleanup is awaiting systemd; overlap would let a
// new generation inherit a row the old generation later deletes.
const lifecycleOwners = new LifecycleOwnerLock()
// A confirmed retirement is an explicit user intent, not a best-effort probe.
// Coalesce repeat clicks while another lifecycle operation owns the widget, and
// consume the intent only after retirement acquires that exact widget's token.
const widgetRetireIntents = new CoalescedLifecycleIntent()
let quitting = false

// Eyes-follow-cursor: while any widget is unfocused, broadcast the global cursor
// position so those widgets' eyes can track it. One shared interval feeds every
// window; the focused window ignores it and stares ahead. Runs only when at least
// one window is unfocused, so an all-focused desktop pays nothing.
const blurredWins = new Set<number>()
let cursorTimer: NodeJS.Timeout | undefined
let lastCursorPt: { x: number; y: number } | null = null
function syncCursorPump(): void {
  lastCursorPt = null // a focus change always gets one fresh send
  if (blurredWins.size > 0 && !cursorTimer) {
    cursorTimer = setInterval(() => {
      const pt = screen.getCursorScreenPoint()
      if (lastCursorPt && pt.x === lastCursorPt.x && pt.y === lastCursorPt.y) return
      lastCursorPt = pt
      for (const id of blurredWins) {
        const win = BrowserWindow.fromId(id)
        if (win && !win.isDestroyed()) win.webContents.send('win:cursor', pt)
      }
    }, 250)
  } else if (blurredWins.size === 0 && cursorTimer) {
    clearInterval(cursorTimer)
    cursorTimer = undefined
  }
}
// The widget that should receive an indicated selection: the last Aico widget
// the user focused. (During an indicate gesture the *browser* holds OS focus,
// so "active session" means most-recently-focused widget, not focused-now.)
let lastFocusedAico: string | null = null
// Aborts the sidecar SSE subscription (deliver-event stream) on quit.
let selectionEvents: AbortController | null = null

// System-wide "indicate" hotkey. Works on X11 today; on Wayland (GNOME 46, no
// GlobalShortcuts portal) globalShortcut silently no-ops — bind a GNOME custom
// shortcut to a CLI that poke this same grab path instead (follow-on).
const SELECTION_HOTKEY = process.env.AICO_SELECTION_HOTKEY ?? 'CommandOrControl+Shift+Space'

// Push-to-talk: a press toggles dictation on the focused widget (globalShortcut
// fires on press only — no key-release — so this is a toggle, not a hold). The
// renderer captures the mic and types the transcript into its own prompt.
const VOICE_PTT_HOTKEY = process.env.AICO_VOICE_HOTKEY ?? 'CommandOrControl+Shift+M'
// Optional voice websocket. user_id/app are accepted by the default local STT URL;
// mode=transcribe is appended by the client (transcript only, no voice-assistant
// completion — voice is dictation into the TUI, which then responds).
const VOICE_WS_URL =
  process.env.AICO_VOICE_WS ?? 'ws://127.0.0.1:8003/api/voice/ws?user_id=aico&app=aico'

interface PtySize {
  cols: number
  rows: number
}

// Clamp renderer-supplied terminal geometry to sane integers before it reaches
// tmux (-x/-y) and node-pty: a non-integer, negative, NaN, or absurd value would
// otherwise create a degenerate session or throw deep inside pty.resize.
const MAX_TERM_DIM = 1000
function clampDim(n: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(MAX_TERM_DIM, Math.max(1, Math.floor(n))) : fallback
}
function clampSize(size: PtySize): PtySize {
  return { cols: clampDim(size?.cols, 80), rows: clampDim(size?.rows, 24) }
}

const stateDir = process.env.AICO_STATE_DIR ?? join(homedir(), '.local', 'state', 'aico')
const tmuxConfPath = join(stateDir, 'tmux.conf')
const dbPath = join(stateDir, 'aico.db')

const sidecarHost = process.env.AICO_SIDECAR_HOST ?? '127.0.0.1'
const sidecarPort = Number(process.env.AICO_SIDECAR_PORT ?? 8005)
let sidecar: Sidecar | null = null
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
  // Reuse the sidecar's bounded, rotated per-widget JSONL implementation. The
  // console line remains authoritative if the optional sidecar is unavailable.
  void fetch(
    `http://${sidecarHost}:${sidecarPort}/widgets/${encodeURIComponent(widgetId)}/events`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, data }),
      // The sidecar is optional. A wedged loopback listener must not retain an
      // unbounded fetch while Aico is trying to reconcile or retire a workload.
      signal: AbortSignal.timeout(2_000),
    },
  ).catch(() => {})
}

function newWidgetId(): string {
  return randomBytes(4).toString('hex')
}

function ensureTmuxConf(): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(tmuxConfPath, tmuxConf())
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
      `[aico:lifecycle] managed tmux profile/event bridge failed for server=${server.id}:`,
      error,
    )
    return false
  }
}

function windowForWidget(id: string): BrowserWindow | undefined {
  for (const [winId, wid] of widgetOf) {
    if (wid === id) {
      const win = BrowserWindow.fromId(winId)
      if (win && !win.isDestroyed()) return win
    }
  }
  return undefined
}

function tmuxTargetForWidget(widgetId: string): TmuxTarget {
  const row = getWidget(widgetId)
  if (row?.externalTmuxSession) {
    return {
      socket: row.externalTmuxSocket,
      session: row.externalTmuxSession,
    }
  }
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
function tmuxPaneTargetForWidget(widgetId: string): TmuxTarget {
  const target = tmuxTargetForWidget(widgetId)
  const paneId = getWidget(widgetId)?.paneId
  return paneId ? { ...target, session: paneId } : target
}

function isExternalTmuxWidget(widgetId: string): boolean {
  return Boolean(getWidget(widgetId)?.externalTmuxSession)
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
const paneExitReconciliations = new Map<string, Promise<void>>()
const paneExitDirtyServers = new Set<string>()
const paneExitDeferredServers = new Set<string>()
const paneExitUnresolvedServers = new Set<string>()
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

function paneExitEventDirectory(): string | null {
  const uid = process.getuid?.()
  return Number.isSafeInteger(uid) && (uid as number) >= 0 ? `/run/user/${uid}/aico` : null
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
  paneExitUnresolvedServers.add(serverId)
  queuePaneExitReconciliation(serverId)
}

function queuePaneExitReconciliation(serverId: string): void {
  if (quitting) return
  if (paneExitReconciliations.has(serverId)) {
    // One pass observes every widget on the generation. Coalesce any number of
    // exits during it to one dirty follow-up instead of retaining an unbounded
    // promise/backlog under rapid pane churn.
    paneExitDirtyServers.add(serverId)
    return
  }
  let next: Promise<void>
  let resolved = false
  next = handlePaneExitWatcherCompletion(serverId)
    .then((value) => {
      resolved = value
    })
    .catch((error) =>
      console.error(
        `[aico:lifecycle] pane-exit reconciliation failed for server=${serverId}:`,
        error,
      ),
    )
    .finally(() => {
      if (paneExitReconciliations.get(serverId) === next) paneExitReconciliations.delete(serverId)
      const dirty = paneExitDirtyServers.delete(serverId)
      if (resolved && !dirty && !paneExitDeferredServers.has(serverId)) {
        paneExitUnresolvedServers.delete(serverId)
      } else {
        paneExitUnresolvedServers.add(serverId)
      }
      if (dirty) queuePaneExitReconciliation(serverId)
    })
  paneExitReconciliations.set(serverId, next)
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
        // strand a durable marker until the next Electron restart.
        try {
          observePersistedPaneExitEvents(directory)
        } catch (error) {
          console.error('[aico:lifecycle] pane-exit event rescan failed:', error)
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
        '[aico:lifecycle] pane-exit event watcher failed; new launches are blocked:',
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
    console.error('[aico:lifecycle] could not start pane-exit event watcher:', error)
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
      paneExitDeferredServers.add(serverId)
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
  return !paneExitDeferredServers.has(serverId)
}

function retryUnresolvedPaneExitReconciliation(serverId: string | null): void {
  if (!serverId) return
  if (!paneExitFsWatcher) ensurePaneExitFsWatcher()
  if (paneExitEventMarkerExists(serverId)) {
    observePaneExitEvent(serverId)
  } else if (paneExitUnresolvedServers.has(serverId)) {
    queuePaneExitReconciliation(serverId)
  }
}

function releaseLifecycleOwner(
  widgetId: string,
  owner: Parameters<LifecycleOwnerLock['release']>[0],
  knownServerId?: string | null,
): void {
  if (!lifecycleOwners.release(owner)) return
  // A confirmed retire has priority over watcher reconciliation for the same
  // widget. Acquire it synchronously after release; the watcher then observes
  // the held token and defers instead of repeatedly winning the race.
  if (widgetRetireIntents.isPending(widgetId)) drainWidgetRetire(widgetId)
  const serverId = knownServerId ?? getWidget(widgetId)?.tmuxServerId
  if (serverId && paneExitDeferredServers.delete(serverId)) {
    queuePaneExitReconciliation(serverId)
  }
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
async function internalSessionState(widgetId: string): Promise<InternalSessionState> {
  const row = getWidget(widgetId)
  if (!row) return 'unknown'
  if (row.tmuxServerId) {
    const server = getTmuxServer(row.tmuxServerId)
    if (server?.phase === 'dead') return 'absent'
    if (!server || server.phase !== 'active') return 'unknown'
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

const TMUX_SERVER_SETTLE_MS = 5_000
const TMUX_SERVER_POLL_MS = 50

function processEnvironment(pid: number): ReadonlyMap<string, string> | null {
  try {
    return new Map(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf('=')
          return separator < 0
            ? ([entry, ''] as const)
            : ([entry.slice(0, separator), entry.slice(separator + 1)] as const)
        }),
    )
  } catch {
    return null
  }
}

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
  const parent = join(stateDir, 'tmux')
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  chmodSync(parent, 0o700)
  const directory = join(parent, serverId)
  mkdirSync(directory, { mode: 0o700 })
  return directory
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
  const tmuxArgs = newDetachedTargetArgs(target, size.cols, size.rows, tmuxConfPath, cwd, {
    ...environment,
    AICO_TMUX_SERVER_ID: serverId,
  })
  let launchError: unknown = null
  try {
    execFileSync(SYSTEMD_RUN_BIN, durableTmuxServerArgs(serverId, tmuxArgs), {
      env: terminalClientEnv(),
      timeout: SYSTEMD_STOP_TIMEOUT_MS,
    })
  } catch (error) {
    launchError = error
  }

  const deadline = Date.now() + TMUX_SERVER_SETTLE_MS
  do {
    const active = await recoverProvisioningTmuxServer(provisioning, false)
    if (active) {
      console.log(
        `[aico:lifecycle] tmux server=${active.id} pid=${active.serverPid} ` +
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
  throw new Error('Aico could not prove durable tmux-server ownership; launch remains gated', {
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
  if (!row) throw new Error(`widget ${widgetId} disappeared before tmux allocation`)

  if (row.tmuxServerId) {
    const bound = getTmuxServer(row.tmuxServerId)
    if (bound?.phase === 'provisioning') {
      const recovered = await recoverProvisioningTmuxServer(bound, false)
      if (recovered && (await internalSessionState(widgetId)) === 'present') return
      throw new Error(`bound tmux server ${row.tmuxServerId} is still provisioning`)
    } else if (bound?.phase === 'active' && (await observeTmuxServer(bound)) === 'reachable') {
      if (bound.scopeUnit.endsWith('.scope')) {
        // Caller-spawned v1 server scopes may have inherited Electron file
        // descriptors. Preserve and reconnect their existing sessions, but do
        // not allocate more work into them; unbound widgets use the clean-FD
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
          tmuxConfPath,
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
        tmuxConfPath,
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

function managedEnvironment(
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
  if (row?.tmuxServerId) environment.AICO_TMUX_SERVER_ID = row.tmuxServerId
  return environment
}

/** Resolve only the narrow cgroup assigned to this exact tmux pane. Broad app,
 * GNOME, user, and session scopes are intentionally rejected by the parser. */
function processStartTime(pid: number): string | null {
  try {
    return processStartTimeFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

function processStartTimeFromStat(stat: string): string | null {
  const fields = stat
    .slice(stat.lastIndexOf(') ') + 2)
    .trim()
    .split(/\s+/)
  // The slice starts at proc field 3 (state); field 22 is process starttime.
  return fields[19] ?? null
}

interface ManagedPaneProcess {
  pid: number
  startTime: string
  scopeUnit: string | null
  tmuxSessionId: string
  paneId: string
}

function ownershipGeneration(row: WidgetRow): WidgetOwnershipGeneration {
  return {
    scopeUnit: row.scopeUnit,
    scopeInvocationId: row.scopeInvocationId,
    pendingScopeUnit: row.pendingScopeUnit,
    pendingScopeInvocationId: row.pendingScopeInvocationId,
    lifecycleVersion: row.lifecycleVersion,
    tmuxSessionId: row.tmuxSessionId,
    paneId: row.paneId,
    tmuxServerId: row.tmuxServerId,
    tmuxAllocationState: row.tmuxAllocationState,
    launchState: row.launchState,
    launchNonce: row.launchNonce,
  }
}

/** Observe one exact server-side session/pane generation. Aico's managed-widget
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
        `[aico:lifecycle] preserving ${widgetId}: expected one pane, observed ${paneLines.length}`,
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
      console.warn(`[aico:lifecycle] preserving ${widgetId}: tmux session identity changed`)
      return null
    }
    if (row?.paneId && row.paneId !== paneId) {
      console.warn(`[aico:lifecycle] preserving ${widgetId}: tmux pane identity changed`)
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

interface ScopeIdentity {
  loadState: string
  activeState: string
  controlGroup: string
  invocationId: string
  job: string
}

async function scopeIdentity(unit: string): Promise<ScopeIdentity | null> {
  try {
    const { stdout } = await execFileAsync(
      SYSTEMCTL_BIN,
      [
        '--user',
        'show',
        unit,
        '--no-pager',
        '--property=LoadState',
        '--property=ActiveState',
        '--property=ControlGroup',
        '--property=InvocationID',
        '--property=Job',
      ],
      { timeout: SYSTEMD_QUERY_TIMEOUT_MS },
    )
    const properties = new Map<string, string>()
    for (const line of stdout.split('\n')) {
      const separator = line.indexOf('=')
      if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1))
    }
    return {
      loadState: properties.get('LoadState') ?? 'unknown',
      activeState: properties.get('ActiveState') ?? 'unknown',
      controlGroup: properties.get('ControlGroup') ?? '',
      invocationId: properties.get('InvocationID') ?? '',
      job: properties.get('Job') ?? '',
    }
  } catch {
    return null
  }
}

interface TmuxRosterRead {
  evidence: TmuxServerRosterEvidence
  entries: readonly TmuxServerRosterEntry[]
  detail: string
}

function readTmuxServerRoster(socketPath: string): TmuxRosterRead {
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
    const serverPids = new Set(entries.map((entry) => entry.serverPid))
    if (entries.length === 0 || serverPids.size !== 1) {
      return { evidence: { status: 'unavailable' }, entries: [], detail: 'empty/mixed roster' }
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

function processControlGroup(pid: number): string | null {
  const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
  for (const line of cgroup.split('\n')) {
    const separator = line.indexOf('::')
    if (separator >= 0) return line.slice(separator + 2)
  }
  return null
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
  if (server.phase !== 'active') {
    tmuxServerRuntimeStates.set(server.id, 'ambiguous')
    return 'ambiguous'
  }
  const roster = readTmuxServerRoster(server.socketPath)
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
      `[aico:lifecycle] tmux server=${server.id} kind=${server.kind} state=${state}` +
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
    if (!row) row = insertLegacyUnclassifiedWidget(widgetId, false, 'shell', entry.createdAt)
    if (row.externalTmuxSession) continue
    if (row.tmuxServerId && row.tmuxServerId !== server.id) {
      console.warn(
        `[aico:lifecycle] preserving ${entry.sessionName}: widget is already bound to server=${row.tmuxServerId}, refusing roster collision with server=${server.id}`,
      )
      continue
    }
    const paneId = solePaneId(server.socketPath, entry.sessionId)
    if (!paneId) {
      console.warn(
        `[aico:lifecycle] preserving ${entry.sessionName}: expected one pane while adopting server=${server.id}`,
      )
      continue
    }
    if (!bindWidgetTmuxServer(row.id, row.tmuxServerId, server.id, entry.sessionId, paneId)) {
      console.warn(
        `[aico:lifecycle] could not bind ${entry.sessionName} to observed server=${server.id}`,
      )
    }
  }
}

async function adoptHistoricalTmuxServer(): Promise<TmuxServerRow | null> {
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
      `[aico:lifecycle] adopted legacy tmux server=${adopted.id} pid=${pid} ` +
        `scope=${scopeUnit} sessions=${first.entries.length} observation_only=true`,
    )
    return adopted
  } catch (error) {
    console.warn('[aico:lifecycle] legacy tmux server adoption failed closed:', error)
    return null
  }
}

async function reconcileTmuxServers(): Promise<void> {
  for (const server of listTmuxServers()) {
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
  if (managed?.phase === 'active' && (await observeTmuxServer(managed)) === 'reachable') {
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
  tool: NonNullable<ReturnType<typeof getTui>>
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
        ? projectRoot(intent.projectId)
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
      `[aico:lifecycle] refusing gate dispatch for ${row.sessionId}: ` +
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
      `[aico:lifecycle] could not verify pane-exit hook for server=${server.id}:`,
      error,
    )
  }
  paneExitEventReady.delete(server.id)
  console.error(
    `[aico:lifecycle] pane-exit hook changed for server=${server.id}; new launches are blocked`,
  )
  return false
}

function processInControlGroup(pid: number, controlGroup: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .some((line) => line.endsWith(`:${controlGroup}`))
  } catch {
    return false
  }
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
    console.error(`[aico:lifecycle] refusing stale ownership promotion for ${widgetId}`)
    return null
  }
  console.log(
    `[aico:lifecycle] session=${row.sessionId} widget=${widgetId} ` +
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

async function verifiedCurrentManagedPane(row: WidgetRow): Promise<ManagedPaneProcess | null> {
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

function cgroupProcessIds(controlGroup: string): number[] | null {
  try {
    const root = `/sys/fs/cgroup${controlGroup}`
    const pending = [root]
    const processIds: number[] = []
    while (pending.length > 0) {
      const directory = pending.pop() as string
      processIds.push(
        ...readFileSync(join(directory, 'cgroup.procs'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(Number)
          .filter((pid) => Number.isInteger(pid) && pid > 0),
      )
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) pending.push(join(directory, entry.name))
      }
    }
    return processIds
  } catch {
    return null
  }
}

/** The fixed gate is safe to advance only while it is the sole process in the
 * exact owned cgroup, including every descendant cgroup. If a prior send
 * already started or delegated anything, ambiguity preserves it and never
 * replays a launcher. `runInPaneTargetArgs` also clears a partially typed line
 * before its literal send, making restart recovery idempotent before Enter. */
function isExactLaunchGateProcess(pid: number): boolean | null {
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`)
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
    return (
      command.length === 3 &&
      command[0] === '/bin/bash' &&
      command[1] === '--noprofile' &&
      command[2] === '--norc'
    )
  } catch {
    return null
  }
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

type ManagedPaneRecovery = 'recovered' | 'legacy' | 'blocked' | 'blocked-replay'

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
        `[aico:lifecycle] preserving non-replayable gate for ${current.sessionId}; ` +
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
    const intentRow = persistManagedGateLaunchIntent(current, verified.pid)
    if (!intentRow) return 'blocked'
    const dispatchedRow = markManagedGateDispatched(intentRow)
    if (!dispatchedRow) return 'blocked'
    current = dispatchedRow
    const tool = getTui(current.tool ?? 'shell')
    const line = tool ? launchLine(tool) : null
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
      runInPaneTargetArgs(tmuxPaneTargetForWidget(row.id), paneCommand(line)),
      {
        env: terminalClientEnv(),
        timeout: TMUX_QUERY_TIMEOUT_MS,
      },
    )
    console.log(`[aico:lifecycle] resumed verified launch gate for session=${current.sessionId}`)
    if (tool && line) reportContext(row.id, tool)
  }
  if (decision === 'recovered' && current.pendingScopeUnit) {
    // Reattach is a concrete recovery trigger for a former generation whose
    // post-replacement cleanup was interrupted. Preserve attachment even if
    // cleanup remains unprovable, but do not leave the old tree unnoticed.
    if (!(await reconcileSupersededPendingScope(current))) {
      console.warn(
        `[aico:lifecycle] attachment preserved with unresolved former scope ${current.pendingScopeUnit}`,
      )
    }
  }
  return 'recovered'
}

function readCgroupPopulated(controlGroup: string): boolean | null {
  try {
    const events = readFileSync(`/sys/fs/cgroup${controlGroup}/cgroup.events`, 'utf8')
    if (/^populated 0$/m.test(events)) return false
    if (/^populated 1$/m.test(events)) return true
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return null
  }
}

interface CgroupIdentity {
  dev: bigint
  ino: bigint
}

function cgroupIdentity(controlGroup: string): CgroupIdentity | null {
  try {
    const stat = statSync(`/sys/fs/cgroup${controlGroup}`, { bigint: true })
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return null
  }
}

function sameCgroupIdentity(left: CgroupIdentity, right: CgroupIdentity | null): boolean {
  return Boolean(right && left.dev === right.dev && left.ino === right.ino)
}

async function emptyOwnedCgroup(
  unit: string,
  controlGroup: string,
  expectedIdentity: CgroupIdentity,
  reason: string,
): Promise<boolean> {
  const uid = process.getuid?.() ?? -1
  if (!isOwnedPaneControlGroup(unit, controlGroup, uid)) return false
  const populated = readCgroupPopulated(controlGroup)
  if (populated === false) return true
  if (populated === null) return false

  // A user systemd manager cannot signal a sudo-created root descendant. The
  // delegated cgroup.kill file is kernel-enforced whole-cgroup cleanup and was
  // verified against a synthetic root setsid child; write only after exact unit,
  // InvocationID, full ControlGroup path, and the cgroup directory's device/inode
  // identity matched. The inode check prevents a removed/recreated unit from
  // inheriting cleanup authority between `systemctl stop` and this write.
  console.warn(`[aico:lifecycle] forcing still-populated owned cgroup ${unit} after ${reason}`)
  if (!sameCgroupIdentity(expectedIdentity, cgroupIdentity(controlGroup))) {
    console.error(`[aico:lifecycle] refusing cgroup.kill for replaced cgroup ${unit}`)
    return false
  }
  try {
    writeFileSync(`/sys/fs/cgroup${controlGroup}/cgroup.kill`, '1')
  } catch (error) {
    console.error(`[aico:lifecycle] cgroup.kill failed for ${unit}:`, error)
    return false
  }
  const deadline = Date.now() + SYSTEMD_QUERY_TIMEOUT_MS
  do {
    const state = readCgroupPopulated(controlGroup)
    if (state === false) return true
    if (state === null) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  return false
}

async function stopOwnedPaneScope(
  unit: string | null,
  expectedInvocationId: string | null,
  reason: string,
): Promise<boolean> {
  if (!isOwnedPaneScope(unit) || !isSystemdInvocationId(expectedInvocationId)) return false
  const before = await scopeIdentity(unit)
  if (!before) return false
  const uid = process.getuid?.() ?? -1
  if (before.loadState === 'not-found' && !before.controlGroup) {
    const expectedControlGroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`
    const residue = readCgroupPopulated(expectedControlGroup)
    if (residue === false) return true
    console.error(
      `[aico:lifecycle] refusing to treat missing unit ${unit} as clean: cgroup residue is ${
        residue === true ? 'populated' : 'unverifiable'
      }`,
    )
    return false
  }
  if (
    before.invocationId !== expectedInvocationId ||
    !isOwnedPaneControlGroup(unit, before.controlGroup, uid)
  ) {
    console.error(`[aico:lifecycle] refusing ${unit}: invocation identity changed before ${reason}`)
    return false
  }
  const beforeCgroupIdentity = cgroupIdentity(before.controlGroup)
  if (!beforeCgroupIdentity) {
    console.error(
      `[aico:lifecycle] refusing ${unit}: cgroup identity is unavailable before ${reason}`,
    )
    return false
  }
  try {
    await execFileAsync(SYSTEMCTL_BIN, ['--user', 'stop', unit], {
      timeout: SYSTEMD_STOP_TIMEOUT_MS,
    })
  } catch (error) {
    // A scope can disappear between discovery and stop. Verify state below
    // rather than treating that benign race as a cleanup failure.
    console.warn(`[aico:lifecycle] stop ${unit} (${reason}) returned an error:`, error)
  }
  try {
    if (await emptyOwnedCgroup(unit, before.controlGroup, beforeCgroupIdentity, reason)) {
      console.log(`[aico:lifecycle] scope ${unit} empty after ${reason}`)
      return true
    }
    console.error(`[aico:lifecycle] scope ${unit} remains populated after ${reason}`)
    return false
  } catch (error) {
    console.error(`[aico:lifecycle] could not verify scope ${unit} after ${reason}:`, error)
    return false
  }
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

async function sessionDiagnostics(widgetId: string): Promise<Record<string, unknown>> {
  const row = getWidget(widgetId)
  if (!row) return { capturedAt: new Date().toISOString(), error: 'widget not found' }
  retryUnresolvedPaneExitReconciliation(row.tmuxServerId)
  const target = tmuxTargetForWidget(widgetId)
  let sessionState: InternalSessionState = 'unknown'
  if (row.externalTmuxSession) {
    sessionState = await execFileAsync(TMUX_BIN, hasTargetArgs(target), {
      timeout: TMUX_QUERY_TIMEOUT_MS,
      env: terminalClientEnv(),
    })
      .then(() => 'present' as const)
      .catch(() => 'unknown' as const)
  } else {
    sessionState = await internalSessionState(widgetId)
  }
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
    warnings.push('tmux state is unknown; Aico will preserve the workload and refuse cleanup.')
  }
  const server = row.tmuxServerId ? getTmuxServer(row.tmuxServerId) : undefined
  const serverRuntimeState = server
    ? (tmuxServerRuntimeStates.get(server.id) ?? (server.phase === 'dead' ? 'dead' : 'ambiguous'))
    : null
  const serverResources = server ? await accountedScopeResources(server.scopeUnit) : null
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
      'Detached pane-exit monitoring is unavailable for this server; restart Aico before leaving work unattended.',
    )
  }
  if (!row.externalTmuxSession && row.lifecycleVersion < MANAGED_LIFECYCLE_VERSION) {
    warnings.push(
      'Legacy containment is preserved read-only. Create a new managed widget and move work deliberately; retirement stays blocked because historical descendants are unattributable.',
    )
  } else if (!row.externalTmuxSession && !row.scopeUnit) {
    warnings.push('Managed session has no narrow pane scope; whole-tree cleanup is unavailable.')
  }
  if (row.pendingScopeUnit) {
    warnings.push(`Former scope ${row.pendingScopeUnit} is still pending verified cleanup.`)
  }
  if (row.launchState === 'dispatched' && pane.pid !== null && isExactLaunchGateProcess(pane.pid)) {
    warnings.push(
      'A launch was dispatched but the pane still resembles its gate; Aico will not auto-replay it. Inspect before retrying manually.',
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

  return {
    capturedAt: new Date().toISOString(),
    ownership: {
      owner: row.externalTmuxSession ? 'external' : 'aico',
      workloadClass: row.externalTmuxSession ? 'external-durable-session' : 'durable-session',
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

// The directory a widget's pane should spawn in. A widget bound to a workspace
// uses the root cached on its row — a plain column read, resolved once at
// switch time, so no `st` subprocess runs on the session-create/respawn path.
// Personal Workspace is resolved locally and never falls through to the active
// repo; unbound/legacy widgets still fall back to the global `st` active project,
// then $HOME. A vanished project root falls through so a stale binding never
// strands the pane.
function cwdForWidget(widgetId: string): string {
  const row = getWidget(widgetId)
  if (row?.projectId === PERSONAL_WORKSPACE_ID) {
    return projectRoot(PERSONAL_WORKSPACE_ID) ?? process.env.HOME ?? homedir()
  }
  const root = row?.projectRoot
  if (root && isDir(root)) return root
  return widgetCwd()
}

// Detect the TUI actually running in a widget's pane from its live process tree.
// Async (off the main thread): reconcileWidgetTool runs this on every focus, and
// reading the full `ps` table synchronously there would stall the UI thread on
// each window switch. Best-effort — any failure resolves to undefined.
async function liveTuiForWidget(widgetId: string): Promise<ReturnType<typeof getTui>> {
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
// keeps the same widget session but Aico's stored `tool` slug can go stale. Use
// the live process tree to repair the titlebar/tray metadata on attach/focus.
// Resolves true when the stored slug changed, so callers can refresh the title.
async function reconcileWidgetTool(widgetId: string): Promise<boolean> {
  const row = getWidget(widgetId)
  if (!row) return false
  const live = await liveTuiForWidget(widgetId)
  if (!live || live.slug === row.tool) return false
  setWidgetTool(widgetId, live.slug)
  console.log(`[aico] reconciled ${widgetId} TUI metadata: ${row.tool} -> ${live.slug}`)
  return true
}

/** Reconcile a managed row whose exact server generation proves its session is
 * absent. This is callable while ensureSession already holds the lifecycle
 * token, so a closed widget can self-heal without waiting for an app restart. */
async function reconcileAbsentWidgetOwned(row: WidgetRow): Promise<WidgetRow | null> {
  if (row.externalTmuxSession || row.lifecycleVersion < MANAGED_LIFECYCLE_VERSION) return null
  if ((await internalSessionState(row.id)) !== 'absent') return null

  let current = getWidget(row.id)
  if (!current) return null
  if (current.pendingScopeUnit) {
    const clean = await stopOwnedPaneScope(
      current.pendingScopeUnit,
      current.pendingScopeInvocationId,
      `reopen pending reconciliation ${current.sessionId}`,
    )
    if (
      !clean ||
      !clearWidgetPendingScope(
        current.id,
        current.pendingScopeUnit,
        current.pendingScopeInvocationId,
      )
    ) {
      return null
    }
    current = getWidget(current.id)
    if (!current) return null
  }

  if (current.scopeUnit) {
    const clean = await stopOwnedPaneScope(
      current.scopeUnit,
      current.scopeInvocationId,
      `reopen reconciliation ${current.sessionId}`,
    )
    if (!clean) return null
  }
  if ((await internalSessionState(current.id)) !== 'absent') return null

  const latest = getWidget(current.id)
  if (!latest) return null
  const cleared = compareAndSetWidgetOwnership(latest.id, ownershipGeneration(latest), {
    ...ownershipGeneration(latest),
    scopeUnit: null,
    scopeInvocationId: null,
    tmuxSessionId: null,
    paneId: null,
    launchState: 'none',
    launchNonce: null,
  })
  if (!cleared) return null

  let reconciled = getWidget(latest.id)
  if (!reconciled) return null
  const server = reconciled.tmuxServerId ? getTmuxServer(reconciled.tmuxServerId) : undefined
  if (server?.phase === 'dead' && reconciled.tmuxServerId) {
    if (!clearReconciledDeadTmuxServerBinding(reconciled.id, reconciled.tmuxServerId)) return null
    reconciled = getWidget(reconciled.id)
  } else if (
    server?.kind === 'managed' &&
    server.phase === 'active' &&
    server.scopeUnit.endsWith('.scope') &&
    reconciled.tmuxServerId
  ) {
    if (!clearReconciledHistoricalTmuxServerBinding(reconciled.id, reconciled.tmuxServerId)) {
      return null
    }
    reconciled = getWidget(reconciled.id)
  }
  return reconciled ?? null
}

// Ensure the widget's tmux session exists, launching its TUI exactly once on
// first create. Reattaching a window finds the session already running and
// sends nothing — so a live agent is never relaunched. cwd is the widget's
// project root (per-widget binding, else the global `st` active project),
// captured when the session is first created; reattaching keeps wherever the
// agent already is.
async function ensureOwnedInternalSession(widgetId: string, size: PtySize): Promise<boolean> {
  let rowBeforeCreate = getWidget(widgetId)
  if (!rowBeforeCreate) return false
  retryUnresolvedPaneExitReconciliation(rowBeforeCreate.tmuxServerId)
  const state = await internalSessionState(widgetId)
  if (state === 'present') {
    const recovery = await recoverInterruptedManagedPane(rowBeforeCreate)
    if (recovery === 'blocked' || recovery === 'blocked-replay') {
      console.warn(
        `[aico:lifecycle] attaching ${widgetId} read/write without lifecycle authority: ` +
          (recovery === 'blocked-replay'
            ? 'an interrupted gate is preserved without replay; explicitly replace it to continue'
            : 'managed pane identity is ambiguous; replace/retire/replay remain blocked'),
      )
      const latest = getWidget(widgetId)
      if (latest?.pendingScopeUnit && !(await reconcileSupersededPendingScope(latest))) {
        console.warn(`[aico:lifecycle] pending cleanup remains blocked for ${latest.sessionId}`)
      }
    }
    return true // legacy reattach or exact managed recovery; never replay live work
  }
  if (state === 'unknown') {
    console.error(`[aico:lifecycle] tmux state unknown for ${widgetId}; refusing duplicate launch`)
    return false
  }
  if (
    rowBeforeCreate.lifecycleVersion >= MANAGED_LIFECYCLE_VERSION &&
    rowBeforeCreate.tmuxAllocationState === 'bound'
  ) {
    const reconciled = await reconcileAbsentWidgetOwned(rowBeforeCreate)
    if (!reconciled) {
      console.error(
        `[aico:lifecycle] absent ${rowBeforeCreate.sessionId} could not be reconciled safely`,
      )
      return false
    }
    rowBeforeCreate = reconciled
  }
  if (
    rowBeforeCreate.lifecycleVersion < MANAGED_LIFECYCLE_VERSION &&
    (rowBeforeCreate.tmuxAllocationState !== 'unallocated' ||
      rowBeforeCreate.tmuxSessionId ||
      rowBeforeCreate.paneId)
  ) {
    console.error(
      `[aico:lifecycle] refusing to recreate missing legacy ${rowBeforeCreate.sessionId}; ` +
        'its former broad-scope descendants are not attributable',
    )
    return false
  }
  if (!durableUserManager) {
    console.error(
      '[aico:lifecycle] user linger is not enabled; refusing a session that would die on logout',
    )
    return false
  }
  const cwd = cwdForWidget(widgetId)
  // Lifecycle ordering is deliberate: create a bare pane first, let tmux move it
  // into its dedicated cgroup, then launch the TUI through that contained shell.
  // Embedding the TUI in new-session lets it fork before tmux's asynchronous
  // cgroup move and was the path that put every tool in app-aico-9189.scope.
  const tool = getTui(rowBeforeCreate.tool ?? 'shell')
  const line = tool ? launchLine(tool) : null
  if (hasPersistedScopeCleanupEvidence(rowBeforeCreate)) {
    console.error(
      `[aico:lifecycle] refusing to recreate absent ${widgetId}: persisted scope cleanup is unresolved`,
    )
    return false
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
      // promote a gate carrying this widget's exact ownership markers.
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
      runInPaneTargetArgs(tmuxPaneTargetForWidget(widgetId), paneCommand(line)),
      {
        env: terminalClientEnv(),
        timeout: TMUX_QUERY_TIMEOUT_MS,
      },
    )
  } catch (e) {
    // No session to attach to; surface why rather than letting startPty's attach
    // fail into a blank terminal with no explanation.
    console.error(`[aico] failed to create tmux session for ${widgetId}:`, e)
    return false
  }
  // Verify-only; never blocks launch (a missing hook just means no mandates).
  if (tool && line) reportContext(widgetId, tool)
  return true
}

async function ensureSession(widgetId: string, size: PtySize): Promise<boolean> {
  if (isExternalTmuxWidget(widgetId)) {
    try {
      execFileSync(TMUX_BIN, hasTargetArgs(tmuxTargetForWidget(widgetId)), {
        env: terminalClientEnv(),
        timeout: TMUX_QUERY_TIMEOUT_MS,
        stdio: 'ignore',
      })
      return true
    } catch (e) {
      console.error(`[aico] external tmux session for ${widgetId} is unavailable:`, e)
      return false
    }
  }

  // Presence checks can recover and launch an interrupted gate, so even an
  // apparent reattach is a lifecycle mutation. Hold the same per-widget token
  // used by replace/retire for the entire decision and recovery sequence.
  const lifecycleOwner = lifecycleOwners.acquire(widgetId)
  if (!lifecycleOwner) return false
  const knownServerId = getWidget(widgetId)?.tmuxServerId
  try {
    return await ensureOwnedInternalSession(widgetId, size)
  } finally {
    // Reconciliation may deliberately clear a dead/historical server binding.
    // Retain the acquired generation so a pane-exit event deferred behind this
    // owner is queued after release rather than stranded by the successful CAS.
    releaseLifecycleOwner(widgetId, lifecycleOwner, knownServerId)
  }
}

function ensureSessionSerialized(widgetId: string, size: PtySize): Promise<boolean> {
  const current = sessionStartPromises.get(widgetId)
  if (current) return current
  const started = ensureSession(widgetId, size).finally(() => {
    if (sessionStartPromises.get(widgetId) === started) sessionStartPromises.delete(widgetId)
  })
  sessionStartPromises.set(widgetId, started)
  return started
}

// Verify a TUI's mandate-injection hook and surface the result to its widget
// window: a persistent titlebar status badge (green tick when mandates inject,
// red warning when they won't) plus a warning toast on a `missing` launch. (The
// core product guarantee is that agents launch with their mandates; a silent
// console.log the packaged-app user never sees let a genuinely-missing hook
// launch an unguarded agent unnoticed.) Always emits — the badge reflects the
// latest verified state. Verify-only; never blocks.
function reportContext(widgetId: string, tool: NonNullable<ReturnType<typeof getTui>>): void {
  ensureContext(tool)
    .then((s) => {
      console.log(`[aico] ${tool.slug} context ${s.state}: ${s.detail}`)
      windowForWidget(widgetId)?.webContents.send('context:mandate', {
        slug: tool.slug,
        state: s.state,
        detail: s.detail,
        // Whether this TUI even carries mandates. A bare shell / opencode / pi has
        // no hook, so the badge stays hidden for it (an "injecting" tick there
        // would be a lie); claude/codex/gemini/hermes do, so the badge shows.
        applicable: tool.context !== undefined,
      })
    })
    .catch(() => {})
}

// Respawn a live widget's pane (kills the current foreground program, fresh
// shell in the widget's current cwd) and relaunch `tool` in it. One pane = one
// foreground program, so both "Replace with <TUI>" and "Open workspace" go through
// here — mirroring ensureSession's launch, but for an already-running widget.
// The cwd is resolved now. Metadata changes are committed only after the new
// contained pane and its TUI launch both succeed, so UI/catalog state never
// claims a replacement that failed partway through.
async function respawnAndRelaunch(
  widgetId: string,
  tool: ReturnType<typeof getTui>,
  options: {
    cwd?: string
    projectId?: string | null
    commitMetadata?: () => void
  } = {},
): Promise<void> {
  if (isExternalTmuxWidget(widgetId)) {
    console.warn(`[aico] refusing to respawn externally-owned tmux session ${widgetId}`)
    return
  }
  const lifecycleOwner = lifecycleOwners.acquire(widgetId)
  if (!lifecycleOwner) {
    console.warn(`[aico:lifecycle] ${widgetId} already has a lifecycle operation in progress`)
    return
  }
  try {
    let previous = getWidget(widgetId)
    if (!previous) return
    const initialState = await internalSessionState(widgetId)
    if (initialState !== 'present') {
      console.error(
        `[aico:lifecycle] replacement blocked: tmux session state is ${initialState}; ` +
          'no persisted generation will be overwritten',
      )
      return
    }

    // An explicit replacement supersedes an interrupted gate; it must inspect
    // that gate but never replay the previously requested launcher first.
    const recovery = await recoverInterruptedManagedPane(previous, { dispatchGate: false })
    previous = getWidget(widgetId)
    if (!previous) return
    if (recovery === 'blocked') {
      if (previous.pendingScopeUnit) await reconcileSupersededPendingScope(previous)
      console.error(
        `[aico:lifecycle] replacement blocked: interrupted launch state for ${previous.sessionId} is ambiguous`,
      )
      return
    }

    let previousWasInertGate = false
    if (recovery === 'blocked-replay') {
      if (
        previous.pendingScopeUnit === previous.scopeUnit &&
        previous.pendingScopeInvocationId === previous.scopeInvocationId
      ) {
        console.error(
          `[aico:lifecycle] replacement blocked: ${previous.sessionId} has an inert gate in an ` +
            'unresolved same-scope respawn generation; create a new managed widget instead',
        )
        return
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
          `[aico:lifecycle] replacement blocked: interrupted gate for ${previous.sessionId} changed during verification`,
        )
        return
      }
    }

    // A prior crash can leave the former generation pending. Drain it only
    // after recovery proved which exact scope is current; never create a third tree.
    if (previous.pendingScopeUnit) {
      if (!(await reconcileSupersededPendingScope(previous))) {
        console.error(
          `[aico:lifecycle] replacement blocked by unresolved pending scope ${previous.pendingScopeUnit}`,
        )
        return
      }
      previous = getWidget(widgetId)
      if (!previous) return
    }

    if (!(await verifiedCurrentManagedPane(previous))) {
      console.error(
        `[aico:lifecycle] replacement blocked: current pane ownership is not exact for ${previous.sessionId}`,
      )
      return
    }
    const previousScope = previous.scopeUnit
    const previousScopeInvocationId = previous.scopeInvocationId
    if (!previousScope || !previousScopeInvocationId) return

    if (
      !setWidgetPendingScope(
        widgetId,
        ownershipGeneration(previous),
        previousScope,
        previousScopeInvocationId,
      )
    ) {
      console.error(
        `[aico:lifecycle] replacement blocked: ownership changed before pending scope persistence`,
      )
      return
    }
    const expected = getWidget(widgetId)
    if (!expected?.pendingScopeUnit) return

    const line = tool ? launchLine(tool) : null
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
        runInPaneTargetArgs(tmuxPaneTargetForWidget(widgetId), paneCommand(line)),
        { env: terminalClientEnv(), timeout: TMUX_QUERY_TIMEOUT_MS },
      )
      options.commitMetadata?.()
      if (tool && line) reportContext(widgetId, tool)
    } catch (error) {
      // Never kill an unrecorded gate: its markers + tmux identity are the
      // recovery handle. The old exact scope remains pending until promotion.
      console.error(`[aico] failed to respawn pane for ${widgetId}:`, error)
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
  } finally {
    releaseLifecycleOwner(widgetId, lifecycleOwner)
  }
}

// Replace whatever runs in a live widget's pane with `slug`'s TUI ("Replace
// with <TUI>"). The stored tool is updated so a later kill+recreate relaunches it.
function loadTui(widgetId: string, slug: string): void {
  const tool = getTui(slug)
  if (!tool) return
  void respawnAndRelaunch(widgetId, tool, {
    commitMetadata: () => {
      setWidgetTool(widgetId, slug)
      pushTitles()
      syncTray()
    },
  })
}

// Move a live widget to another workspace ("Open workspace ▸"): resolve the
// project/workspace root once, cache it on the row, then respawn the pane there
// and relaunch the SAME tool it's already running. This does NOT touch the global
// `st` pointer — other widgets and brand-new ones are unaffected.
function switchProject(widgetId: string, projectId: string): void {
  const root = projectRoot(projectId)
  if (!root) console.warn(`[aico] workspace ${projectId} root unresolved; using default cwd`)
  const cwd = root && isDir(root) ? root : widgetCwd()
  void respawnAndRelaunch(widgetId, getTui(getWidget(widgetId)?.tool ?? 'shell'), {
    cwd,
    projectId,
    commitMetadata: () => {
      setWidgetProject(widgetId, projectId, root)
      pushTitles()
      syncTray()
    },
  })
}

async function startPty(win: BrowserWindow, size: PtySize): Promise<void> {
  const widgetId = widgetOf.get(win.id)
  if (!widgetId) return
  const generation = (ptyStartGenerations.get(win.id) ?? 0) + 1
  ptyStartGenerations.set(win.id, generation)
  const existing = ptys.get(win.id)
  if (existing) {
    existing.kill() // detaches the client; tmux session persists
    ptys.delete(win.id)
  }
  const ready = await ensureSessionSerialized(widgetId, size)
  const stillCurrent =
    !win.isDestroyed() &&
    widgetOf.get(win.id) === widgetId &&
    ptyStartGenerations.get(win.id) === generation
  if (!ready || !stillCurrent) {
    if (!ready && stillCurrent) {
      win.webContents.send(
        'pty:data',
        '\r\n\u001b[31mAico safety stop: tmux ownership could not be verified. ' +
          'No agent was launched; copy diagnostics or inspect the lifecycle log.\u001b[0m\r\n',
      )
    }
    return
  }
  // Non-blocking: repair stale TUI metadata from the live process tree, then
  // refresh the titlebar if it changed. The attach below proceeds immediately.
  void reconcileWidgetTool(widgetId).then((changed) => {
    if (changed) pushTitles()
  })
  const pty = spawn(TMUX_BIN, attachTargetArgs(tmuxTargetForWidget(widgetId)), {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: process.env.HOME,
    env: terminalClientEnv(),
  })
  if (ptyStartGenerations.get(win.id) !== generation || win.isDestroyed()) {
    pty.kill()
    return
  }
  pty.onData((data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('pty:data', data)
    }
  })
  pty.onExit(() => {
    // Only clear the map if this is still the current pty: a prior pty we killed
    // on re-attach can fire its exit after the replacement is stored, and an
    // unconditional delete would drop the live entry (orphaning it).
    if (ptys.get(win.id) === pty) {
      ptys.delete(win.id)
      if (!quitting) {
        const row = getWidget(widgetId)
        if (row) void reconcileManagedWidget(row)
      }
    }
  })
  ptys.set(win.id, pty)
}

function ptyFor(sender: Electron.WebContents): IPty | undefined {
  const win = BrowserWindow.fromWebContents(sender)
  return win ? ptys.get(win.id) : undefined
}

// Persist a window's bounds (and which monitor it's on) so it restores in place.
function persistBounds(win: BrowserWindow): void {
  const widgetId = widgetOf.get(win.id)
  if (!widgetId || win.isDestroyed() || !hasWidget(widgetId)) return
  const bounds = win.getBounds()
  saveBounds(widgetId, bounds, String(screen.getDisplayMatching(bounds).id))
}

function scheduleBoundsSave(win: BrowserWindow): void {
  const prev = boundsTimers.get(win.id)
  if (prev) clearTimeout(prev)
  boundsTimers.set(
    win.id,
    setTimeout(() => persistBounds(win), 400),
  )
}

// Restore a saved rect only if it still lands on a connected display; otherwise
// keep just the size and let the OS place it (avoids off-screen windows).
function placement(row: WidgetRow): Electron.BrowserWindowConstructorOptions {
  const b = row.bounds
  if (!b) return { width: 900, height: 560 }
  const onScreen = screen.getAllDisplays().some(({ workArea: w }) => {
    return (
      b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y
    )
  })
  return onScreen
    ? { x: b.x, y: b.y, width: b.width, height: b.height }
    : { width: b.width, height: b.height }
}

function openWidget(row: WidgetRow): void {
  const win = new BrowserWindow({
    ...placement(row),
    minWidth: 360,
    minHeight: 240,
    // Keep the frameless Lantern chrome, but make the native surface opaque.
    // These windows are often nearly full-height on a scaled 4K display; a
    // transparent surface made Chromium alpha-composite every terminal repaint
    // across tens of millions of pixels even though only the 8px rim used alpha.
    frame: false,
    transparent: false,
    backgroundColor: '#0B0D11',
    icon: join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      // Renderer runs in the OS sandbox. The preload is a pure contextBridge shim
      // (requires only electron's contextBridge/ipcRenderer, both available to a
      // sandboxed CommonJS preload), so nothing here needs Node at module scope.
      sandbox: true,
      // Keep Chromium's default background throttling. Three idle Aico windows
      // previously kept the GPU process near one-third of a core solely so the
      // cosmetic eyes could repaint at 60 ms while unfocused.
      backgroundThrottling: true,
    },
  })

  // Fixed local UI: no popups, and never navigate the frame away from the
  // renderer. Defense-in-depth so a renderer compromise can't open or redirect
  // to arbitrary content.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('console-message', (details) => {
    if (details.level !== 'warning' && details.level !== 'error') return
    const log = details.level === 'error' ? console.error : console.warn
    log(
      `[aico:renderer] widget=${row.id} ${details.level} ` +
        `${details.sourceId || 'unknown'}:${details.lineNumber} ${details.message}`,
    )
  })
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        console.error(
          `[aico:renderer] widget=${row.id} load failed code=${errorCode} ` +
            `url=${validatedURL}: ${errorDescription}`,
        )
      }
    },
  )
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[aico:renderer] widget=${row.id} process gone reason=${details.reason} ` +
        `exit_code=${details.exitCode}`,
    )
  })

  const winId = win.id
  const widgetId = row.id
  widgetOf.set(winId, widgetId)
  setOpen(widgetId, true)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Make the mandate badge authoritative for THIS window the instant it loads,
  // not only when a TUI is freshly launched. On an aico restart we reattach to a
  // live tmux session WITHOUT relaunching (ensureSession returns early), so the
  // launch-time context:mandate never fires for a reattached pane — the badge
  // would otherwise be frozen at its hidden default and could never warn. The
  // fresh-launch path re-reports the same state moments later; this is idempotent.
  win.webContents.once('did-finish-load', () => {
    const tool = getTui(getWidget(widgetId)?.tool ?? 'shell')
    if (tool) reportContext(widgetId, tool)
  })

  // Renderer toggles the focused/unfocused chrome state off these. Focus also
  // records this widget as the selection-grab target ("last-focused widget").
  win.on('focus', () => {
    const widgetId = widgetOf.get(win.id)
    lastFocusedAico = widgetId ?? lastFocusedAico
    if (widgetId) {
      void reconcileWidgetTool(widgetId).then((changed) => {
        if (changed) pushTitles()
      })
    }
    win.webContents.send('win:focus', true)
    blurredWins.delete(win.id)
    syncCursorPump()
  })
  win.on('blur', () => {
    win.webContents.send('win:focus', false)
    blurredWins.add(win.id)
    syncCursorPump()
  })

  win.on('move', () => scheduleBoundsSave(win))
  win.on('resize', () => scheduleBoundsSave(win))
  win.on('close', () => persistBounds(win)) // final flush while bounds are still valid

  win.on('closed', () => {
    const pty = ptys.get(winId)
    if (pty) {
      pty.kill() // detach; tmux session persists (close = keep, reopenable)
      ptys.delete(winId)
    }
    const timer = boundsTimers.get(winId)
    if (timer) {
      clearTimeout(timer)
      boundsTimers.delete(winId)
    }
    setWidgetActivity(winId, false)
    widgetOf.delete(winId)
    ptyStartGenerations.delete(winId)
    blurredWins.delete(winId)
    syncCursorPump()
    // On quit, leave `open` as-is so live widgets restore next launch; on an
    // explicit close, mark it closed (it moves to the tray's reopen list).
    if (!quitting && hasWidget(widgetId)) setOpen(widgetId, false)
    syncTray()
  })

  syncTray()
}

// Create a widget running `tool`, bound to `projectId` from the moment it's
// born: the project's root is resolved once here (the same deliberate `st` call
// switchProject makes) and cached on the row, so the pane spawns in that dir and
// the titlebar reads that project — neither follows the global pointer later. A
// root that won't resolve still binds the id (cwd then falls back, never strands).
function newWidget(tool: string, projectId: string): void {
  const id = newWidgetId()
  const row = insertWidget(id, true, tool)
  const root = projectRoot(projectId)
  if (!root) console.warn(`[aico] workspace ${projectId} root unresolved; using default cwd`)
  setWidgetProject(id, projectId, root)
  openWidget(row)
}

interface AttachableTmuxSession {
  id: string
  label: string
  source: string
  socket: string | null
  session: string
  cwd: string | null
  command: string
  tool: string
}

function listAttachableTmuxSessions(): AttachableTmuxSession[] {
  let out = ''
  try {
    out = execFileSync(TMUX_BIN, listDefaultPanesArgs(), {
      encoding: 'utf8',
      env: terminalClientEnv(),
      timeout: TMUX_QUERY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return []
  }

  const bySession = new Map<string, AttachableTmuxSession>()
  for (const line of out.split('\n')) {
    const [sessionName, _paneId, cwd, command] = line.split('\t')
    if (!sessionName || !isATermSessionName(sessionName)) continue
    const existing = bySession.get(sessionName)
    if (existing?.cwd) continue
    const liveTui = detectTuiFromProcessNames(listTuis(), [command || ''])
    bySession.set(sessionName, {
      id: `default:${sessionName}`,
      label: `A-Term ${sessionName.slice(A_TERM_SESSION_PREFIX.length, A_TERM_SESSION_PREFIX.length + 8)}`,
      source: 'A-Term',
      socket: null,
      session: sessionName,
      cwd: cwd || null,
      command: command || 'shell',
      tool: liveTui?.slug ?? 'shell',
    })
  }
  return [...bySession.values()].sort((a, b) => a.label.localeCompare(b.label))
}

function findWidgetByTmuxTarget(target: TmuxTarget): WidgetRow | undefined {
  return listWidgets().find(
    (row) =>
      row.externalTmuxSession === target.session &&
      (row.externalTmuxSocket ?? null) === target.socket,
  )
}

function attachExternalTmuxSession(attachableId: string): void {
  const session = listAttachableTmuxSessions().find((item) => item.id === attachableId)
  if (!session) return
  const target = { socket: session.socket, session: session.session }
  const existing = findWidgetByTmuxTarget(target)
  if (existing) {
    focusOrReopen(existing.id)
    return
  }
  const row = insertExternalWidget(
    newWidgetId(),
    true,
    session.socket,
    session.session,
    session.label,
    session.tool,
  )
  openWidget(row)
}

function focusOrReopen(id: string): void {
  if (lifecycleOwners.isHeld(id)) {
    console.warn(`[aico:lifecycle] refusing reopen while ${id} cleanup is in progress`)
    return
  }
  const win = windowForWidget(id)
  if (win) {
    win.show()
    win.focus()
    return
  }
  const row = getWidget(id)
  if (row) openWidget(row)
}

function discardWidget(id: string): void {
  widgetRetireIntents.request(id)
  drainWidgetRetire(id)
}

function drainWidgetRetire(id: string): void {
  const lifecycleOwner = widgetRetireIntents.take(id, lifecycleOwners)
  if (!lifecycleOwner) return
  void discardWidgetOwned(id, lifecycleOwner)
}

function surfaceLifecycleBlock(widgetId: string, message: string): void {
  console.error(`[aico:lifecycle] ${message}`)
  windowForWidget(widgetId)?.webContents.send(
    'pty:data',
    `\r\n\u001b[31mAico safety stop: ${message}\u001b[0m\r\n`,
  )
}

async function confirmTrayDiscard(id: string): Promise<void> {
  const row = getWidget(id)
  if (!row) return
  const external = Boolean(row.externalTmuxSession)
  const response = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', external ? 'Forget attachment' : 'Retire session'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: external ? 'Forget tmux attachment?' : 'Retire durable session?',
    message: external
      ? `Forget Aico's attachment to ${row.name || row.externalTmuxSession}?`
      : `Retire ${row.name || row.sessionId}?`,
    detail: external
      ? 'The externally owned tmux session will keep running.'
      : 'This stops only this session’s verified workload scope. This cannot be undone.',
  })
  if (response.response === 1) discardWidget(id)
}

async function discardWidgetOwned(id: string, lifecycleOwner: LifecycleOwnerToken): Promise<void> {
  let knownServerId: string | null | undefined
  try {
    let row = getWidget(id)
    if (!row) return
    knownServerId = row.tmuxServerId
    if (!row.externalTmuxSession && row.lifecycleVersion < MANAGED_LIFECYCLE_VERSION) {
      // Killing a legacy tmux pane can leave unattributable descendants in the
      // historical broad app scope. Preserve the session and require an explicit
      // managed replacement first; never destroy work and then discover cleanup
      // authority is unavailable.
      surfaceLifecycleBlock(
        id,
        `legacy ${row.sessionId} is preserved read-only; create a new managed widget and move work deliberately because historical descendants cannot be attributed safely`,
      )
      return
    }
    if (row.externalTmuxSession) {
      // Aico only owns the attachment/catalog row, never the external session.
      removeWidget(id)
      windowForWidget(id)?.destroy()
      return
    }

    const before = await internalSessionState(id)
    if (before === 'unknown') {
      surfaceLifecycleBlock(id, `retaining ${row.sessionId}: tmux state is unknown`)
      return
    }
    if (before === 'present') {
      if (!(await verifiedCurrentManagedPane(row))) {
        surfaceLifecycleBlock(
          id,
          `retaining ${row.sessionId}: current session/pane/scope identity is not exact`,
        )
        return
      }
      try {
        await execFileAsync(TMUX_BIN, killTargetArgs(tmuxTargetForWidget(id)), {
          env: terminalClientEnv(),
          timeout: TMUX_QUERY_TIMEOUT_MS,
        })
      } catch (error) {
        console.warn(`[aico:lifecycle] tmux stop failed for session=${row.sessionId}:`, error)
      }
      await settleServerAfterSessionStop(row)
    }
    const afterTmux = await internalSessionState(id)
    if (afterTmux !== 'absent') {
      // Unknown is as protective as present: neither authorizes scope cleanup.
      surfaceLifecycleBlock(id, `retaining ${row.sessionId}: tmux state after stop is ${afterTmux}`)
      return
    }

    const afterSession = getWidget(id)
    if (!afterSession) return
    row = afterSession
    const pendingScope = classifyPersistedScopePair(
      row.pendingScopeUnit,
      row.pendingScopeInvocationId,
    )
    if (pendingScope.state === 'malformed') {
      surfaceLifecycleBlock(id, `retaining ${row.sessionId}: pending scope identity is malformed`)
      return
    }
    if (pendingScope.state === 'paired') {
      const pendingClean = await stopOwnedPaneScope(
        pendingScope.scopeUnit,
        pendingScope.scopeInvocationId,
        `retire pending generation ${row.sessionId}`,
      )
      if (!pendingClean) {
        surfaceLifecycleBlock(id, `retaining ${row.sessionId}: pending scope cleanup failed`)
        return
      }
      if (!clearWidgetPendingScope(id, pendingScope.scopeUnit, pendingScope.scopeInvocationId)) {
        surfaceLifecycleBlock(id, `retaining ${row.sessionId}: pending ownership changed`)
        return
      }
      const afterPending = getWidget(id)
      if (!afterPending) return
      row = afterPending
    }

    const currentScope = classifyPersistedScopePair(row.scopeUnit, row.scopeInvocationId)
    if (currentScope.state === 'malformed') {
      surfaceLifecycleBlock(id, `retaining ${row.sessionId}: owned scope identity is malformed`)
      return
    }
    if (currentScope.state === 'absent' && !isReconciledSessionOwnershipAbsent(row)) {
      surfaceLifecycleBlock(
        id,
        `retaining ${row.sessionId}: scope is absent before session ownership was reconciled`,
      )
      return
    }
    if (currentScope.state === 'paired') {
      const clean = await stopOwnedPaneScope(
        currentScope.scopeUnit,
        currentScope.scopeInvocationId,
        `retire session ${row.sessionId}`,
      )
      if (!clean) {
        surfaceLifecycleBlock(id, `retaining ${row.sessionId}: owned scope cleanup failed`)
        return
      }
    }
    if ((await internalSessionState(id)) !== 'absent') {
      surfaceLifecycleBlock(id, `retaining ${row.sessionId}: session reappeared during cleanup`)
      return
    }
    const latest = getWidget(id)
    if (!latest) return
    if (latest.scopeUnit !== row.scopeUnit || latest.scopeInvocationId !== row.scopeInvocationId) {
      surfaceLifecycleBlock(id, `retaining ${row.sessionId}: owned scope identity changed`)
      return
    }
    if (
      classifyPersistedScopePair(latest.pendingScopeUnit, latest.pendingScopeInvocationId).state !==
      'absent'
    ) {
      surfaceLifecycleBlock(id, `retaining ${row.sessionId}: pending cleanup evidence reappeared`)
      return
    }
    const removed = removeWidgetIfOwnership(id, ownershipGeneration(row))
    if (!removed) {
      surfaceLifecycleBlock(id, `retaining ${row.sessionId}: ownership generation changed`)
      return
    }
    // Keep the recovery surface alive until both exact cgroups are proven empty
    // and the guarded catalog delete commits. A failed retirement must never
    // disappear into the tray and invite recreation over unresolved evidence.
    windowForWidget(id)?.destroy()
    console.log(`[aico:lifecycle] retired session=${row.sessionId} scope=${row.scopeUnit}`)
    logWidgetEvent(id, 'lifecycle_retired', {
      session_id: row.sessionId,
      scope_unit: row.scopeUnit,
      scope_invocation_id: row.scopeInvocationId,
    })
  } finally {
    widgetRetireIntents.complete(id)
    releaseLifecycleOwner(id, lifecycleOwner, knownServerId)
    syncTray()
  }
}

// Hub view: surface every widget. Shared by the tray and the in-widget control
// surface so both stay one behavior. (Phase 1 replaces this with the cascade grid.)
function showHub(): void {
  for (const win of BrowserWindow.getAllWindows()) win.show()
}

function syncTray(): void {
  const projects = listProjects() // titlebar name fallback + the New-widget submenu
  const attachables = listAttachableTmuxSessions()
  const widgets: TrayWidget[] = listWidgets().map((w) => ({
    id: w.id,
    label: w.name || widgetProjectName(w, projects) || `Widget ${w.seq}`,
    open: windowForWidget(w.id) !== undefined,
  }))
  refreshTray(widgets, projects, attachables)
}

// The workspace an unnamed widget reads as: the one it's bound to (pinned at
// creation, or last "Open workspace"). Used only as the title fallback, so a
// widget shows its actual workspace instead of a bare ordinal — and never drifts
// with the global pointer. null for an unbound/legacy row (⇒ `Widget ${seq}`).
function widgetProjectName(row: WidgetRow, projects: ProjectInfo[]): string | null {
  if (!row.projectId) return null
  return projects.find((p) => p.id === row.projectId)?.name ?? null
}

// Push titlebar info to every open window: the widget's name (custom, else its
// workspace, else `Widget ${seq}`) shown centered, plus its TUI's SVG mark + accent
// (drawn between the eyes). All of it changes only on Aico events — attach, rename,
// "Replace with <TUI>", "Open workspace" — so this is event-driven, not polled.
function pushTitles(): void {
  const projects = listProjects() // cached; never blocks this event path
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const widgetId = widgetOf.get(win.id)
    const row = widgetId ? getWidget(widgetId) : undefined
    if (!row) continue
    const tui = getTui(row.tool) ?? getTui('shell')
    win.webContents.send('win:title', {
      // Custom name wins (a prior edit is never overwritten); otherwise track
      // the live project so the bar follows whatever's loaded.
      label: row.name || widgetProjectName(row, projects) || `Widget ${row.seq}`,
      name: row.name, // custom name (or null) — prefills the rename input
      icon: tui?.icon ?? '',
      accent: tui?.accent ?? '',
      tuiName: tui?.displayName ?? '',
      tuiSlug: tui?.slug ?? 'shell',
    })
  }
}

// Adopt any live `aico-*` tmux sessions not yet in the catalog as closed
// widgets, preserving their creation time — so sessions from before this
// catalog existed (and any external strays) stay reachable via the tray.
function adoptOrphans(): void {
  for (const server of listTmuxServers()) {
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
  if (row.externalTmuxSession) return
  const lifecycleOwner = lifecycleOwners.acquire(row.id)
  if (!lifecycleOwner) {
    if (row.tmuxServerId) paneExitDeferredServers.add(row.tmuxServerId)
    console.warn(`[aico:lifecycle] deferring reconciliation for busy widget ${row.id}`)
    return
  }
  const knownServerId = getWidget(row.id)?.tmuxServerId ?? row.tmuxServerId
  try {
    let current = getWidget(row.id)
    if (!current) return
    if (current.tmuxServerId) {
      const server = getTmuxServer(current.tmuxServerId)
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
      console.warn(`[aico:lifecycle] preserving ${current.sessionId}: tmux state is unknown`)
      return
    }

    if (state === 'present') {
      const recovery = await recoverInterruptedManagedPane(current)
      if (recovery === 'blocked' || recovery === 'blocked-replay') {
        const latest = getWidget(current.id)
        if (latest?.pendingScopeUnit) await reconcileSupersededPendingScope(latest)
        console.warn(
          `[aico:lifecycle] preserving ${current.sessionId}: ` +
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
            `[aico:lifecycle] preserving legacy pending ${pending}: live pane scope is unknown`,
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
          `[aico:lifecycle] preserving ${current.sessionId}: live pane scope is unverified`,
        )
        return
      }

      if (current.pendingScopeUnit && !(await reconcileSupersededPendingScope(current))) {
        console.warn(
          `[aico:lifecycle] preserving unresolved pending generation for ${current.sessionId}`,
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
        `[aico:lifecycle] reconciling abandoned scope=${current.scopeUnit} session=${current.sessionId}`,
      )
      logWidgetEvent(current.id, 'lifecycle_reconcile_abandoned', {
        session_id: current.sessionId,
        scope_unit: current.scopeUnit,
        scope_invocation_id: current.scopeInvocationId,
      })
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

async function reconcileAbandonedScopes(): Promise<void> {
  // Sequential startup keeps tmux/systemd load bounded and makes each row's
  // ownership transition independently observable in logs.
  for (const row of listWidgets()) await reconcileManagedWidget(row, true)
}

async function restoreOnLaunch(): Promise<void> {
  await reconcileAbandonedScopes()
  adoptOrphans()
  const all = listWidgets() // oldest first
  const open = all.filter((w) => w.open)
  if (open.length) {
    open.forEach(openWidget)
  } else if (all.length) {
    openWidget(all[0]) // nothing was open: bring back the oldest (the historical primary)
  }
  // Empty catalog: no widget to auto-launch (a launch now needs an explicit
  // TUI + project). The tray's "New widget ▸ TUI ▸ project" menu starts the first.
}

// The widget that should receive an indicated selection: the last-focused one
// if it's still open, else the most recently created open widget.
function selectionTarget(): string | undefined {
  if (lastFocusedAico && windowForWidget(lastFocusedAico)) return lastFocusedAico
  const open = listWidgets().filter((w) => windowForWidget(w.id))
  return open.length ? open[open.length - 1].id : undefined
}

// Shared deliver path for every trigger (X11 hotkey + browser-driven SSE):
// insert a compact reference at the target widget's prompt (no Enter — the user
// adds their ask and submits), then flash a toast. Best-effort: empty payload or
// no open widget no-ops silently.
function deliverSelection(records: SelectionRecord[]): void {
  const usable = records.filter((r) => r?.kind && r.kind !== 'empty')
  if (!usable.length) return
  const targetId = selectionTarget()
  if (!targetId) return
  if (lifecycleOwners.isHeld(targetId)) {
    console.warn(`[aico:lifecycle] selection insert dropped while ${targetId} changes generation`)
    windowForWidget(targetId)?.webContents.send('selection:toast', {
      kind: 'Session changing',
      snippet: 'Selection was not inserted while the terminal was being replaced.',
    })
    return
  }
  try {
    execFileSync(
      TMUX_BIN,
      sendTextTargetArgs(tmuxPaneTargetForWidget(targetId), compactRef(usable)),
    )
  } catch (err) {
    console.warn('[aico] selection insert failed:', err)
    return
  }
  const win = windowForWidget(targetId)
  if (win) {
    win.show()
    win.focus()
    const head = usable[0]
    win.webContents.send('selection:toast', {
      kind: usable.length > 1 ? `${usable.length} items` : head.kind,
      snippet: usable.length > 1 ? usable.map((r) => r.snippet ?? '').join(' · ') : head.snippet,
    })
  }
}

// Push-to-talk: route the toggle to the widget the user is talking to — the
// focused Aico window, falling back to the same target the selection bus uses
// (last-focused open widget). That renderer owns the mic capture + insert.
function toggleVoice(): void {
  const focused = BrowserWindow.getFocusedWindow()
  const win =
    focused && widgetOf.has(focused.id) ? focused : windowForWidget(selectionTarget() ?? '')
  win?.webContents.send('voice:toggle')
}

// "Indicate" hotkey (X11 fallback for non-web sources): harvest the freshest
// capture from the bus and deliver it. Browser sends arrive via SSE instead.
async function selectionGrab(): Promise<void> {
  try {
    const res = await fetch(`http://${sidecarHost}:${sidecarPort}/selection/current`)
    if (!res.ok) return
    deliverSelection([(await res.json()) as SelectionRecord])
  } catch {
    // sidecar unreachable — best-effort
  }
}

// Run a desktop grab from a click (the menu rows). The same `scripts/aico-grab.sh`
// the global hotkeys fire, but invoked deliberately: clicking a window grab passes
// `-p` so the user picks the target window (the focused window is Aico's menu, so a
// bare focused-window grab would only ever shoot Aico), and a region grab passes
// `-r`. Env mirrors the hotkey install: keep a usable DISPLAY fallback and
// prepend common user bin dirs where optional capture tools may live.
// Resolve a bundled `scripts/` file to a real on-disk path bash can exec. When
// packaged, scripts/ is asar-unpacked (a script inside app.asar can't be run by
// a child process), so point at the unpacked mirror under resources.
function scriptsRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
}

function runDesktopGrab(args: string[]): void {
  const script = join(scriptsRoot(), 'scripts', 'aico-grab.sh')
  const home = homedir()
  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':0',
    PATH: `${home}/bin:${home}/.local/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
  }
  execFile('bash', [script, ...args], { env }, (err) => {
    if (err) console.warn('[aico] desktop grab failed:', err.message)
  })
}

// Subscribe to the sidecar's deliver-event stream so a browser-side "send"
// (extension pill / right-click / picker) reaches the same insert path as the
// hotkey. Reconnects with backoff across sidecar restarts; cancelled on quit.
// This is also the Wayland-safe trigger (a CLI POST to /selection/send fires it).
function subscribeSelectionEvents(): void {
  selectionEvents = new AbortController()
  const url = `http://${sidecarHost}:${sidecarPort}/selection/events`
  void (async () => {
    while (!quitting) {
      try {
        const res = await fetch(url, { signal: selectionEvents?.signal })
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const { events, rest } = parseSse(buf)
          buf = rest
          for (const data of events) {
            try {
              const payload = JSON.parse(data) as { records?: SelectionRecord[] }
              if (payload.records?.length) deliverSelection(payload.records)
            } catch {
              // malformed frame — skip
            }
          }
        }
      } catch {
        if (quitting || selectionEvents?.signal.aborted) return
      }
      await new Promise((r) => setTimeout(r, 1000)) // backoff before reconnect
    }
  })()
}

// Lock the renderer to a strict CSP in production (the packaged file:// app).
// Dev (ELECTRON_RENDERER_URL) is skipped: Vite's HMR needs inline/eval and its
// own websocket. connect-src is opened only to the voice WS; everything else is
// 'self'. Defense-in-depth so a renderer XSS can't reach arbitrary origins.
function installContentSecurityPolicy(): void {
  if (process.env.ELECTRON_RENDERER_URL) return // dev server: leave Vite's needs alone
  let wsOrigin = ''
  try {
    const u = new URL(VOICE_WS_URL)
    wsOrigin = `${u.protocol}//${u.host}`
  } catch {
    // malformed override — connect-src stays 'self' only
  }
  const csp = [
    "default-src 'self'",
    "script-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'", // xterm.js injects a <style> for theming
    "img-src 'self' data:", // inline SVG marks + the chrome noise data: URI
    "font-src 'self'",
    `connect-src 'self'${wsOrigin ? ` ${wsOrigin}` : ''}`, // voice WS only
    "worker-src 'self' blob:", // voice audio worklet
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ')
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

function startSidecar(): void {
  // Packaged: spawn the bundled PyInstaller executable from resources (no Python
  // needed). Dev: `app.getAppPath()` is the repo root, so resolvePython finds the
  // .venv and runs `-m aico_sidecar`. The packaged spawn cwd is a real directory
  // (resourcesPath) since app.asar isn't a chdir-able path.
  const packaged = app.isPackaged
  const repoRoot = packaged ? process.resourcesPath : app.getAppPath()
  const command = packaged ? bundledSidecar(process.resourcesPath) : undefined
  const args = packaged ? [] : undefined
  sidecar = new Sidecar(
    { host: sidecarHost, port: sidecarPort, repoRoot, stateDir, command, args },
    (status, detail) => console.log(`[aico] sidecar ${status}${detail ? `: ${detail}` : ''}`),
  )
  // Fire-and-forget: widgets render against tmux without the sidecar, so don't
  // gate the UI on it; the health result is logged via onStatus.
  sidecar.start().catch((err) => console.warn('[aico] sidecar start failed:', err))
}

let signalQuitRequested = false
function requestGracefulSignalQuit(signal: NodeJS.Signals): void {
  if (signalQuitRequested) return
  signalQuitRequested = true
  console.log(`[aico:lifecycle] graceful ${signal} shutdown requested`)
  app.quit()
}
process.on('SIGTERM', () => requestGracefulSignalQuit('SIGTERM'))
process.on('SIGINT', () => requestGracefulSignalQuit('SIGINT'))

app.on('before-quit', () => {
  quitting = true
  // A secondary instance (single-instance lock denied) quits before the app is
  // ready, where globalShortcut would throw; it never registered any anyway.
  if (app.isReady()) globalShortcut.unregisterAll()
  selectionEvents?.abort()
  paneExitFsWatcher?.close()
  paneExitFsWatcher = null
  paneExitEventReady.clear()
  sidecar?.stop()
})

// Single-instance lock: a second launch must not spawn a duplicate (it would
// fight over the sidecar port :8005 and re-adopt the same widget catalog). The
// secondary quits immediately; the primary surfaces its widgets instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  for (const win of BrowserWindow.getAllWindows()) win.show()
  BrowserWindow.getAllWindows()[0]?.focus()
})

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return // secondary instance: app.quit() is pending
  registerBuiltinTuis()
  ensureTmuxConf()
  initStore(dbPath)
  await reconcileTmuxServers()
  durableUserManager = detectDurableUserManager()
  console.log(
    `[aico:lifecycle] durable user manager: ${
      durableUserManager ? 'linger enabled' : 'unavailable; new sessions blocked'
    }`,
  )
  installContentSecurityPolicy()
  startSidecar()

  // Project names render from the cache; repaint whenever a background `st`
  // read lands (including the startup prime below).
  onProjectsRefreshed(() => {
    pushTitles()
    syncTray()
  })
  void refreshProjects()

  // No application menu — the Lantern chrome owns window controls, and the
  // default Edit menu's paste role mangled bracketed paste (handled in renderer).
  Menu.setApplicationMenu(null)

  ipcMain.on('pty:start', (event, size: PtySize) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      void startPty(win, clampSize(size))
        .then(() => pushTitles()) // fill the titlebar once the session is attached
        .catch((error) => console.error('[aico:lifecycle] PTY start failed:', error))
    }
  })

  ipcMain.on('pty:input', (event, data: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const widgetId = win ? widgetOf.get(win.id) : undefined
    // Replacement temporarily exposes the no-RC containment gate through the
    // existing tmux attachment. Never let renderer bytes corrupt or execute a
    // partially staged launcher; stale user input is dropped rather than queued.
    if (!widgetId || lifecycleOwners.isHeld(widgetId)) return
    ptyFor(event.sender)?.write(data)
  })

  ipcMain.on('pty:resize', (event, size: PtySize) => {
    const pty = ptyFor(event.sender)
    if (pty) {
      const { cols, rows } = clampSize(size)
      try {
        pty.resize(cols, rows)
      } catch (err) {
        console.warn('[aico] pty resize failed:', err)
      }
    }
  })

  // Manual Refresh: tmux holds the authoritative grid, so force every client
  // attached to this widget's session to repaint from it — recovering an xterm
  // view that desynced (resize-reflow race, WebGL glitch, dropped/duped bytes).
  // Best-effort: a missing session or no clients is a no-op, never a crash.
  ipcMain.on('pty:refresh', (event, size?: PtySize) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const widgetId = win ? widgetOf.get(win.id) : undefined
    if (!widgetId) return
    // Re-pair a drifted pty before the repaint: if the pty's size disagrees
    // with the renderer's live grid, tmux paints for the wrong geometry and
    // every repaint wrap-garbles — the one corruption refresh-client can't
    // repair (reopening the window used to be the only fix). Logged so a
    // recurrence pins down which path let the sizes diverge.
    const pty = ptyFor(event.sender)
    if (pty && size) {
      const { cols, rows } = clampSize(size)
      if (pty.cols !== cols || pty.rows !== rows) {
        console.warn(
          `[aico] refresh: size desync (pty ${pty.cols}x${pty.rows}, term ${cols}x${rows}); re-pairing`,
        )
        try {
          pty.resize(cols, rows)
        } catch (err) {
          console.warn('[aico] pty resize failed:', err)
        }
      }
    }
    const target = tmuxTargetForWidget(widgetId)
    try {
      const out = execFileSync(TMUX_BIN, listClientsTargetArgs(target), { encoding: 'utf8' })
      for (const client of out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)) {
        execFileSync(TMUX_BIN, refreshClientArgs(client, target.socket), { stdio: 'ignore' })
      }
    } catch (err) {
      console.warn('[aico] pty refresh failed:', err)
    }
  })

  // Full scrollback for the renderer's read-only overlay. tmux history is the
  // source of truth (an attached tmux client has no xterm-side scrollback).
  ipcMain.handle('tmux:capture', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const widgetId = win ? widgetOf.get(win.id) : undefined
    if (!widgetId) return ''
    const { stdout } = await execFileAsync(
      TMUX_BIN,
      captureTargetArgs(tmuxPaneTargetForWidget(widgetId)),
      {
        maxBuffer: 64 * 1024 * 1024, // 100k lines of history can be large
      },
    )
    return stdout
  })

  ipcMain.handle('tmux:scrollback-page', async (event, request?: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const widgetId = win ? widgetOf.get(win.id) : undefined
    if (!widgetId) return { fromLine: 0, totalLines: 0, text: '' }

    const target = tmuxPaneTargetForWidget(widgetId)
    const req =
      request && typeof request === 'object'
        ? (request as { fromLine?: unknown; count?: unknown })
        : {}
    const count = scrollbackPageCount(req.count)
    const requestedFromLine = scrollbackPageFromLine(req.fromLine)

    const { stdout: info } = await execFileAsync(TMUX_BIN, paneScrollbackInfoTargetArgs(target), {
      maxBuffer: 1024,
    })
    const [historyRaw, heightRaw] = info.trim().split(/\s+/)
    const historySize = Number(historyRaw)
    const paneHeight = Number(heightRaw)
    const bounds = scrollbackPageBounds(historySize, paneHeight, count, requestedFromLine)
    if (!bounds) return { fromLine: 0, totalLines: 0, text: '' }

    const { stdout } = await execFileAsync(TMUX_BIN, capturePageTargetArgs(target, bounds), {
      maxBuffer: 16 * 1024 * 1024,
    })
    return { fromLine: bounds.fromLine, totalLines: bounds.totalLines, text: stdout }
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.on('clipboard:write', (_event, text: string) => clipboard.writeText(text))

  ipcMain.handle('session:diagnostics', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const widgetId = win ? widgetOf.get(win.id) : undefined
    return widgetId
      ? sessionDiagnostics(widgetId)
      : { capturedAt: new Date().toISOString(), error: 'no widget ownership' }
  })

  ipcMain.on('win:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.on('win:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })
  ipcMain.on('win:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.on('win:set-bounds', (event, b: { x: number; y: number; w: number; h: number }) => {
    BrowserWindow.fromWebContents(event.sender)?.setBounds({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.w),
      height: Math.round(b.h),
    })
  })
  ipcMain.on('win:thinking', (event, on: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) setWidgetActivity(win.id, on)
  })

  // Control-surface actions: same handlers the tray uses. A new widget is always
  // an explicit (TUI, project) pair from the picker — both required, both checked
  // (untrusted renderer input), so a malformed call is ignored, not defaulted.
  ipcMain.on('widget:new', (_event, tool?: unknown, projectId?: unknown) => {
    if (typeof tool === 'string' && tool && typeof projectId === 'string' && projectId) {
      newWidget(tool, projectId)
    }
  })
  ipcMain.on('widget:hub', showHub)
  ipcMain.on('selection:grab', () => void selectionGrab())
  // Desktop grab fired from a menu click (window pick / region drag). Args are the
  // aico-grab.sh flags chosen by the renderer; validated to a small allowlist.
  ipcMain.on('grab:run', (_event, args: string[]) => {
    const allowed = new Set(['-p', '-t', '-r'])
    if (Array.isArray(args) && args.every((a) => allowed.has(a))) runDesktopGrab(args)
  })

  // Retire this widget from the widget itself: close the window AND end its tmux
  // session (same teardown as the tray's "Discard"), so the user need not go to
  // the tray. Resolves the widget id from the sender's window.
  ipcMain.on('widget:discard-self', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const id = win ? widgetOf.get(win.id) : undefined
    if (id) discardWidget(id)
  })

  // Replace the focused widget's running TUI with another (no new window).
  ipcMain.on('widget:load-tui', (event, slug?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const id = win ? widgetOf.get(win.id) : undefined
    if (id && slug) {
      loadTui(id, slug)
    }
  })

  // Move the focused widget to another workspace (lantern-menu "Open workspace ▸"
  // flyout): respawn its pane there, same tool. Resolves the widget from the
  // sender's window, exactly like widget:load-tui.
  ipcMain.on('widget:switch-project', (event, projectId?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const id = win ? widgetOf.get(win.id) : undefined
    if (id && projectId) {
      switchProject(id, projectId)
    }
  })

  // Rename a widget from its titlebar (click the name). Empty/whitespace clears
  // it back to `Widget ${seq}`. Persisted, then reflected in the title and tray.
  ipcMain.on('widget:set-name', (event, name: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const id = win ? widgetOf.get(win.id) : undefined
    if (!id) return
    setWidgetName(id, typeof name === 'string' ? name : null)
    pushTitles()
    syncTray()
  })

  // The enabled TUIs (registry order) so the lantern menu can offer a picker —
  // same source the tray's "New widget" submenu reads.
  ipcMain.handle('tui:list', () =>
    listTuis().map((t) => ({ slug: t.slug, displayName: t.displayName, accent: t.accent })),
  )

  // Aico workspace catalog for the lantern menu's "Open workspace ▸" flyout
  // (Personal Workspace + optional st projects). Personal Workspace remains even
  // if `st` is unavailable.
  // Renderer chrome snapshots this catalog once during initialization. Await a
  // stale/in-flight startup refresh so the first menu cannot permanently miss
  // every real workspace while the background `st projects list` is landing.
  ipcMain.handle('project:list', () => listProjectsFresh())

  ipcMain.handle('tmux:list-attachable', () =>
    listAttachableTmuxSessions().map((s) => ({
      id: s.id,
      label: s.label,
      source: s.source,
    })),
  )
  ipcMain.on('tmux:attach', (_event, id?: unknown) => {
    if (typeof id === 'string' && id) attachExternalTmuxSession(id)
  })

  // Global pinned-action set (one row in aico.db, shared across widgets). A
  // setPins from any widget persists and broadcasts so every cluster updates.
  ipcMain.handle('settings:get-pins', () => {
    const raw = getSetting('pins')
    if (raw == null) return null
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as string[]) : null
    } catch {
      return null
    }
  })
  ipcMain.on('settings:set-pins', (_event, ids: string[]) => {
    setSetting('pins', JSON.stringify(ids))
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('settings:pins-changed', ids)
    }
  })

  ipcMain.handle('settings:get-terminal-font', () => {
    const raw = getSetting('terminal-font')
    if (raw == null) return null
    try {
      return parseTerminalFontSettings(JSON.parse(raw))
    } catch {
      return null
    }
  })
  ipcMain.on('settings:set-terminal-font', (_event, payload: unknown) => {
    const settings = parseTerminalFontSettings(payload)
    setSetting('terminal-font', JSON.stringify(settings))
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('settings:terminal-font-changed', settings)
    }
  })

  createTray(
    {
      onSelect: focusOrReopen,
      onDiscard: (id) => void confirmTrayDiscard(id),
      onNewWidget: newWidget,
      onAttachTmuxSession: attachExternalTmuxSession,
      onHubView: showHub,
    },
    listTuis().map((t) => ({ slug: t.slug, label: t.displayName })),
    listProjects(),
    listAttachableTmuxSessions(),
  )

  // System-wide indicate hotkey (X11). Logs whether the grab actually took, so
  // a silent Wayland no-op is visible in the launcher log.
  const hotkeyOk = globalShortcut.register(SELECTION_HOTKEY, () => void selectionGrab())
  console.log(
    `[aico] selection hotkey ${SELECTION_HOTKEY}: ${
      hotkeyOk ? 'registered' : 'unavailable (Wayland? bind a GNOME shortcut to the grab path)'
    }`,
  )

  // Push-to-talk hotkey (X11). Same Wayland caveat as the selection hotkey.
  ipcMain.handle('voice:ws-url', () => VOICE_WS_URL)
  // getUserMedia is denied by default. Bind the grant to a currently catalogued
  // Aico widget's main renderer document and to audio-only requests; another
  // webContents, iframe, navigated document, or video request is rejected.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, cb, details) => {
    const win = BrowserWindow.fromWebContents(webContents)
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    cb(
      allowTrustedAudioMedia({
        permission,
        trustedRenderer: win !== null && widgetOf.has(win.id),
        currentUrl: webContents.getURL(),
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
        mediaTypes,
      }),
    )
  })
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) => {
      const win = webContents ? BrowserWindow.fromWebContents(webContents) : null
      return allowTrustedAudioMedia({
        permission,
        trustedRenderer: win !== null && widgetOf.has(win.id),
        currentUrl: webContents?.getURL() ?? '',
        requestingUrl: details.requestingUrl ?? requestingOrigin,
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaType ? [details.mediaType] : undefined,
      })
    },
  )
  const voiceHotkeyOk = globalShortcut.register(VOICE_PTT_HOTKEY, toggleVoice)
  console.log(
    `[aico] voice PTT hotkey ${VOICE_PTT_HOTKEY}: ${
      voiceHotkeyOk ? 'registered' : 'unavailable (Wayland? bind a GNOME shortcut to toggle voice)'
    }`,
  )

  // Browser-driven sends (and any CLI POST to /selection/send) arrive here.
  subscribeSelectionEvents()

  await restoreOnLaunch()
  syncTray()

  app.on('activate', () => {
    // No windows: reopen the oldest catalogued widget (as on launch). With an
    // empty catalog there's nothing to auto-spawn — a launch needs an explicit
    // TUI + project — so the tray stays the entry point.
    if (BrowserWindow.getAllWindows().length > 0) return
    const oldest = listWidgets()[0]
    if (oldest) focusOrReopen(oldest.id)
  })
})

app.on('window-all-closed', () => {
  // Aico lives in the tray after the last widget closes; Quit (tray) exits.
})
