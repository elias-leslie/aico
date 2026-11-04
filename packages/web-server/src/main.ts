// The Aico web server: `node dist/aico-web.mjs`. Settings come from the
// environment and project.identity.json (config.ts). With a command
// (`tsession`, `tclaude`, `tcodex`) the same bundle is the terminal CLI.

import { join } from 'node:path'
import { loadCaptureTypes } from '@aico/notes/capture-types'
import { execRunner, PreviewJobs } from '@aico/notes/heic'
import { extract } from '@aico/notes/vision-extract'
import { realRunners } from '@aico/notes/vision-extract/runners'
import { machineId, StatusStore, statusDbPath } from '@aico/status'
import { TetherClient } from '@aico/tether-client'
import { buildApi } from './api'
import { Asks } from './asks'
import { Background } from './background'
import { CaptureRouter } from './capture-router'
import { CLI_COMMANDS, runCli } from './cli'
import { HISTORY_LINES, loadConfig } from './config'
import { WebStore } from './db'
import { ExtractWorker } from './extract-worker'
import { registerNightshiftRoutes } from './nightshift'
import { NightshiftRelay, registerNightshiftStream } from './nightshift-stream'
import { NotesStore } from './notes-db'
import { registerExportRoutes } from './notes-export'
import { NotesOwner } from './owners/notes'
import { PortfolioAiOwner } from './owners/portfolio-ai'
import type { OwnerAdapter } from './owners/types'
import { VehiclesOwner } from './owners/vehicles'
import { createWebServer } from './server'
import { Shows } from './shows'
import { createStaticSite } from './static'
import { exportRow, registerStatusRoutes, startSelfRows } from './status'
import { registerSyncRoutes, startSync } from './sync/start'
import { TerminalHub } from './terminal'

function serve(): void {
  const config = loadConfig()
  const store = new WebStore(config.dbPath, { hostName: config.hostName })
  const notes = new NotesStore(join(config.dataDir, 'notes.db'), {
    hostName: config.hostName,
    revisionWindowMs: config.notes.revisionWindowMs,
  })
  const status = new StatusStore(statusDbPath(config.dataDir))
  // Status rows name the machine by its short host name, as every other writer does.
  const machine = machineId()

  const tether = new TetherClient(config.tetherSocket)
  const terminals = new TerminalHub({
    tether,
    historyLines: HISTORY_LINES,
    touched: (id) => store.touchLink(id),
  })
  const shows = new Shows({ tether, publicHost: config.publicHost })
  const blobsDir = join(config.dataDir, 'blobs')
  const asks = new Asks({
    tether,
    publicHost: config.publicHost,
    files: { store: notes, blobsDir, hostName: config.hostName },
  })
  const previews = new PreviewJobs(blobsDir, execRunner)
  const adapters = new Map<string, OwnerAdapter>([['notes', new NotesOwner(notes)]])
  if (config.portfolio.url) {
    const portfolio = { url: config.portfolio.url, tokenFile: config.portfolio.tokenFile }
    adapters.set('portfolio-ai', new PortfolioAiOwner(portfolio))
    adapters.set('vehicles', new VehiclesOwner(portfolio))
  }
  const router = new CaptureRouter({
    store: notes,
    blobsDir,
    table: loadCaptureTypes(config.captureTypesFile),
    adapters,
    ownerUrls: {
      'portfolio-ai':
        config.portfolio.appUrl && `${config.portfolio.appUrl.replace(/\/+$/, '')}/capture`,
      vehicles:
        config.portfolio.appUrl && `${config.portfolio.appUrl.replace(/\/+$/, '')}/vehicles`,
    },
    publicHost: config.publicHost,
  })
  const reader = new ExtractWorker({
    router,
    store: notes,
    blobsDir,
    previews,
    concurrency: config.vision.concurrency,
    extract: (request) => extract(request, config.vision, realRunners),
  })
  const background = new Background({
    tether,
    store,
    shows,
    asks,
    trustShows: config.trustShows,
    uploads: config.uploads,
    maintenance: config.maintenance,
    forward: (event) => terminals.event(event),
    tick: () => router.tick(),
  })
  const api = buildApi({
    tether,
    store,
    config,
    uploads: config.uploads,
    shows,
    asks,
    captures: {
      store: notes,
      blobsDir,
      limits: config.captures,
      asks,
      previews,
      reader,
      router,
    },
  })
  registerNightshiftRoutes(api, config)
  const sync = startSync({ config, store, notes, blobsDir })
  registerSyncRoutes(api, sync.loop)
  registerStatusRoutes(api, status)
  registerExportRoutes(api, config, sync.loop, (result) => {
    try {
      status.upsert([exportRow(machine, result, Date.now(), config.export.dueMs)])
    } catch (error) {
      console.error('[aico-web] notes export status row failed:', error)
    }
  })
  const nightshift = new NightshiftRelay(config)
  registerNightshiftStream(api, nightshift)
  const server = createWebServer(
    config,
    api,
    terminals,
    createStaticSite(config.staticDir, {
      agentHubUrl: config.agentHubUrl,
      agentHubPort: config.agentHubPort,
    }),
  )

  background.start()
  reader.start()
  let selfRows: ReturnType<typeof startSelfRows> | null = null
  server.listen(config.port, config.host, () => {
    console.log(`[aico-web] listening on http://${config.host}:${config.port}`)
    selfRows = startSelfRows({
      status,
      hostName: machine,
      address: `${config.host}:${config.port}`,
      heartbeatMs: config.status.heartbeatMs,
    })
  })

  let stopping = false
  function shutdown(signal: string): void {
    if (stopping) return
    stopping = true
    console.log(`[aico-web] ${signal}: stopping`)
    ;(selfRows as ReturnType<typeof startSelfRows> | null)?.stop(signal)
    background.stop()
    reader.stop()
    terminals.stop()
    nightshift.stop()
    sync.stop()
    server.close(() => {
      store.close()
      notes.close()
      status.close()
      process.exit(0)
    })
    server.closeAllConnections()
    setTimeout(() => process.exit(0), 5_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

const [command, ...args] = process.argv.slice(2)
if (command !== undefined && CLI_COMMANDS.includes(command)) {
  runCli(command, args).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error)
      process.exitCode = 1
    },
  )
} else if (command !== undefined) {
  console.error(`aico-web: unknown command '${command}' (commands: ${CLI_COMMANDS.join(', ')})`)
  process.exitCode = 2
} else {
  serve()
}
