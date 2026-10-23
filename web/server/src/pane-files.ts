// The file browser's routes (the Python backend's api/pane_files.py): a tab's
// root is its shell's working directory (else its active session's, else any
// session's); file-browser.ts keeps every read inside it.

import { statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AccessDenied, InvalidPath, listDirectory, NotFound, readFile } from './file-browser'
import type { Router } from './http'
import type { Lifecycle } from './lifecycle'
import { SHELL_MODE } from './sessions'
import { HttpError } from './tether'

const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i

function validateUuid(value: string): void {
  if (!UUID.test(value)) throw new HttpError(400, 'Invalid UUID')
}

async function paneRoot(life: Lifecycle, paneId: string): Promise<string> {
  const { pane } = await life.paneById(paneId, false)
  const withDir = pane.sessions.filter((session) => session.working_dir)
  const workingDir = (
    withDir.find((session) => session.mode === SHELL_MODE) ??
    withDir.find((session) => session.mode === pane.active_mode) ??
    withDir[0]
  )?.working_dir
  if (!workingDir) throw new HttpError(400, 'Pane has no working directory')
  const root =
    workingDir === '~'
      ? homedir()
      : workingDir.startsWith('~/')
        ? join(homedir(), workingDir.slice(2))
        : workingDir
  let isDir: boolean
  try {
    isDir = statSync(root).isDirectory()
  } catch {
    throw new HttpError(404, 'Pane working directory does not exist')
  }
  if (!isDir) throw new HttpError(400, 'Pane working directory is not a directory')
  return realpath(root)
}

function translate(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof AccessDenied) return new HttpError(403, error.message)
  if (error instanceof InvalidPath) return new HttpError(400, error.message)
  if (error instanceof NotFound) return new HttpError(404, error.message)
  const code = (error as NodeJS.ErrnoException | null)?.code
  const message = (error as Error | null)?.message ?? ''
  if (code === 'EACCES' || code === 'EPERM') return new HttpError(403, message)
  if (code === 'ENOENT') return new HttpError(404, message)
  console.error('[aico-web] pane file browse failed:', error)
  return new HttpError(500, 'Failed to browse pane files')
}

export function registerPaneFileRoutes(router: Router, life: Lifecycle): void {
  router.on('GET', '/api/panes/:paneId/files/tree', async (ctx) => {
    validateUuid(ctx.params.paneId)
    const root = await paneRoot(life, ctx.params.paneId)
    try {
      return listDirectory(root, ctx.query.get('path') ?? '')
    } catch (error) {
      throw translate(error)
    }
  })

  router.on('GET', '/api/panes/:paneId/files/content', async (ctx) => {
    validateUuid(ctx.params.paneId)
    const path = ctx.query.get('path')
    if (path === null) throw new HttpError(422, 'path is required')
    const root = await paneRoot(life, ctx.params.paneId)
    try {
      return readFile(root, path)
    } catch (error) {
      throw translate(error)
    }
  })
}
