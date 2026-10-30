// `/v1/sessions/:id/files/*`: the session's folder on this machine, read with
// the same rules as the web app's file browser (./browser.ts). A hub forwards
// these routes for a remote session, so the app reads a host's files there.

import { statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { HttpError, type Router, sendJson } from '../http'
import { AccessDenied, InvalidPath, listDirectory, NotFound, readFile } from './browser'

/** The session's folder: undefined for no such session, null when it has none. */
export type SessionFolder = (id: string) => string | null | undefined

const SESSION_ID = /^[0-9a-f]{8}$/

async function folderOf(sessionFolder: SessionFolder, id: string | undefined): Promise<string> {
  const folder = id && SESSION_ID.test(id) ? sessionFolder(id) : undefined
  if (folder === undefined) throw new HttpError(404, 'not_found')
  if (!folder) throw new HttpError(409, 'no_folder', { detail: 'This session has no folder' })
  let isDir = false
  try {
    isDir = statSync(folder).isDirectory()
  } catch {}
  if (!isDir)
    throw new HttpError(409, 'no_folder', { detail: 'This session’s folder no longer exists' })
  return realpath(folder)
}

/** A browser refusal as Tether's error, its plain words as `detail`. */
function refusal(error: unknown): never {
  if (error instanceof HttpError) throw error
  const detail = (error as Error | null)?.message ?? ''
  if (error instanceof AccessDenied) throw new HttpError(403, 'access_denied', { detail })
  if (error instanceof InvalidPath) throw new HttpError(400, 'invalid_path', { detail })
  if (error instanceof NotFound) throw new HttpError(404, 'no_such_file', { detail })
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, 'access_denied', { detail })
  if (code === 'ENOENT') throw new HttpError(404, 'no_such_file', { detail })
  throw error
}

export function registerFileRoutes(router: Router, sessionFolder: SessionFolder): void {
  router
    .add('GET', '/v1/sessions/:id/files/tree', async (_req, res, params, query) => {
      const root = await folderOf(sessionFolder, params.id)
      try {
        sendJson(res, 200, listDirectory(root, query.get('path') ?? ''))
      } catch (error) {
        refusal(error)
      }
    })
    .add('GET', '/v1/sessions/:id/files/content', async (_req, res, params, query) => {
      const path = query.get('path')
      if (path === null) throw new HttpError(400, 'invalid_query', { field: 'path' })
      const root = await folderOf(sessionFolder, params.id)
      try {
        sendJson(res, 200, readFile(root, path))
      } catch (error) {
        refusal(error)
      }
    })
}
