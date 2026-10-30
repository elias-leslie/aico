// The Aico web server: `node dist/aico-web.mjs`. Settings come from the
// environment and project.identity.json (config.ts). With a command
// (`tsession`, `tclaude`, `tcodex`) the same bundle is the terminal CLI.

import { TetherClient } from 'tether/client'
import { buildApi } from './api'
import { Asks } from './asks'
import { Background } from './background'
import { CLI_COMMANDS, runCli } from './cli'
import { HISTORY_LINES, loadConfig } from './config'
import { WebStore } from './db'
import { registerNightshiftRoutes } from './nightshift'
import { createWebServer } from './server'
import { Shows } from './shows'
import { createStaticSite } from './static'
import { TerminalHub } from './terminal'

function serve(): void {
  const config = loadConfig()
  const store = new WebStore(config.dbPath)

  const tether = new TetherClient(config.tetherSocket)
  const terminals = new TerminalHub({
    tether,
    historyLines: HISTORY_LINES,
    touched: (id) => store.touchLink(id),
  })
  const shows = new Shows({ tether, publicHost: config.publicHost })
  const asks = new Asks({ tether, publicHost: config.publicHost })
  const background = new Background({
    tether,
    store,
    shows,
    asks,
    trustShows: config.trustShows,
    uploads: config.uploads,
    maintenance: config.maintenance,
    forward: (event) => terminals.event(event),
  })
  const api = buildApi({ tether, store, config, uploads: config.uploads, shows, asks })
  registerNightshiftRoutes(api, config)
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
  server.listen(config.port, config.host, () => {
    console.log(`[aico-web] listening on http://${config.host}:${config.port}`)
  })

  let stopping = false
  function shutdown(signal: string): void {
    if (stopping) return
    stopping = true
    console.log(`[aico-web] ${signal}: stopping`)
    background.stop()
    terminals.stop()
    server.close(() => {
      store.close()
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
