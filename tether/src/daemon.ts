import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import type { Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgentStatePoller, AgentStateTracker } from './agent-state'
import { agentExitMarkerDir, type TetherPaths } from './config'
import { nodeProcFs } from './continuity'
import { parseGraphicalEnvironment } from './env'
import { EventBus } from './events'
import { GuiChannel } from './gui-channel'
import { listenPrivateSocket } from './http'
import { bindCatalog, listWidgets } from './lifecycle/catalog'
import { setPersonalWorkspaceRoot } from './lifecycle/display'
import {
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
} from './lifecycle/engine'
import { createOwnerServer } from './lifecycle/owner-control'
import { setLifecycleInstance } from './lifecycle/ownership'
import { createRootServer } from './lifecycle/root-control'
import { configureTmuxPaths } from './lifecycle/tmux'
import { bindToolSource } from './lifecycle/tui/registry'
import {
  bindAgentStates,
  foregroundPaneScope,
  generationOf,
  learnProjects,
  rootOperations,
  sessionSnapshot,
} from './lifecycle-api'
import { startMemoryGuard } from './memory-guard'
import { activeProjectFileFromEnv, ProjectProvider, summitflowUrlFromEnv } from './projects'
import { Continuity } from './reboot'
import { Recovery } from './recovery'
import { createTetherServer } from './server'
import { Store } from './store'
import { VERSION } from './version'

export interface RunningDaemon {
  server: Server
  store: Store
  events: EventBus
  gui: GuiChannel
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
      // A shared-mode instance runs for a user with no desktop; TETHER_HEADLESS=1
      // says the same for any other instance. Neither waits for DISPLAY.
      headless: paths.shared !== null || env.TETHER_HEADLESS === '1',
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
  const server = createTetherServer(context)
  const legacyServers: Server[] = []
  try {
    await listenPrivateSocket(server, paths.socket, { shared: paths.shared !== null })
  } catch (error) {
    store.close()
    throw error
  }
  const ready = startLifecycle({ reconcile: reconcileEnabled(env) })
  // Agent state: hook reports always; the poll only where Tether observes tmux.
  const agentStates = new AgentStateTracker((id) => notifySessionChanged(id, { force: true }))
  bindAgentStates(agentStates)
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
  // Default instance only: Aico's exact legacy sockets, sharing the one
  // lifecycle lock and End path with the v1 API.
  if (paths.legacy && paths.legacyControlSocket && paths.legacyGuiSocket) {
    try {
      const owner = createOwnerServer({
        verifiedCurrentPane: async (row) => Boolean(await verifiedCurrentManagedPane(row)),
        end: endSession,
      })
      await listenPrivateSocket(owner, paths.legacyControlSocket)
      legacyServers.push(owner)
      const guiShim = createRootServer(rootOperations(context))
      await listenPrivateSocket(guiShim, paths.legacyGuiSocket)
      legacyServers.push(guiShim)
    } catch (error) {
      console.error('[tether] legacy Aico sockets unavailable:', error)
    }
  }

  console.log(`[tether] ${VERSION} instance=${paths.instance} listening on ${paths.socket}`)
  return {
    server,
    store,
    events,
    gui,
    ready,
    close: async () => {
      stopLifecycle()
      context.memoryPolicy.stop()
      clearInterval(projectNames)
      agentPoller.stop()
      bindAgentStates(null)
      context.continuity?.stop()
      context.recovery?.stop()
      onAbandonedScope(null)
      setLaunchGuard(null)
      gui.close()
      await Promise.all([...legacyServers, server].map(closeServer))
      // Let in-flight reconciliation settle before the database closes.
      await ready.catch(() => {})
      await flushSessionEvents()
      store.close()
    },
  }
}
