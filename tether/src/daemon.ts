import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import type { Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHubApi } from './agent-hub/client'
import {
  type AgentHubConfig,
  resolveAgentHubConfig,
  resolveRunsConfig,
  resolveSettleMs,
} from './agent-hub/config'
import { RunTracker, sessionLaunchers, type ToldPause } from './agent-hub/runs'
import { AgentHubRuntime, type HubApi } from './agent-hub/runtime'
import { AgentStatePoller, AgentStateTracker } from './agent-state'
import { agentExitMarkerDir, resolveShowConfig, type TetherPaths } from './config'
import { nodeProcFs } from './continuity'
import { DeadShells } from './dead-shells'
import { parseGraphicalEnvironment } from './env'
import { EventBus } from './events'
import { GuiChannel } from './gui-channel'
import { listenPrivateSocket } from './http'
import { Hub } from './hub/hub'
import {
  bindCatalog,
  claimLauncher,
  getAgentHubSession,
  getRootRequest,
  getWidget,
  listSessions,
  listWidgets,
} from './lifecycle/catalog'
import { leadName, setPersonalWorkspaceRoot } from './lifecycle/display'
import {
  cachedSessionStatus,
  configureEngine,
  endSession,
  flushSessionEvents,
  notifySessionChanged,
  onAbandonedScope,
  setGenerationFunction,
  setHubBackend,
  setLaunchGuard,
  setSessionSnapshotFunction,
  startLifecycle,
  stopLifecycle,
  verifiedCurrentManagedPane,
  verifySessionStatus,
} from './lifecycle/engine'
import { setLifecycleInstance } from './lifecycle/ownership'
import { configureTmuxPaths } from './lifecycle/tmux'
import { bindToolSource } from './lifecycle/tui/registry'
import {
  bindAgentHub,
  bindAgentStates,
  foregroundPaneScope,
  generationOf,
  learnProjects,
  sessionSnapshot,
} from './lifecycle-api'
import { startMemoryGuard } from './memory-guard'
import { activeProjectFileFromEnv, ProjectProvider, summitflowUrlFromEnv } from './projects'
import { Continuity } from './reboot'
import { Recovery } from './recovery'
import type { StepChatSource } from './runs-api'
import { createTetherServer } from './server'
import { persistSizeHolders } from './size-holder'
import { Store } from './store'
import { VERSION } from './version'
import { bindWakeStore, WakeService } from './wake-runtime'
import { cleanNote } from './wakes'

export interface RunningDaemon {
  server: Server
  store: Store
  events: EventBus
  gui: GuiChannel
  /** The Agent Hub session kind's runtime (polls only where Tether observes sessions). */
  agentHub: AgentHubRuntime
  /** The hub over the remote hosts this instance federates; null when off. */
  hosts: Hub | null
  /** Resolves when startup reconciliation has finished (or was skipped). */
  ready: Promise<void>
  close(): Promise<void>
}

/** The hub federates hosts.json's remote Tethers wherever Tether observes
 * sessions, or where a test names its own registry (`TETHER_HOSTS_FILE`). */
export function hubEnabled(env: NodeJS.ProcessEnv): boolean {
  return reconcileEnabled(env) || Boolean(env.TETHER_HOSTS_FILE)
}

/** `TETHER_RECONCILE=off` keeps a scratch/test instance from observing,
 * adopting or stopping any tmux server or scope at startup. */
export function reconcileEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.TETHER_RECONCILE !== 'off'
}

const PROJECT_NAMES_MS = 300_000

/** The dismissed workflow runs, kept as one JSON setting (run id to when). */
const DISMISSED_RUNS_KEY = 'dismissed_runs'

/** The run pauses already told to their launching session (run id to the
 * pause's key and when), so a restart does not tell one again. */
const TOLD_PAUSES_KEY = 'told_run_pauses'

/** Which client holds each session's window size, so a restart keeps it. */
const SIZE_HOLDERS_KEY = 'size_holders'

function readTold(raw: string | null): Record<string, ToldPause> {
  try {
    const value = JSON.parse(raw ?? '{}') as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => {
        const e = entry as { key?: unknown; at?: unknown; to?: unknown; note?: unknown } | null
        return (
          typeof e?.key === 'string' &&
          typeof e.at === 'number' &&
          Number.isFinite(e.at) &&
          (e.to === undefined || typeof e.to === 'string') &&
          (e.note === undefined || typeof e.note === 'string')
        )
      }),
    ) as Record<string, ToldPause>
  } catch {
    return {}
  }
}

function readDismissedRuns(raw: string | null): Record<string, number> {
  try {
    const value = JSON.parse(raw ?? '{}') as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(value).filter(([, at]) => typeof at === 'number' && Number.isFinite(at)),
    ) as Record<string, number>
  } catch {
    return {}
  }
}

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

export async function startDaemon(
  paths: TetherPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunningDaemon> {
  const show = resolveShowConfig(env)
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
  chmodSync(paths.stateDir, 0o700)
  mkdirSync(agentExitMarkerDir(paths), { recursive: true, mode: 0o700 })
  const store = new Store(paths.dbPath)
  const events = new EventBus()
  const projects = new ProjectProvider({
    summitflowUrl: summitflowUrlFromEnv(env),
    localFile: paths.localProjectsFile,
  })
  const gui = new GuiChannel(events)
  const projectRoots = new Map<string, string>()

  // One process serves one instance: bind the extracted lifecycle modules.
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
  })

  const context = {
    show,
    paths,
    store,
    events,
    projects,
    gui,
    projectRoots,
    activeProjectFile: activeProjectFileFromEnv(env, env.HOME ?? homedir()),
    startedAt: Date.now(),
    continuity: undefined as Continuity | undefined,
    recovery: undefined as Recovery | undefined,
    wakes: undefined as WakeService | undefined,
    runs: undefined as RunTracker | undefined,
    stepChats: undefined as StepChatSource | undefined,
    hub: undefined as Hub | undefined,
    memoryPolicy: startMemoryGuard(paths, store, env, {
      foreground: foregroundPaneScope,
      sessionOf: () =>
        new Map(
          listWidgets().flatMap((row) => (row.scopeUnit ? [[row.scopeUnit, row.id] as const] : [])),
        ),
    }),
  }
  if (reconcileEnabled(env)) {
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
    void deadShells.settleStartup(context.startedAt)
    setLaunchGuard((id) => recovery.holdsLaunch(id))
    context.continuity = continuity
    context.recovery = recovery
  }
  const wakes = new WakeService(context)
  context.wakes = wakes
  bindWakeStore(wakes.store)
  // One Agent Hub client for the session kind and for the workflow runs.
  let hubApi: HubApi | null = null
  let hubConfig: AgentHubConfig | null = null
  const hub = (): HubApi => {
    hubConfig ??= resolveAgentHubConfig(env)
    hubApi ??= createHubApi(hubConfig)
    return hubApi
  }
  const runs = new RunTracker({
    api: () => hub().workflowRuns,
    // Agent Hub refuses every call without a client id (a host whose Tether
    // reaches the workstation's Agent Hub through a forward, for one).
    unusable: () => {
      hubConfig ??= resolveAgentHubConfig(env)
      return hubConfig.clientId ? null : 'Agent Hub client id is not set'
    },
    launchers: () => sessionLaunchers(listSessions(), (id) => getAgentHubSession(id)?.hubSessionId),
    config: resolveRunsConfig(env),
    dismissed: {
      read: () => readDismissedRuns(store.getSetting(DISMISSED_RUNS_KEY)),
      write: (dismissed) =>
        store.putSetting(DISMISSED_RUNS_KEY, JSON.stringify(dismissed), Date.now()),
    },
    // A run that waits for the owner is told to the session that launched it
    // as a check-in that is due now, delivered when the agent is idle.
    pauses: {
      store: {
        read: () => readTold(store.getSetting(TOLD_PAUSES_KEY)),
        write: (told) => store.putSetting(TOLD_PAUSES_KEY, JSON.stringify(told), Date.now()),
      },
      maxChars: () => wakes.policy().noteMaxChars,
      tell: (launcherId, notice) => {
        const row = getWidget(launcherId)
        if (!row || !wakes.supports(row)) return false
        const note = cleanNote(notice.text, wakes.policy().noteMaxChars)
        if (note === null) return false
        const now = Date.now()
        const wake = wakes.store.add({
          sessionId: row.id,
          dueAt: now,
          note,
          createdBy: 'agent',
          now,
        })
        wakes.changed(row.id)
        return wake.id
      },
      withdraw: (_launcherId, noteId) => {
        const wake = wakes.store.get(noteId)
        if (wake && wakes.store.remove(noteId)) wakes.changed(wake.sessionId)
      },
    },
    notify: () => events.publish('runs.changed', {}),
  })
  context.runs = runs
  context.stepChats = {
    session: (id) => hub().sessions.get(id, { includeMessages: true }),
    attach: (id, afterSeq, signal) => hub().turns.attach(id, { afterSeq, signal }),
  }
  const hosts = hubEnabled(env)
    ? new Hub({
        env,
        uid: process.getuid?.(),
        publish: (type, data) => events.publish(type, data),
        gui,
        settings: {
          get: (key) => store.getSetting(key),
          put: (key, value) => store.putSetting(key, value, Date.now()),
        },
        isLocalSession: (id) => getWidget(id) !== undefined,
        isLocalRoot: (requestId) => getRootRequest(requestId) !== undefined,
        isLocalRun: (runId) => runs.snapshot().items.some((item) => item.runId === runId),
        leadName,
        claimLocal: (launcherId) => {
          const claimed = claimLauncher(launcherId)
          for (const id of claimed?.changed ?? []) notifySessionChanged(id, { force: true })
          return claimed?.lineage ?? null
        },
      })
    : null
  if (hosts) context.hub = hosts
  const server = createTetherServer(context)
  try {
    await listenPrivateSocket(server, paths.socket)
  } catch (error) {
    store.close()
    throw error
  }
  const ready = startLifecycle({ reconcile: reconcileEnabled(env) })
  hosts?.start()
  // Agent state: hook reports always; the poll only where Tether observes tmux.
  const agentStates = new AgentStateTracker((id) => {
    notifySessionChanged(id, { force: true })
    wakes.scheduler.nudge()
    runs.poke()
  })
  bindAgentStates(agentStates)
  // Agent Hub sessions have no pane: their own state tracker, runtime and
  // poll, none of which the tmux machinery above ever sees.
  const hubRuntime = new AgentHubRuntime({
    api: hub,
    states: new AgentStateTracker((id) => {
      notifySessionChanged(id, { force: true })
      wakes.scheduler.nudge()
      runs.poke()
    }),
    notify: (id) => notifySessionChanged(id, { force: true }),
    verifyStatus: verifySessionStatus,
    ...(resolveSettleMs(env) !== null ? { settleMs: resolveSettleMs(env) as number } : {}),
  })
  bindAgentHub(hubRuntime)
  setHubBackend({
    verify: (row) => hubRuntime.verify(row),
    end: (id, generation) => hubRuntime.end(id, generation),
  })
  const agentPoller = new AgentStatePoller(
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
  )
  if (reconcileEnabled(env)) void ready.then(() => agentPoller.start()).catch(() => {})
  if (reconcileEnabled(env)) void ready.then(() => hubRuntime.start()).catch(() => {})
  if (reconcileEnabled(env)) void ready.then(() => runs.start()).catch(() => {})
  // Wakes paste into sessions, so only where Tether observes tmux.
  if (reconcileEnabled(env)) void ready.then(() => wakes.scheduler.start()).catch(() => {})
  // Display titles name each session's project: learn names now and keep
  // up with renames in SummitFlow.
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
  void context.continuity?.start()
  void ready.then(() => context.recovery?.start()).catch(() => {})
  console.log(`[tether] ${VERSION} instance=${paths.instance} listening on ${paths.socket}`)
  return {
    server,
    store,
    events,
    gui,
    agentHub: hubRuntime,
    hosts,
    ready,
    close: async () => {
      hosts?.close()
      stopLifecycle()
      context.memoryPolicy.stop()
      clearInterval(projectNames)
      agentPoller.stop()
      hubRuntime.stop()
      runs.stop()
      bindAgentHub(null)
      setHubBackend(null)
      wakes.scheduler.stop()
      bindWakeStore(null)
      bindAgentStates(null)
      context.continuity?.stop()
      context.recovery?.stop()
      onAbandonedScope(null)
      setLaunchGuard(null)
      gui.close()
      await closeServer(server)
      // Let in-flight reconciliation settle before the database closes.
      await ready.catch(() => {})
      await flushSessionEvents()
      store.close()
    },
  }
}
