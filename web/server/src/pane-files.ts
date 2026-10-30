// The file browser's routes (the Python backend's api/pane_files.py): a tab's
// root is its shell's working directory (else its active session's, else any
// session's); tether/files keeps every read inside it. A session on another
// host is read there: Tether's hub forwards its files routes to that host.

import { statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type TetherClient, TetherError } from 'tether/client'
import { AccessDenied, InvalidPath, listDirectory, NotFound, readFile } from 'tether/files'
import type { Router } from './http'
import type { Lifecycle } from './lifecycle'
import { SHELL_MODE } from './sessions'
import { HttpError, toHttpError } from './tether'

const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i

function validateUuid(value: string): void {
  if (!UUID.test(value)) throw new HttpError(400, 'Invalid UUID')
}

/** Where a tab's files are: a folder here, or a session's folder on its host. */
type PaneFolder = { root: string } | { host: string; sessionId: string }

async function paneFolder(life: Lifecycle, paneId: string): Promise<PaneFolder> {
  const { pane } = await life.paneById(paneId, false)
  const withDir = pane.sessions.filter((session) => session.working_dir)
  const chosen =
    withDir.find((session) => session.mode === SHELL_MODE) ??
    withDir.find((session) => session.mode === pane.active_mode) ??
    withDir[0]
  // Its folder is on that host; this computer's copy at the same path would be the wrong files.
  if (chosen?.host) return { host: chosen.host, sessionId: chosen.id }
  const workingDir = chosen?.working_dir
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
  return { root: await realpath(root) }
}

/** The host's answer to `GET /v1/sessions/:id/files/<route>`, its refusals in plain words. */
async function remoteFiles(
  tether: TetherClient,
  folder: { host: string; sessionId: string },
  route: 'tree' | 'content',
  path: string,
): Promise<unknown> {
  const query = route === 'tree' && !path ? '' : `?${new URLSearchParams({ path })}`
  try {
    const { body } = await tether.request<Record<string, unknown>>(
      'GET',
      `/v1/sessions/${encodeURIComponent(folder.sessionId)}/files/${route}${query}`,
    )
    const { host: _host, ...answer } = body
    return answer
  } catch (error) {
    if (!(error instanceof TetherError)) throw toHttpError(error)
    const { host } = folder
    // Off or unreachable: worth trying again once it is back.
    if (error.code === 'host_unavailable')
      throw new HttpError(503, `${toHttpError(error).detail}, so its files can’t be shown.`, error)
    if (typeof error.body.detail === 'string')
      throw new HttpError(error.status, error.body.detail, error)
    // A host whose Tether predates the files routes answers an unknown route.
    if (error.code === 'not_found' || error.code === 'method_not_allowed')
      throw new HttpError(409, `${host} needs an update before its files can be shown here.`, error)
    throw toHttpError(error)
  }
}

export function translate(error: unknown): HttpError {
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

export function registerPaneFileRoutes(
  router: Router,
  life: Lifecycle,
  tether: TetherClient,
): void {
  router.on('GET', '/api/panes/:paneId/files/tree', async (ctx) => {
    validateUuid(ctx.params.paneId)
    const folder = await paneFolder(life, ctx.params.paneId)
    const path = ctx.query.get('path') ?? ''
    if ('host' in folder) return remoteFiles(tether, folder, 'tree', path)
    try {
      return listDirectory(folder.root, path)
    } catch (error) {
      throw translate(error)
    }
  })

  router.on('GET', '/api/panes/:paneId/files/content', async (ctx) => {
    validateUuid(ctx.params.paneId)
    const path = ctx.query.get('path')
    if (path === null) throw new HttpError(422, 'path is required')
    const folder = await paneFolder(life, ctx.params.paneId)
    if ('host' in folder) return remoteFiles(tether, folder, 'content', path)
    try {
      return readFile(folder.root, path)
    } catch (error) {
      throw translate(error)
    }
  })
}
