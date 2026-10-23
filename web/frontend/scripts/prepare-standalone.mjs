import { cp, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(scriptDir, '..')
const nextRoot = path.join(frontendRoot, '.next')
const standaloneRoot = path.join(nextRoot, 'standalone')
const standaloneNextRoot = path.join(standaloneRoot, '.next')
const staticSource = path.join(nextRoot, 'static')
const staticTarget = path.join(standaloneNextRoot, 'static')
const publicSource = path.join(frontendRoot, 'public')
const publicTarget = path.join(standaloneRoot, 'public')

async function ensurePath(sourcePath, label) {
  try {
    await stat(sourcePath)
  } catch {
    throw new Error(`Expected ${label} at ${sourcePath} after next build`)
  }
}

async function replaceCopy(sourcePath, targetPath) {
  await rm(targetPath, { force: true, recursive: true })
  await mkdir(path.dirname(targetPath), { recursive: true })
  await cp(sourcePath, targetPath, { recursive: true })
}

await ensurePath(standaloneRoot, 'standalone output')
await ensurePath(staticSource, 'static assets')
await ensurePath(publicSource, 'public assets')

await mkdir(standaloneNextRoot, { recursive: true })
await replaceCopy(staticSource, staticTarget)
await replaceCopy(publicSource, publicTarget)
