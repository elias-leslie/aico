import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(frontendRoot, '..')
const envFiles = [path.join(repoRoot, '.env'), path.join(repoRoot, '.env.local')]

function loadRepoEnv() {
  const values = {}

  for (const envFile of envFiles) {
    if (!fs.existsSync(envFile)) {
      continue
    }

    for (const rawLine of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#') || !rawLine.includes('=')) {
        continue
      }
      const separator = rawLine.indexOf('=')
      const key = rawLine.slice(0, separator).trim()
      let value = rawLine.slice(separator + 1).trim()
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1)
      }
      values[key] = value
    }
  }

  return values
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: frontendRoot,
      env,
      stdio: 'inherit',
    })
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code ?? 'unknown'}`))
    })
    child.on('error', reject)
  })
}

const repoEnv = loadRepoEnv()
const backendPort =
  process.env.A_TERM_PORT?.trim() ||
  repoEnv.A_TERM_PORT?.trim() ||
  '8002'
const apiUrl =
  process.env.API_URL?.trim() ||
  process.env.NEXT_PUBLIC_A_TERM_API_URL?.trim() ||
  `http://127.0.0.1:${backendPort}`

const buildEnv = {
  ...process.env,
  A_TERM_PORT: backendPort,
  API_URL: apiUrl,
}

await run('next', ['build'], buildEnv)
await run('node', ['scripts/prepare-standalone.mjs'], buildEnv)
