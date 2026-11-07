import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FleetService } from '@aico/fleet/service'
import { registryProjects } from '@aico/tasks/registry'
import { AgentStatePoller, AgentStateTracker, bindAgentStates } from './agent-state'
import { type AskDelivery, AskStore, aicoOrigin, handOffAsks, type NeedsYouFeed } from './asks'
import {
  agentExitMarkerDir,
  resolveEntryScanConfig,
  resolveShowConfig,
  type TetherPaths,
} from './config'
import { observeAgent, writeJsonFile } from './continuity'
import { CoordinationDocs } from './coordination/docs'
import { DeadShells } from './dead-shells'
import { configureEntryScan } from './entry-files'
import { parseGraphicalEnvironment } from './env'
import { EventBus } from './events'
import { listenPrivateSocket } from './http'
import { HostAdmin } from './hub/host-admin'
import { Hub } from './hub/hub'
import { IdleOff, releaseStatusWriter, statusWriter } from './hub/idle-off'
import { LOCAL_HOST, localRootFate, Placement } from './hub/placement'
import { tetherHubPorts } from './hub/ports'
import { installedRelease } from './hub/update'
import { LaneReporter, LaneReportStore, laneView } from './lane-reports'
import { hostAdmissionPath, hostAdmissionRed } from './lifecycle/agent-admission'
import {
  bindCatalog,
  claimLauncher,
  getRootRequest,
  getSessionEntry,
  getWidget,
  isRetiredSessionId,
  listSessions,
  listWidgets,
} from './lifecycle/catalog'
import {
  displayTitle,
  leadName,
  setPersonalWorkspaceRoot,
  useConversationNames,
} from './lifecycle/display'
import {
  agentExitOf,
  cachedSessionStatus,
  configureEngine,
  endSession,
  flushSessionEvents,
  notifySessionChanged,
  onAbandonedScope,
  setGenerationFunction,
  setLaunchGuard,
  setSessionSnapshotFunction,
  startLifecycle,
  stopLifecycle,
  verifiedCurrentManagedPane,
  verifySessionStatus,
} from './lifecycle/engine'
import { ENTRY_MISSING_EXIT, ENTRY_RETRY_EXIT } from './lifecycle/entries'
import { setLifecycleInstance } from './lifecycle/ownership'
import { configureTmuxPaths } from './lifecycle/tmux'
import { adapterOf, bindToolSource, isDeliveryTool } from './lifecycle/tui/registry'
import {
  bindModelWatch,
  foregroundPaneScope,
  learnProjects,
  sessionSnapshot,
} from './lifecycle-api'
import { startMemoryGuard } from './memory-guard'
import { ModelNotices, readModelNoticeState } from './model-notices'
import { ModelWatch, readAlternates, readWatchEntries, worktreeFacts } from './model-switch'
import { nodeFileTail, nodeProcFs } from './proc-fs'
import { activeProjectFileFromEnv, ProjectProvider } from './projects'
import { Continuity } from './reboot'
import { Recovery, runProcess } from './recovery'
import { generationOf, pressKeysInRunningSession } from './running-session'
import { createTetherServer } from './server'
import { type History, historyFromEnv, startHistoryScan } from './sessions/history'
import { persistSizeHolders } from './size-holder'
import { Store } from './store'
import { VERSION } from './version'
import type { PullKind } from './wait-kinds'
import { anchorWidget, PullReaders, systemdCmdUnits, systemdProbe } from './wait-readers'
import { postAicoNotice, readWaitingState, WAIT_NOTICE_MS, WaitingNotices } from './waiting'
import { WaitService, WaitStore } from './waits'
import { bindWaitingOn, bindWakeStore, WakeService } from './wake-runtime'

export interface RunningDaemon {
  server: Server
  store: Store
  events: EventBus
  /** The hub over the remote hosts this instance federates; null when off. */
  hosts: Hub | null
  /** Resolves when startup reconciliation has finished (or was skipped). */
  ready: Promise<void>
  close(): Promise<void>
}

/** The hub federates hosts.json's remote Tethers wherever Tether observes
 * sessions, or where a test names its own registry (`TETHER_HOSTS_FILE`). */
function hubEnabled(env: NodeJS.ProcessEnv): boolean {
  return reconcileEnabled(env) || Boolean(env.TETHER_HOSTS_FILE)
}

/** `TETHER_RECONCILE=off` keeps a scratch/test instance from observing,
 * adopting or stopping any tmux server or scope at startup. */
function reconcileEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.TETHER_RECONCILE !== 'off'
}

const PROJECT_NAMES_MS = 300_000

/** Which client holds each session's window size, so a restart keeps it. */
const SIZE_HOLDERS_KEY = 'size_holders'

/** The waiting notices' seen marks and open notices, so a restart neither repeats nor strands one. */
const WAITING_KEY = 'waiting_notices'
const MODEL_WATCH_KEY = 'model_watch'
const MODEL_NOTICE_KEY = 'model_notices'

/** The desktop variables the graphical session imported into the user
 * manager; empty before login or when systemctl cannot answer. */
function userManagerGraphicalEnvironment(): Record<string, string> {
  try {
    return parseGraphicalEnvironment(
      execFileSync('systemctl', ['--user', 'show-environment'], {
        encoding: 'utf8',
        timeout: 2_000,
      }),
    )
  } catch {
    return {}
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

/** One process serves one instance: bind the extracted lifecycle modules. */
function bindLifecycleModules(
  paths: TetherPaths,
  env: NodeJS.ProcessEnv,
  store: Store,
  events: EventBus,
  projectRoots: Map<string, string>,
): void {
  setLifecycleInstance(paths.instance)
  configureTmuxPaths({
    // Non-default instances get a path that is never created, so a
    // lifecycle-v0 target can never address Aico's historical server.
    historicalSocket: paths.historicalTmuxSocket ?? join(paths.runtimeDir, 'no-historical-tmux'),
    paneExitMarkerDir: paths.paneExitMarkerDir,
  })
  bindCatalog(store.db)
  bindToolSource(store)
  setGenerationFunction(generationOf)
  setSessionSnapshotFunction(sessionSnapshot)
  persistSizeHolders(
    {
      read: () => store.getSetting(SIZE_HOLDERS_KEY),
      write: (value) => store.putSetting(SIZE_HOLDERS_KEY, value, Date.now()),
    },
    (id) => getWidget(id) !== undefined,
  )
  configureEngine({
    paths,
    events,
    env,
    projectRoot: (projectId) => projectRoots.get(projectId) ?? null,
    graphicalEnv: reconcileEnabled(env) ? userManagerGraphicalEnvironment : undefined,
    registeredProject: (project) => registryProjects(process.env).some((row) => row.id === project),
  })
}

/** The shared state every route group and background service reads. The
 * fields set to undefined here are filled in by the startup steps. */
function createContext(
  paths: TetherPaths,
  env: NodeJS.ProcessEnv,
  store: Store,
  events: EventBus,
  projects: ProjectProvider,
  projectRoots: Map<string, string>,
  show: ReturnType<typeof resolveShowConfig>,
) {
  const coordDocs = new CoordinationDocs(store.db, Date.now)
  return {
    coordDocs,
    show,
    paths,
    store,
    events,
    projects,
    projectRoots,
    activeProjectFile: activeProjectFileFromEnv(env, env.HOME ?? homedir()),
    history: undefined as History | undefined,
    startedAt: Date.now(),
    continuity: undefined as Continuity | undefined,
    recovery: undefined as Recovery | undefined,
    wakes: undefined as WakeService | undefined,
    asks: undefined as AskDelivery | undefined,
    // The Aico tray reads this file for its Aico row.
    asksFeed: {
      write: (feed: NeedsYouFeed) => writeJsonFile(join(paths.stateDir, 'needs-you.json'), feed),
      nameOf: (id: string) => {
        const row = getWidget(id)
        return row ? displayTitle(row) : null
      },
      origin: aicoOrigin(env.TETHER_AICO_URL),
    },
    waiting: undefined as WaitingNotices | undefined,
    hub: undefined as Hub | undefined,
    placement: undefined as Placement | undefined,
    lanes: undefined as LaneReporter | undefined,
    waits: undefined as WaitService | undefined,
    memoryPolicy: startMemoryGuard(paths, store, env, {
      foreground: foregroundPaneScope,
      sessionOf: () =>
        new Map(
          listWidgets().flatMap((row) => (row.scopeUnit ? [[row.scopeUnit, row.id] as const] : [])),
        ),
    }),
  }
}

type DaemonContext = ReturnType<typeof createContext>

/** The session history: each tool's transcripts, read in small passes. */
function startSessionHistory(context: DaemonContext, env: NodeJS.ProcessEnv): void {
  const { store, events, projectRoots } = context
  context.history = historyFromEnv(store.db, env, projectRoots)
  context.history.endRetired()
  useConversationNames(context.history.conversationName)
  events.subscribe((event) => {
    if (
      event.type === 'session.ended' &&
      typeof event.data.id === 'string' &&
      typeof event.data.host !== 'string'
    )
      context.history?.endOwned(event.data.id)
  })
}

/** Reboot continuity and crash recovery, where Tether observes sessions. */
function startContinuity(context: DaemonContext, env: NodeJS.ProcessEnv): void {
  const graphical = () => userManagerGraphicalEnvironment()
  const continuity = new Continuity(context, {
    // TETHER_HEADLESS=1: an instance with no desktop never waits for DISPLAY.
    headless: env.TETHER_HEADLESS === '1',
    desktopReady: () => Boolean(graphical().DISPLAY || graphical().WAYLAND_DISPLAY),
  })
  const recovery = new Recovery(context, {
    awaitingRestore: (id) => continuity.isAwaitingRestore(id),
    // A fresh pass, so a session started a moment ago is seen too.
    engine: {
      runningConversations: async () =>
        (await continuity.observe()).map(({ row, resumeId }) => ({ id: row.id, resumeId })),
    },
  })
  continuity.setRecovery(recovery)
  const deadShells = new DeadShells({
    awaitingRestore: (id) => continuity.isAwaitingRestore(id),
    restorePlanned: continuity.restorePlanned,
    restoreFinished: continuity.restoreFinished,
    list: listWidgets,
    status: verifySessionStatus,
    end: endSession,
    generationOf,
  })
  onAbandonedScope((event) => {
    void recovery.onAbandoned(event)
    deadShells.onAbandoned(event)
  })
  // The release this process runs, read now: health reports it and a hub sends it.
  installedRelease()
  void deadShells.settleStartup(context.startedAt)
  setLaunchGuard((id) => recovery.holdsLaunch(id))
  context.continuity = continuity
  context.recovery = recovery
}

/** An owner's answer to an ask goes to the asking session as an event line
 * on its delivery queue, or to the session that launched it once the asker
 * has ended; a session Tether cannot deliver to reads it with `tether ask get`. */
function askDelivery(wakes: WakeService): AskDelivery {
  // A session that is there (not ended), even while its state is unknown.
  const askReceiver = (id: string): boolean => Boolean(getWidget(id))
  return {
    wake: (sessionId, text, source) =>
      wakes.queueAnswer(sessionId, text, source ?? `ask:${Date.now()}`),
    lost: (wakeId) =>
      !wakes.store.get(wakeId) && wakes.deliveries.get(wakeId)?.deliveredAt === null,
    coordinatorOf: (sessionId) => {
      const row = getWidget(sessionId)
      return row?.launched ? (row.coordinatorId ?? null) : null
    },
    receiver: askReceiver,
    launcherOf: (sessionId) => {
      // Only lineage from a launch, as lane reports read it.
      const row = getWidget(sessionId)
      if (!row?.launched) return null
      return row.parentId ?? row.coordinatorId ?? null
    },
    nameOf: (id) => {
      const row = getWidget(id)
      return row ? displayTitle(row) : null
    },
    cancel: (wakeId, why) => wakes.cancelLine(wakeId, why),
    withdraw: (source) => wakes.withdrawEvents(null, source).withdrawn,
    noteMaxChars: () => wakes.policy().noteMaxChars,
    sessionChanged: (sessionId) => {
      if (getWidget(sessionId)) notifySessionChanged(sessionId, { force: true })
    },
  }
}

/** The machine has one fleet link, held by the default instance. A test instance (tether@dev) reading
 * the same fleet.json fights it for the link's sockets and writes failed link rows; it runs a link
 * only when given its own AICO_FLEET_CONFIG. */
function createFleet(paths: TetherPaths, env: NodeJS.ProcessEnv): FleetService {
  return new FleetService(
    paths.instance === 'default' || env.AICO_FLEET_CONFIG
      ? env
      : { ...env, AICO_FLEET_CONFIG: join(paths.runtimeDir, 'no-fleet-link.json') },
    paths.socket,
  )
}

function createHub(
  context: DaemonContext,
  env: NodeJS.ProcessEnv,
  fleet: FleetService,
  askStore: AskStore,
): Hub | null {
  const { store, events } = context
  return hubEnabled(env)
    ? new Hub({
        env,
        status: releaseStatusWriter(env),
        fault: (error) => fleet.fault(error),
        uid: process.getuid?.(),
        ports: tetherHubPorts,
        publish: (type, data) => events.publish(type as Parameters<EventBus['publish']>[0], data),
        settings: {
          get: (key) => store.getSetting(key),
          put: (key, value) => store.putSetting(key, value, Date.now()),
        },
        isLocalSession: (id) => getWidget(id) !== undefined,
        isLocalRoot: (requestId, logicalSessionId) => {
          const root = getRootRequest(requestId)
          return (
            root !== undefined &&
            (logicalSessionId === undefined || root.logicalSessionId === logicalSessionId)
          )
        },
        isLocalAsk: (id) => askStore.get(id) !== undefined,
        endedBy: (host, id, by) => context.lanes?.remoteEnd(host, id, by),
        leadName,
        claimLocal: (launcherId) => {
          const claimed = claimLauncher(launcherId)
          for (const id of claimed?.changed ?? []) notifySessionChanged(id, { force: true })
          return claimed?.lineage ?? null
        },
      })
    : null
}

/** Powers off a host that has sat with no sessions for its `idleOffMin` (src/hub/idle-off.ts). */
function startIdleOff(context: DaemonContext, env: NodeJS.ProcessEnv, hosts: Hub): IdleOff {
  const admin = new HostAdmin({ hub: hosts, env, tools: tetherHubPorts.tools })
  const idle = new IdleOff({
    hostNames: () => hosts.hostNames(),
    idleFacts: (name) => hosts.idleFacts(name),
    booked: (host) => context.placement?.list().some((item) => item.host === host) ?? false,
    powerOff: (host) => admin.power(host, 'off', false),
    status: statusWriter(env),
    log: (message) => console.log(`[tether:hosts] ${message}`),
    now: Date.now,
  })
  idle.start()
  return idle
}

/** `--host auto`: pick a host with room from live readings (src/hub/placement.ts). */
function createPlacement(
  context: DaemonContext,
  env: NodeJS.ProcessEnv,
  hosts: Hub | null,
): Placement {
  const { store } = context
  return new Placement({
    env,
    hostNames: () => hosts?.hostNames() ?? [],
    peer: (name) => hosts?.peerView(name) ?? null,
    retired: (name) => hosts?.retired(name) ?? false,
    localRoot: (requestId) => {
      const root = getRootRequest(requestId)
      const row = root ? getWidget(root.widgetId) : undefined
      const marker = row ? agentExitOf(row) : null
      const recovering =
        row &&
        (context.recovery?.retains(row.id) ||
          context.continuity?.isAwaitingRestore(row.id) ||
          (getSessionEntry(row.id) &&
            marker?.state === 'exit' &&
            [ENTRY_RETRY_EXIT, ENTRY_MISSING_EXIT].includes(marker.status)))
      if (recovering) return 'live'
      return localRootFate(Boolean(root), Boolean(row), row ? agentExitOf(row)?.state : null)
    },
    existingHost: (requestId) => {
      if (getRootRequest(requestId)) return LOCAL_HOST
      return hosts?.rootOwner(requestId) ?? undefined
    },
    settings: {
      get: (key) => store.getSetting(key),
      put: (key, value) => store.putSetting(key, value, Date.now()),
    },
  })
}

/** The owner's waiting notice: only the Tether that knows where Aico is. */
function startWaitingNotices(
  context: DaemonContext,
  env: NodeJS.ProcessEnv,
  aicoUrl: string | null,
): WaitingNotices | null {
  const { store, events } = context
  const waiting =
    aicoUrl && reconcileEnabled(env)
      ? new WaitingNotices({
          origin: aicoUrl,
          tools: () => store.listTools(),
          send: (notice) =>
            postAicoNotice(env, '/api/notices', notice, `waiting_notice key=${notice.key}`),
          resolve: (key) =>
            postAicoNotice(
              env,
              '/api/notices/resolve',
              { source: 'aico', key, text: 'The session no longer waits on you.' },
              `waiting_resolve key=${key}`,
            ),
          state: {
            read: () => readWaitingState(store.getSetting(WAITING_KEY)),
            write: (state) => store.putSetting(WAITING_KEY, JSON.stringify(state), Date.now()),
          },
        })
      : null
  if (waiting) {
    context.waiting = waiting
    events.subscribe((event) => {
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const session = event.data.session as { id?: unknown } | undefined
        if (session && typeof session.id === 'string') waiting.session(session as { id: string })
      } else if (event.type === 'session.ended' && typeof event.data.id === 'string') {
        waiting.removed(event.data.id)
      }
    })
  }
  return waiting
}

/** A model switch in a window nobody launched: the owner's notice (src/model-notices.ts). */
function startModelNotices(
  context: DaemonContext,
  env: NodeJS.ProcessEnv,
  aicoUrl: string | null,
): ModelNotices | null {
  const { store, events } = context
  const modelNotices =
    aicoUrl && reconcileEnabled(env)
      ? new ModelNotices({
          origin: aicoUrl,
          send: (notice) =>
            postAicoNotice(env, '/api/notices', notice, `model_notice key=${notice.key}`),
          resolve: (key) =>
            postAicoNotice(
              env,
              '/api/notices/resolve',
              { source: 'aico', key, text: 'The session is back on its model or gone.' },
              `model_resolve key=${key}`,
            ),
          state: {
            read: () => readModelNoticeState(store.getSetting(MODEL_NOTICE_KEY)),
            write: (state) => store.putSetting(MODEL_NOTICE_KEY, JSON.stringify(state), Date.now()),
          },
        })
      : null
  if (modelNotices)
    events.subscribe((event) => {
      try {
        const host = typeof event.data.host === 'string' ? event.data.host : null
        if (event.type === 'session.created' || event.type === 'session.updated') {
          const session = event.data.session as { id?: unknown } | undefined
          if (session && typeof session.id === 'string')
            modelNotices.session(session as { id: string }, host)
        } else if (event.type === 'session.ended' && typeof event.data.id === 'string') {
          modelNotices.removed(event.data.id, host)
        }
      } catch (error) {
        console.error('[tether:models] notice failed:', error)
      }
    })
  return modelNotices
}

/** Lane reports: a launched lane tells its launcher it finished, is blocked
 * or ended (src/lane-reports.ts); only where Tether observes sessions, since
 * the lines are pasted. */
function startLaneReports(
  context: DaemonContext,
  env: NodeJS.ProcessEnv,
  wakes: WakeService,
  hosts: Hub | null,
  modelNotices: ModelNotices | null,
): LaneReporter | null {
  const { store, events } = context
  const lanes = reconcileEnabled(env)
    ? new LaneReporter(new LaneReportStore(store.db), {
        childGone: (id) => {
          const row = getWidget(id)
          return Boolean(
            row && (agentExitOf(row)?.state === 'exit' || context.recovery?.isHeld(id)),
          )
        },
        now: Date.now,
        policy: () => wakes.policy(),
        receiver: (id) => wakes.receiver(id),
        sessions: () =>
          listSessions().map((row) => ({
            id: row.id,
            coordinatorId: row.coordinatorId,
            parentId: row.parentId,
            launched: row.launched,
          })),
        deliver: (receiver, source, line, ride) => {
          const now = Date.now()
          wakes.store.addEvent({ sessionId: receiver, source, note: line, now, ride })
          wakes.changed(receiver)
        },
        told: (lane, receiver, since) => wakes.toldSince(lane, receiver, since),
        promoteReplies: (lane, receivers) => wakes.promoteReplies(lane, receivers),
        withdraw: (receiver, source) => wakes.withdrawEvents(receiver, source).withdrawn,
        handled: (lane, host, receivers) => context.waits?.sessionHandled(lane, host, receivers),
        acted: (lane, host, by, since) =>
          context.waits?.store.actedOn(lane, host ?? '', by, since) ?? false,
        elsewhere: (id) => {
          // Only an agent there that can take lines: else the root stands in.
          const remote = hosts?.remoteSession(id)
          if (!remote || remote.session.id !== id) return null
          const { tool, state } = remote.session
          const agent = typeof tool === 'string' && isDeliveryTool(tool)
          return agent && state !== 'unknown' ? remote.host : null
        },
        heardFrom: (lane, host, receivers, event) =>
          context.waits?.heardFrom(lane, host ?? '', receivers, event) ?? new Set(),
        agentGone: (id) => {
          const row = getWidget(id)
          if (!row) return false
          const exit = agentExitOf(row)
          return (
            (exit?.state === 'exit' && exit.status === 0) || Boolean(context.recovery?.isHeld(id))
          )
        },
        unheard: (id) => {
          modelNotices?.unheard(id)
          if (getWidget(id)) notifySessionChanged(id, { force: true })
        },
        log: (message) => console.log(`[tether:lanes] ${message}`),
      })
    : null
  if (lanes) {
    context.lanes = lanes
    events.subscribe((event) => {
      try {
        const host = typeof event.data.host === 'string' ? event.data.host : null
        if (event.type === 'session.created' || event.type === 'session.updated') {
          const view = laneView(event.data.session, host)
          if (view) lanes.observe(view)
        } else if (event.type === 'session.ended' && typeof event.data.id === 'string') {
          if (host) lanes.ended(event.data.id, host)
          else lanes.drainOutbox()
        }
      } catch (error) {
        console.error('[tether:lanes] report failed:', error)
      }
    })
  }
  return lanes
}

/** General waits: an agent's wait on another session, a job, a request, an
 * ask or a host fires once, as one line on its delivery
 * queue (src/waits.ts); pasted, so only where Tether observes sessions. */
function startWaits(
  context: DaemonContext,
  env: NodeJS.ProcessEnv,
  wakes: WakeService,
  hosts: Hub | null,
  askStore: AskStore,
): WaitService | null {
  const { store, events, paths, coordDocs } = context
  let pokeWaits: (kind: PullKind, ref?: string) => void = () => {}
  coordDocs.onWrite((name) => {
    if (name === '_coord') pokeWaits('reply')
  })
  const summitflowRoot =
    env.SUMMITFLOW_SERVICE_STATE_ROOT || join(env.HOME ?? homedir(), '.summitflow', 'services')
  const admissionPath = hostAdmissionPath(env)
  const readers = new PullReaders({
    paths: {
      jobsDir: env.TETHER_WAIT_JOBS_DIR || join(summitflowRoot, 'jobs'),
      cmdDir: join(paths.stateDir, 'wait-cmd'),
    },
    cmdUnits: systemdCmdUnits(env),
    ledgerDoc: () => coordDocs.get('_coord'),
    ask: (id) => askStore.get(id),
    agentTitle: (anchor) => {
      const widget = anchorWidget(nodeProcFs, anchor)
      const row = widget ? getWidget(widget) : null
      return row ? displayTitle(row) : null
    },
    host: (name) => hosts?.peerView(name)?.state ?? null,
    admissionRed: () => hostAdmissionRed(admissionPath),
    probeJob: systemdProbe(env),
    poke: (kind, ref) => pokeWaits(kind, ref),
    now: Date.now,
    log: (message) => console.log(`[tether:waits] ${message}`),
  })
  const waits = reconcileEnabled(env)
    ? new WaitService(new WaitStore(store.db), {
        now: Date.now,
        policy: () => wakes.policy(),
        resolve: (ref) => {
          if (/^[0-9a-f]{8}$/.test(ref) && getWidget(ref)) return { id: ref, host: null }
          const root = getRootRequest(ref)
          if (root && getWidget(root.widgetId)) return { id: root.widgetId, host: null }
          const remote = hosts?.remoteSession(ref)
          return remote && typeof remote.session.id === 'string'
            ? { id: remote.session.id, host: remote.host }
            : null
        },
        endedSession: (ref) => {
          // A session id Tether retired, or a root request's tombstone.
          if (/^[0-9a-f]{8}$/.test(ref)) return isRetiredSessionId(ref) ? ref : null
          const root = getRootRequest(ref)
          return root?.widgetId && !getWidget(root.widgetId) ? root.widgetId : null
        },
        pullRef: (kind, ref) => readers.pullRef(kind, ref),
        read: (kind, ref) => readers.read(kind, ref),
        refresh: (kind, ref, force) => readers.refresh(kind, ref, force),
        createCmd: (ref, spec) => readers.createCmd(ref, spec),
        cmdArgv: (ref) => readers.cmdArgv(ref),
        settled: (wait) => {
          if (wait.kind === 'cmd') readers.endCmd(wait.ref)
        },
        sweepCmd: (armed) => readers.sweepCmd(armed),
        told: (wait) => {
          // The waiter has this line already from its owner: the ask's
          // answer queued to it, the run's pause told to it as launcher.
          if (wait.kind === 'ask') {
            const ask = askStore.get(wait.ref)
            return Boolean(ask && ask.delivery === 'wake' && ask.answerTo === wait.waiter)
          }
          return false
        },
        view: (id, host) => {
          if (host === null) {
            const row = getWidget(id)
            return row ? laneView(sessionSnapshot(row), null) : null
          }
          const remote = hosts?.remoteSession(id)
          return remote && remote.host === host && remote.session.id === id
            ? laneView(remote.session, host)
            : null
        },
        agentGone: (id) => {
          const row = getWidget(id)
          if (!row) return false
          const exit = agentExitOf(row)
          return (
            (exit?.state === 'exit' && exit.status === 0) || Boolean(context.recovery?.isHeld(id))
          )
        },
        receiver: (id) => wakes.receiver(id),
        notMainAgent: async (waiter, thread) => {
          // Codex sets CODEX_THREAD_ID per thread: a subagent's differs from the
          // session's own conversation. Claude subagents share the parent's ids.
          const row = getWidget(waiter)
          if (!row || !adapterOf(row.tool)?.capabilities.threadSubagents) return null
          const pane = await verifiedCurrentManagedPane(row).catch(() => null)
          const agent = pane ? observeAgent(nodeProcFs, env.HOME ?? homedir(), pane.pid) : null
          return agent?.resumeId && agent.resumeId !== thread
            ? "the caller's Codex thread is not this session's main agent (a subagent): use --block"
            : null
        },
        deliver: (waiter, source, line) => {
          wakes.store.addEvent({ sessionId: waiter, source, note: line, now: Date.now() })
        },
        withdraw: (waiter, source) => wakes.withdrawEvents(waiter, source),
        relaunch: (ended, line) => {
          wakes.store.addKept({ ended, note: line, now: Date.now() })
        },
        changed: (waiter) => wakes.changed(waiter && getWidget(waiter) ? waiter : null),
        log: (message) => console.log(`[tether:waits] ${message}`),
      })
    : null
  if (waits) {
    context.waits = waits
    bindWaitingOn((id) => waits.waitingOn(id))
    pokeWaits = (kind, ref) => waits.pokeKind(kind, ref)
    readers.watch()
    events.subscribe((event) => {
      if (event.type.startsWith('session.') && typeof event.data.id === 'string')
        waits.poke(event.data.id)
      else if (event.type === 'peer.state') waits.pokeKind('host')
      else if (event.type === 'asks.changed') {
        const ask = event.data.ask as { id?: unknown } | undefined
        if (typeof ask?.id === 'string') waits.pokeKind('ask', ask.id)
      }
    })
  }
  return waits
}

/** A session that ends with open asks hands them to its launcher (one
 * line); their answers go there (src/asks.ts handOffAsks). */
function handOffAsksOnEnd(context: DaemonContext, askStore: AskStore): void {
  const { events } = context
  events.subscribe((event) => {
    if (event.type !== 'session.ended' || typeof event.data.id !== 'string') return
    if (typeof event.data.host === 'string' || !context.asks) return
    try {
      for (const ask of handOffAsks(askStore, context.asks, event.data.id, null))
        events.publish('asks.changed', { ask, created: false })
    } catch (error) {
      console.error('[tether:asks] hand-off failed:', error)
    }
  })
}

/** Model switches: each agent's own record, read on the agent poll; a switch
 * nobody asked for stops the turn (src/model-switch.ts). */
function startModelWatch(
  context: DaemonContext,
  env: NodeJS.ProcessEnv,
  agentStates: AgentStateTracker,
): ModelWatch | null {
  const { store, events, paths } = context
  const models = reconcileEnabled(env)
    ? new ModelWatch({
        now: Date.now,
        read: () => readWatchEntries(store.getSetting(MODEL_WATCH_KEY)),
        write: (entries) => store.putSetting(MODEL_WATCH_KEY, JSON.stringify(entries), Date.now()),
        alternates: (tool) => {
          let text: string | null = null
          try {
            text = readFileSync(join(paths.configDir, 'model-alternates.json'), 'utf8')
          } catch {}
          return readAlternates(text)[tool]
        },
        agent: (id) => {
          const record = agentStates.get(id)
          return { state: record.state, detail: record.stateDetail }
        },
        interrupt: (id) => pressKeysInRunningSession(id, ['Escape']),
        worktree: (id, since) =>
          worktreeFacts(getWidget(id)?.projectRoot ?? null, since, runProcess, (path) =>
            nodeProcFs.mtimeMs ? nodeProcFs.mtimeMs(path) : null,
          ),
        changed: (id) => notifySessionChanged(id, { force: true }),
        log: (message) => console.log(`[tether:models] ${message}`),
      })
    : null
  bindModelWatch(models)
  if (models)
    events.subscribe((event) => {
      if (event.type === 'session.ended' && typeof event.data.host !== 'string')
        models.retain(listWidgets().map((row) => row.id))
    })
  return models
}

function createAgentPoller(
  context: DaemonContext,
  env: NodeJS.ProcessEnv,
  agentStates: AgentStateTracker,
  models: ModelWatch | null,
): AgentStatePoller {
  return new AgentStatePoller(
    agentStates,
    {
      sessions: () =>
        listWidgets()
          .filter((row) => cachedSessionStatus(row) === 'running')
          .map((row) => ({
            id: row.id,
            generation: generationOf(row),
            panePid: async () => (await verifiedCurrentManagedPane(row))?.pid ?? null,
          })),
    },
    nodeProcFs,
    env.HOME ?? homedir(),
    {
      conversation: (id, tool, nativeId) => context.history?.bind(id, tool, nativeId),
      ...(models ? { models: (id, source) => models.see(id, source, nodeFileTail) } : {}),
      ...(context.history ? { runs: context.history.agentRun } : {}),
    },
  )
}

/** Background services that start once startup reconciliation has finished. */
function startWhenReady(
  ready: Promise<void>,
  env: NodeJS.ProcessEnv,
  services: {
    agentPoller: AgentStatePoller
    wakes: WakeService
    waits: WaitService | null
    lanes: LaneReporter | null
  },
): void {
  const { agentPoller, wakes, waits, lanes } = services
  if (reconcileEnabled(env)) void ready.then(() => agentPoller.start()).catch(() => {})
  // Wakes paste into sessions, so only where Tether observes tmux.
  if (reconcileEnabled(env)) void ready.then(() => wakes.scheduler.start()).catch(() => {})
  if (waits) void ready.then(() => waits.start()).catch(() => {})
  if (lanes)
    void ready
      .then(() => {
        // Ended while Tether was down, then every lane as it is now.
        lanes.drainOutbox()
        for (const row of listSessions()) {
          const view = laneView(sessionSnapshot(row), null)
          if (view) lanes.observe(view)
        }
      })
      .catch(() => {})
}

/** Notices for what was already waiting or switched when Tether started; once
 * remote hosts have listed theirs, resolve what no longer holds. */
function sweepNoticesWhenReady(
  ready: Promise<void>,
  waiting: WaitingNotices | null,
  modelNotices: ModelNotices | null,
): void {
  if (waiting)
    void ready
      .then(() => {
        // Sessions already waiting when Tether started; then, once remote hosts
        // have had time to list theirs, resolve what no longer waits.
        for (const row of listSessions()) waiting.session(sessionSnapshot(row) as { id: string })
        setTimeout(() => waiting.sweep(), WAIT_NOTICE_MS).unref()
      })
      .catch(() => {})
  if (modelNotices)
    void ready
      .then(() => {
        // Switches standing when Tether started; then, once remote hosts have
        // listed theirs, resolve the notices of sessions that are gone.
        for (const row of listSessions())
          modelNotices.session(sessionSnapshot(row) as { id: string }, null)
        setTimeout(() => modelNotices.sweep(), WAIT_NOTICE_MS).unref()
      })
      .catch(() => {})
}

/** Display titles name each session's project: learn names now and keep up
 * with renames. Returns the refresh timer. */
function startProjectNames(
  context: DaemonContext,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof setInterval> {
  const { projects } = context
  setPersonalWorkspaceRoot(
    join(env.HOME ?? homedir(), '.local', 'share', 'aico', 'personal-workspace'),
  )
  const learn = () =>
    projects
      .list()
      .then((list) => learnProjects(context, list.projects))
      .catch(() => {})
  void learn()
  const projectNames = setInterval(learn, PROJECT_NAMES_MS)
  projectNames.unref()
  return projectNames
}

export async function startDaemon(
  paths: TetherPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunningDaemon> {
  const show = resolveShowConfig(env)
  configureEntryScan(resolveEntryScanConfig(env))
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
  chmodSync(paths.stateDir, 0o700)
  mkdirSync(agentExitMarkerDir(paths), { recursive: true, mode: 0o700 })
  const store = new Store(paths.dbPath)
  const events = new EventBus()
  const projects = new ProjectProvider({
    registry: () => registryProjects(env),
    localFile: paths.localProjectsFile,
  })
  const projectRoots = new Map<string, string>()

  bindLifecycleModules(paths, env, store, events, projectRoots)
  const context = createContext(paths, env, store, events, projects, projectRoots, show)
  if (reconcileEnabled(env)) startSessionHistory(context, env)
  if (reconcileEnabled(env)) startContinuity(context, env)
  const wakes = new WakeService(context)
  context.wakes = wakes
  bindWakeStore(wakes.store)
  context.asks = askDelivery(wakes)
  const fleet = createFleet(paths, env)
  const askStore = new AskStore(store.db)
  const hosts = createHub(context, env, fleet, askStore)
  if (hosts) context.hub = hosts
  context.placement = createPlacement(context, env, hosts)
  const aicoUrl = aicoOrigin(env.TETHER_AICO_URL)
  const waiting = startWaitingNotices(context, env, aicoUrl)
  if (waiting) context.waiting = waiting
  const modelNotices = startModelNotices(context, env, aicoUrl)
  const lanes = startLaneReports(context, env, wakes, hosts, modelNotices)
  if (lanes) context.lanes = lanes
  const waits = startWaits(context, env, wakes, hosts, askStore)
  if (waits) context.waits = waits
  handOffAsksOnEnd(context, askStore)
  const server = createTetherServer(context)
  try {
    await listenPrivateSocket(server, paths.socket)
  } catch (error) {
    store.close()
    throw error
  }
  await fleet.start()
  const ready = startLifecycle({ reconcile: reconcileEnabled(env) })
  hosts?.start()
  const idleOff = hosts ? startIdleOff(context, env, hosts) : null
  // Agent state: hook reports always; the poll only where Tether observes tmux.
  const agentStates = new AgentStateTracker((id) => {
    notifySessionChanged(id, { force: true })
    wakes.scheduler.nudge()
  })
  bindAgentStates(agentStates)
  const models = startModelWatch(context, env, agentStates)
  const agentPoller = createAgentPoller(context, env, agentStates, models)
  startWhenReady(ready, env, { agentPoller, wakes, waits, lanes })
  const projectNames = startProjectNames(context, env)
  void context.continuity?.start()
  startHistoryScan(context.history)
  void ready.then(() => context.recovery?.start()).catch(() => {})
  sweepNoticesWhenReady(ready, waiting, modelNotices)
  console.log(`[tether] ${VERSION} instance=${paths.instance} listening on ${paths.socket}`)
  return {
    server,
    store,
    events,
    hosts,
    ready,
    close: async () => {
      await fleet?.close()
      idleOff?.stop()
      hosts?.close()
      stopLifecycle()
      context.memoryPolicy.stop()
      clearInterval(projectNames)
      agentPoller.stop()
      wakes.scheduler.stop()
      lanes?.stop()
      waits?.stop()
      bindWaitingOn(null)
      bindWakeStore(null)
      bindAgentStates(null)
      bindModelWatch(null)
      context.continuity?.stop()
      context.recovery?.stop()
      onAbandonedScope(null)
      setLaunchGuard(null)
      await closeServer(server)
      // Let in-flight reconciliation settle before the database closes.
      await ready.catch(() => {})
      await flushSessionEvents()
      store.close()
    },
  }
}
