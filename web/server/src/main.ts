// The Aico web server: `node dist/aico-web.mjs`. Settings come from the
// environment and project.identity.json (config.ts).

import { TetherClient } from 'tether/client'
import { buildApi } from './api'
import { HISTORY_LINES, loadConfig } from './config'
import { WebStore } from './db'
import { createWebServer } from './server'
import { TerminalHub } from './terminal'

const config = loadConfig()
const store = new WebStore(config.dbPath)
const imported = store.importOnce(config.importDbPath)
if (imported)
  console.log(
    `[aico-web] imported ${imported.projects} project settings, ${imported.panes} tabs, ${imported.links} session links from ${imported.source}`,
  )

const tether = new TetherClient(config.tetherSocket)
const terminals = new TerminalHub({
  tether,
  historyLines: HISTORY_LINES,
  touched: (id) => store.touchLink(id),
})
const server = createWebServer(config, buildApi({ tether, store, config }), terminals)

terminals.start()
server.listen(config.port, config.host, () => {
  console.log(`[aico-web] listening on http://${config.host}:${config.port}`)
})

let stopping = false
function shutdown(signal: string): void {
  if (stopping) return
  stopping = true
  console.log(`[aico-web] ${signal}: stopping`)
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
