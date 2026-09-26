import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createOwnerServer, listenOwnerServer, ownerSocketPath } from './owner-control'
import { headlessRetirementOperations } from './owner-runtime'
import { initStore } from './store'

const stateDir = process.env.AICO_STATE_DIR ?? join(homedir(), '.local', 'state', 'aico')
mkdirSync(stateDir, { recursive: true, mode: 0o700 })
initStore(join(stateDir, 'aico.db'))

const server = createOwnerServer(headlessRetirementOperations)
const socket = ownerSocketPath()
await listenOwnerServer(server, socket)
console.log(`[aico:owner] listening on ${socket}`)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
