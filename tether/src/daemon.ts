import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import type { Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHubApi } from './agent-hub/client'
import { resolveAgentHubConfig, resolveRunsConfig } from './agent-hub/config'
import { RunTracker } from './agent-hub/runs'
import { AgentHubRuntime, type HubApi } from './agent-hub/runtime'
import { AgentStatePoller, AgentStateTracker } from './agent-state'
import { agentExitMarkerDir, resolveShowConfig, type TetherPaths } from './config'
import { nodeProcFs } from './continuity'
import { parseGraphicalEnvironment } from './env'
import { EventBus } from './events'
import { GuiChannel } from './gui-channel'
import { listenPrivateSocket } from './http'
import { bindCatalog, getWidget, listWidgets } from './lifecycle/catalog'
import { setPersonalWorkspaceRoot } from './lifecycle/display'
import {
  cachedSessionStatus,
  configureEngine,
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
import { createTetherServer } from './server'
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
  /** Resolves when startup reconciliation has finished (or was skipped). */
  ready: Promise<void>
  close(): Promise<void>
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

function readTold(raw: string | null): Record<string, { key: string; at: number }> {
  try {
    const value = JSON.parse(raw ?? '{}') as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => {
        const e = entry as { key?: unknown; at?: unknown } | null
        return typeof e?.key === 'string' && typeof e.at === 'number' && Number.isFinite(e.at)
      }),
    ) as Record<string, { key: string; at: number }>
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
    onAbandonedScope((event) => void recovery.onAbandoned(event))
    setLaunchGuard((id) => recovery.holdsLaunch(id))
    context.continuity = continuity
    context.recovery = recovery
  }
  const wakes = new WakeService(context)
  context.wakes = wakes
  bindWakeStore(wakes.store)
  // One Agent Hub client for the session kind and for the workflow runs.
  let hubApi: HubApi | null = null
  const hub = (): HubApi => {
    hubApi ??= createHubApi(resolveAgentHubConfig(env))
    return hubApi
  }
  const runs = new RunTracker({
    api: () => hub().workflowRuns,
    launchers: () => listWidgets().map((row) => ({ id: row.id, ownershipId: row.sessionId })),
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
        wakes.store.add({ sessionId: row.id, dueAt: now, note, createdBy: 'agent', now })
        wakes.changed(row.id)
        return true
      },
    },
    notify: () => events.publish('runs.changed', {}),
  })
  context.runs = runs
  context.stepChats = {
    session: (id) => hub().sessions.get(id, { includeMessages: true }),
    attach: (id, afterSeq, signal) => hub().turns.attach(id, { afterSeq, signal }),
  }
  const server = createTetherServer(context)
  try {
    await listenPrivateSocket(server, paths.socket)
  } catch (error) {
    store.close()
    throw error
  }
  const ready = startLifecycle({ reconcile: reconcileEnabled(env) })
  // Agent state: hook reports always; the poll only where Tether observes tmux.
  const agentStates = new AgentStateTracker((id) => {
    notifySessionChanged(id, { force: true })
    wakes.scheduler.nudge()
  })
  bindAgentStates(agentStates)
  // Agent Hub sessions have no pane: their own state tracker, runtime and
  // poll, none of which the tmux machinery above ever sees.
  const hubRuntime = new AgentHubRuntime({
    api: hub,
    states: new AgentStateTracker((id) => {
      notifySessionChanged(id, { force: true })
      wakes.scheduler.nudge()
    }),
    notify: (id) => notifySessionChanged(id, { force: true }),
    verifyStatus: verifySessionStatus,
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
    ready,
    close: async () => {
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
