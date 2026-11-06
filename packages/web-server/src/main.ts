// The Aico web server: `node dist/aico-web.mjs`. Settings come from the
// environment and project.identity.json (config.ts). With a command
// (`tsession`, `tclaude`, `tcodex`) the same bundle is the terminal CLI.

import { join } from 'node:path'
import { agentDbPath, ChatSessions, openAgentDb, tetherPush } from '@aico/agent'
import { guestAction, listGuests, proxmoxSshFrom } from '@aico/fleet/power'
import { loadCaptureTypes } from '@aico/notes/capture-types'
import { execRunner, PreviewJobs } from '@aico/notes/heic'
import { extract } from '@aico/notes/vision-extract'
import { realRunners } from '@aico/notes/vision-extract/runners'
import { machineId, StatusStore, statusDbPath } from '@aico/status'
import { openTasksDb, Registry, tasksDbPathFromEnv } from '@aico/tasks'
import { TetherClient } from '@aico/tether-client'
import { buildApi } from './api'
import { AppApi } from './app-api'
import { PhoneRegistry } from './app-phones'
import { Asks, validateAsk } from './asks'
import { Background } from './background'
import { registerBackupRoutes } from './backups'
import { CanaryEvents, createCanaryServer, registerCanaryRoutes } from './canary'
import { CanaryPoller } from './canary-poll'
import { CaptureRouter } from './capture-router'
import { chatStarter } from './chat'
import { readChatAttachments } from './chat-attachments'
import { CLI_COMMANDS, runCli } from './cli'
import { HISTORY_LINES, loadConfig } from './config'
import { registerContextRoutes } from './context'
import { WebStore } from './db'
import { ExtractWorker } from './extract-worker'
import { registerGrantRoutes } from './grants'
import { registerLoginRoutes } from './logins'
import { registerMemoryRoutes } from './memory-routes'
import { registerMockupRoutes } from './mockups'
import { NotesStore } from './notes-db'
import { registerExportRoutes } from './notes-export'
import { NotifyHub } from './notify'
import { NotesOwner } from './owners/notes'
import { PortfolioAiOwner } from './owners/portfolio-ai'
import type { OwnerAdapter } from './owners/types'
import { VehiclesOwner } from './owners/vehicles'
import { Places } from './places'
import { ProjectsService, registerProjectRoutes } from './projects'
import { createWebServer } from './server'
import { createServiceAppsServer } from './service-apps'
import { Shows } from './shows'
import { createStaticSite } from './static'
import { registerStatusRoutes, startSelfRows } from './status'
import { registerStatusActions, StatusRuns, statusNotice } from './status-actions'
import { registerSyncRoutes, startSync } from './sync/start'
import { TerminalHub } from './terminal'
import { registerTrayRoutes } from './tray'

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
  // The paired phones: the sender and the app's API share the file.
  const phones = new PhoneRegistry(config.notify.devicesFile)
  const notify = new NotifyHub({
    config: config.notify,
    dataDir: config.dataDir,
    publicHost: config.publicHost,
    machine,
    status,
    tether,
  })
  const terminals = new TerminalHub({
    tether,
    historyLines: HISTORY_LINES,
    touched: (id) => store.touchLink(id),
  })
  const shows = new Shows({ tether, publicHost: config.publicHost, notices: notify.notifier })
  const blobsDir = join(config.dataDir, 'blobs')
  const asks = new Asks({
    tether,
    publicHost: config.publicHost,
    notices: notify.notifier,
    files: { store: notes, blobsDir, hostName: config.hostName },
    starterOf: (ask) =>
      ask.session && chatsRef?.has(ask.session) ? chatStarter(chatsRef.summary(ask.session)) : null,
    answerUrl: `http://${config.host}:${config.port}`,
  })
  let chatsRef: ChatSessions | undefined
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
    notices: notify.notifier,
  })
  const reader = new ExtractWorker({
    router,
    store: notes,
    blobsDir,
    previews,
    concurrency: config.vision.concurrency,
    extract: (request) => extract(request, config.vision, realRunners),
  })
  const chats = new ChatSessions(openAgentDb(agentDbPath(config.dataDir)), {
    dataDir: config.dataDir,
    push: tetherPush(process.env, (line) => console.warn('[aico-agent]', line)),
    attachments: (ids) =>
      readChatAttachments(ids, { store: notes, blobsDir, limits: config.captures }),
  })
  chatsRef = chats
  asks.onChange = () => chats.changed()
  const background = new Background({
    tether,
    store,
    shows,
    asks,
    trustShows: config.trustShows,
    uploads: config.uploads,
    maintenance: config.maintenance,
    forward: (event) => terminals.event(event),
    askChanged: async (data) => {
      const ask = validateAsk((data as { ask?: unknown })?.ask)
      if (!ask || !asks.routed(ask)) await notify.askChanged(data)
      if (ask?.session && !asks.routed(ask)) await chats.question(ask.session, ask.state === 'open')
      chats.changed()
    },
    tick: () => router.tick(),
  })
  const api = buildApi({
    tether,
    store,
    uploads: config.uploads,
    shows,
    asks,
    chats,
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
  const sync = startSync({ config, store, notes, blobsDir })
  registerContextRoutes(api, {
    dataDir: config.dataDir,
    machine,
    publicHost: config.publicHost,
    tether,
    status,
    notifier: notify.notifier,
  })
  registerMemoryRoutes(api, { dataDir: config.dataDir })
  registerSyncRoutes(api, sync.loop)
  const runs = new StatusRuns()
  registerStatusRoutes(api, status, { changed: notify, machine, running: () => runs.ids() })
  registerStatusActions(api, { status, machine, tether, runs })
  const proxmox = proxmoxSshFrom(process.env)
  const registry = new Registry(openTasksDb(tasksDbPathFromEnv(process.env)))
  const places = new Places({
    declared: () => registry.list().flatMap((project) => project.runtime),
    guests: proxmox
      ? {
          list: () => listGuests(proxmox, config.projects.pveTimeoutMs),
          act: (guest, action) => guestAction(proxmox, guest, action, config.projects.pveTimeoutMs),
        }
      : null,
    status,
    machine,
    pollMs: config.projects.pollMs,
    busyMs: config.projects.busyMs,
  })
  registerProjectRoutes(
    api,
    new ProjectsService({
      registry,
      status,
      tether,
      asks,
      places,
      activityMs: config.projects.activityMs,
    }),
  )
  places.start()
  registerGrantRoutes(api)
  const canaryFolder = join(config.dataDir, 'canary')
  const canaryEvents = new CanaryEvents(canaryFolder)
  const canaryPoller = new CanaryPoller(canaryFolder, notify.notifier, canaryEvents)
  registerCanaryRoutes(api, notify.notifier, canaryFolder, canaryEvents, canaryPoller)
  registerBackupRoutes(api)
  registerLoginRoutes(api, process.env, tether)
  registerMockupRoutes(api, { dataDir: config.dataDir, tether })
  // The phone alert rule: checked on every write of rows. aico-web's own heartbeat writes every
  // few minutes, so a backup or machine row that goes late is seen then too. A notice notify
  // refuses throws, and the batch is offered again on the next pass.
  status.onAlert((batch) => {
    notify.notifier.receive(
      statusNotice(batch, config.publicHost, config.status.alertCooldownS),
      'local',
    )
  })
  notify.register(api)
  registerTrayRoutes(api, { status, notify: notify.store, asks, publicHost: config.publicHost })
  const app = new AppApi({
    pairing: config.pairing,
    phones,
    status,
    notify: notify.store,
    asks,
    machine,
    publicHost: config.publicHost,
    dataDir: config.dataDir,
  })
  app.register(api)
  registerExportRoutes(api, config, sync.loop)
  const server = createWebServer(
    config,
    api,
    terminals,
    createStaticSite(config.staticDir, {
      // The deploy's link to the frontend build it serves (scripts/systemd/aico-web.service).
      served: process.env.AICO_WEB_FRONTEND?.trim() || null,
    }),
  )

  const serviceApps = config.serviceApps.listen
    ? createServiceAppsServer({ status, notify, tether })
    : null
  if (serviceApps && config.serviceApps.listen) {
    const { host, port } = config.serviceApps.listen
    serviceApps.on('error', (error) =>
      console.error('[aico-web] app LAN listener failed:', error.message),
    )
    serviceApps.listen(port, host, () =>
      console.log(`[aico-web] app LAN listener on ${host}:${port}`),
    )
  }

  background.start()
  const canaryListen = process.env.AICO_CANARY_LISTEN
  const canary = canaryListen
    ? createCanaryServer(notify.notifier, canaryFolder, canaryEvents)
    : null
  if (canary && canaryListen) {
    const [host, port] = canaryListen.split(':')
    canary.on('error', () => console.error('[aico-web] canary listener unavailable'))
    canary.listen(Number(port), host)
  }
  notify.start()
  canaryPoller.start(Number(process.env.AICO_CANARY_POLL_SECONDS) || undefined)
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
    void chats.shutdown()
    ;(selfRows as ReturnType<typeof startSelfRows> | null)?.stop(signal)
    canaryPoller.stop()
    canary?.close()
    canary?.closeAllConnections()
    serviceApps?.close()
    serviceApps?.closeAllConnections()
    background.stop()
    places.stop()
    registry.db.close()
    reader.stop()
    terminals.stop()
    app.stop()
    notify.stop()
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
