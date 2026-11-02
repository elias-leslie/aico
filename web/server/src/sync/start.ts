// Wires sync into the server: the unix-socket listener, the pull loop, the
// local-write nudge, and the Hosts status route.

import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { syncPeers } from 'tether/client'
import type { WebConfig } from '../config'
import type { WebStore } from '../db'
import type { Router } from '../http'
import type { NotesStore } from '../notes-db'
import { SyncLoop } from './loop'
import { unixPeer } from './peer'
import { createSyncServer, listenUnix } from './server'

export interface Sync {
  loop: SyncLoop
  stop(): void
}

export function startSync(options: {
  config: WebConfig
  store: WebStore
  notes: NotesStore
  blobsDir: string
  log?: (message: string) => void
}): Sync {
  const { config, store, notes, blobsDir } = options
  const log = options.log ?? ((message) => console.log(`[aico-web] sync ${message}`))
  const loop = new SyncLoop({
    notes: notes.syncHandle(),
    web: store.syncHandle(),
    blobsDir,
    peers: () => {
      try {
        return syncPeers(
          readFileSync(config.sync.hostsFile, 'utf8'),
          process.env,
          process.getuid?.(),
        )
      } catch {
        return []
      }
    },
    connect: (peer) => unixPeer(peer.socket, { idleMs: config.sync.idleMs }),
    now: Date.now,
    buildId: config.buildId,
    tombstoneMs: config.sync.tombstoneMs,
    maxAheadMs: config.sync.maxAheadMs,
    blobGraceMs: config.sync.blobGraceMs,
    intervalMs: config.sync.intervalMs,
    watchMs: config.sync.watchMs,
    log,
  })
  const server: Server = createSyncServer({
    hostName: config.hostName,
    buildId: config.buildId,
    handles: [notes.syncHandle(), store.syncHandle()],
    blobsDir,
    now: Date.now,
    nudged: () => loop.nudged(),
  })
  listenUnix(server, config.sync.socket).then(
    () => log(`listening on ${config.sync.socket}`),
    (error) => log(`cannot listen on ${config.sync.socket}: ${(error as Error).message}`),
  )
  loop.start()
  return {
    loop,
    stop() {
      loop.stop()
      server.close()
      server.closeAllConnections()
    },
  }
}

/** `GET /api/sync/status`: each peer that syncs, for the Hosts sheet. */
export function registerSyncRoutes(router: Router, loop: SyncLoop): void {
  router.on('GET', '/api/sync/status', () => ({ items: loop.status() }))
}
