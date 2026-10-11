import { chmodSync, mkdirSync } from 'node:fs'
import type { Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TetherPaths } from './config'
import { EventBus } from './events'
import { GuiChannel } from './gui-channel'
import { listenPrivateSocket } from './http'
import { LegacyATermSessions, legacyATermSocket } from './legacy-aterm'
import { bindCatalog } from './lifecycle/catalog'
import {
  configureEngine,
  endSession,
  flushSessionEvents,
  setGenerationFunction,
  setSessionSnapshotFunction,
  startLifecycle,
  stopLifecycle,
  verifiedCurrentManagedPane,
} from './lifecycle/engine'
import { createOwnerServer, listenOwnerServer } from './lifecycle/owner-control'
import { setLifecycleInstance } from './lifecycle/ownership'
import { createRootServer } from './lifecycle/root-control'
import { configureTmuxPaths } from './lifecycle/tmux'
import { bindToolSource } from './lifecycle/tui/registry'
import { generationOf, rootOperations, sessionSnapshot } from './lifecycle-api'
import { activeProjectFileFromEnv, ProjectProvider, summitflowUrlFromEnv } from './projects'
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

const LEGACY_WATCH_MS = 15_000

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
  const store = new Store(paths.dbPath)
  const events = new EventBus()
  const projects = new ProjectProvider({
    summitflowUrl: summitflowUrlFromEnv(env),
    localFile: paths.localProjectsFile,
  })
  const gui = new GuiChannel(events)
  const legacy = new LegacyATermSessions(legacyATermSocket(paths, env), (names) =>
    events.publish('legacy.changed', { names }),
  )
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
  })

  const context = {
    paths,
    store,
    events,
    projects,
    gui,
    legacy,
    projectRoots,
    activeProjectFile: activeProjectFileFromEnv(env, env.HOME ?? homedir()),
    startedAt: Date.now(),
  }
  const server = createTetherServer(context)
  const legacyServers: Server[] = []
  try {
    await listenPrivateSocket(server, paths.socket)
  } catch (error) {
    store.close()
    throw error
  }
  const ready = startLifecycle({ reconcile: reconcileEnabled(env) })
  // Announce legacy A-Term sessions that end or exit outside Tether.
  if (reconcileEnabled(env)) legacy.watch(LEGACY_WATCH_MS)

  // Default instance only: Aico's exact legacy sockets, sharing the one
  // lifecycle lock and End path with the v1 API.
  if (paths.legacy && paths.legacyControlSocket && paths.legacyGuiSocket) {
    try {
      const owner = createOwnerServer({
        verifiedCurrentPane: async (row) => Boolean(await verifiedCurrentManagedPane(row)),
        end: endSession,
      })
      await listenOwnerServer(owner, paths.legacyControlSocket)
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
      legacy.unwatch()
      gui.close()
      await Promise.all([...legacyServers, server].map(closeServer))
      // Let in-flight reconciliation settle before the database closes.
      await ready.catch(() => {})
      await flushSessionEvents()
      store.close()
    },
  }
}
