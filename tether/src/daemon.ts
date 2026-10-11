import { chmodSync, mkdirSync } from 'node:fs'
import type { Server } from 'node:http'
import type { TetherPaths } from './config'
import { EventBus } from './events'
import { listenPrivateSocket } from './http'
import { ProjectProvider, summitflowUrlFromEnv } from './projects'
import { createTetherServer } from './server'
import { Store } from './store'
import { VERSION } from './version'

export interface RunningDaemon {
  server: Server
  store: Store
  events: EventBus
  close(): Promise<void>
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
  const server = createTetherServer({ paths, store, events, projects, startedAt: Date.now() })
  try {
    // TODO(phase3): the default instance also serves the legacy Aico sockets
    // (paths.legacyControlSocket, paths.legacyGuiSocket) once aico-owner is retired.
    await listenPrivateSocket(server, paths.socket)
  } catch (error) {
    store.close()
    throw error
  }
  console.log(`[tether] ${VERSION} instance=${paths.instance} listening on ${paths.socket}`)
  return {
    server,
    store,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          store.close()
          resolve()
        })
        server.closeAllConnections()
      }),
  }
}
