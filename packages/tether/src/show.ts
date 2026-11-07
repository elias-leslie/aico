import { isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ShowConfig } from './config'
import type { EventBus } from './events'
import { HttpError, type Router, readJsonObject, sendJson } from './http'
import type { Hub } from './hub/hub'
import { realPaths, ShareStore, type ShowRequest } from './shares'

/** The most files and folders one share may name. */
const MAX_SHARE_PATHS = 20

const CONTROLS = /[\p{Cc}\p{Cf}\u2028\u2029]/u

function parseShow(body: Record<string, unknown>): ShowRequest {
  const unknown = Object.keys(body).filter(
    (key) => !['session', 'title', 'url', 'path', 'paths'].includes(key),
  )
  if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
  for (const key of ['session', 'title', 'url', 'path']) {
    if (body[key] !== undefined && typeof body[key] !== 'string') {
      throw new HttpError(400, 'invalid_body', { field: key })
    }
  }
  const session = (body.session as string | undefined) ?? null
  if (session !== null && !/^[0-9a-f]{8}$/.test(session)) {
    throw new HttpError(400, 'invalid_body', { field: 'session' })
  }
  const title = (body.title as string | undefined) ?? null
  if (
    title !== null &&
    (title.length === 0 || Array.from(title).length > 120 || CONTROLS.test(title))
  ) {
    throw new HttpError(400, 'invalid_body', { field: 'title' })
  }
  const given = ['url', 'path', 'paths'].filter((key) => body[key] !== undefined)
  if (given.length !== 1) {
    throw new HttpError(400, 'invalid_body', {
      detail: 'provide exactly one of url, path or paths',
    })
  }
  if (typeof body.url === 'string') {
    const url = body.url
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new HttpError(400, 'invalid_body', { field: 'url' })
    }
    if (
      Array.from(url).length > 2000 ||
      CONTROLS.test(url) ||
      url.trim() !== url ||
      !/^https?:\/\//i.test(url) ||
      !['http:', 'https:'].includes(parsed.protocol)
    ) {
      throw new HttpError(400, 'invalid_body', { field: 'url' })
    }
    return { session, title, kind: 'url', url }
  }
  const paths = body.paths === undefined ? [body.path] : body.paths
  if (
    !Array.isArray(paths) ||
    paths.length < 1 ||
    paths.length > MAX_SHARE_PATHS ||
    !paths.every(
      (path) =>
        typeof path === 'string' && isAbsolute(path) && path.length <= 4096 && !CONTROLS.test(path),
    )
  ) {
    throw new HttpError(400, 'invalid_body', { field: body.paths === undefined ? 'path' : 'paths' })
  }
  return { session, title, kind: 'files', paths: paths as string[] }
}

export function registerShowRoute(
  router: Router,
  events: EventBus,
  store: { db: DatabaseSync },
  config: ShowConfig,
  /** `GET /v1/shares?hosts=all` adds the linked hosts' shares. */
  hub?: Pick<Hub, 'mergeShares'> | null,
): void {
  const shares = new ShareStore(store.db, config)
  router
    .add('POST', '/v1/show', async (req, res) => {
      const request = parseShow(await readJsonObject(req))
      if (request.kind === 'files') request.paths = await realPaths(request.paths)
      const share = shares.add(request)
      events.publish('show.requested', share)
      sendJson(res, 201, share)
    })
    .add('DELETE', '/v1/shares/:id', (_req, res, params) => {
      const id = params.id ?? ''
      if (!/^[0-9a-f]{12}$/.test(id) || !shares.remove(id)) throw new HttpError(404, 'not_found')
      sendJson(res, 200, { id, removed: true })
    })
    .add('GET', '/v1/shares', (_req, res, _params, query) => {
      const items = shares.list()
      sendJson(res, 200, {
        items:
          hub && query.get('hosts') === 'all'
            ? hub.mergeShares(items as unknown as Record<string, unknown>[])
            : items,
      })
    })
}
