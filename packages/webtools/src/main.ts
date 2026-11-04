// The `aico web` entry point (bundled to dist/aico-webtools.mjs).

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { machineId } from '@aico/status'
import { runWebCli } from './cli'

const env = process.env

/** aico-web's Status endpoint: AICO_WEB_URL, else loopback on AICO_WEB_PORT or the identity file's port. */
function statusUrl(): string | null {
  let base = env.AICO_WEB_URL?.trim()
  if (!base) {
    let port = Number(env.AICO_WEB_PORT)
    for (let dir = dirname(fileURLToPath(import.meta.url)); !port; dir = resolve(dir, '..')) {
      const file = join(dir, 'project.identity.json')
      if (existsSync(file)) {
        try {
          port = Number(JSON.parse(readFileSync(file, 'utf8')).runtime?.backend_port)
        } catch {}
        break
      }
      if (dirname(dir) === dir) break
    }
    base = port ? `http://127.0.0.1:${port}` : undefined
  }
  return base ? new URL('/api/status/rows', base).toString() : null
}

process.exitCode = await runWebCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  dataDir: resolve(
    env.AICO_DATA_DIR?.trim() ||
      join(env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state'), 'aico'),
  ),
  env,
  fetch,
  now: () => new Date(),
  machine: machineId(),
  statusUrl: statusUrl(),
})
