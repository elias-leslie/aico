import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ShowConfig } from './config'
import type { EventBus } from './events'
import { HttpError, type Router, readJsonObject, sendJson } from './http'

/** The most files and folders one share may name. */
export const MAX_SHARE_PATHS = 20
/** The most shares listed at once (newest kept). */
export const MAX_LISTED_SHARES = 200

/** An agent's share: links to files or folders where they already are, or a web link. */
export type Share = {
  id: string
  session: string | null
  title: string | null
  createdAt: string
} & ({ kind: 'files'; paths: string[] } | { kind: 'url'; url: string })

type ShowRequest = {
  session: string | null
  title: string | null
} & ({ kind: 'url'; url: string } | { kind: 'files'; paths: string[] })

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

/** Each path as it really is on disk: it must exist and be a file or a folder; a folder ends in `/`. */
async function realPaths(paths: string[]): Promise<string[]> {
  const resolved: string[] = []
  for (const path of paths) {
    let real: string
    try {
      real = await realpath(path)
      const info = await stat(real)
      if (info.isDirectory()) real = real.endsWith('/') ? real : `${real}/`
      else if (!info.isFile()) throw new Error('not a file or folder')
    } catch {
      throw new HttpError(400, 'invalid_path', {
        detail: `Not an existing file or folder: ${path}`,
      })
    }
    if (!resolved.includes(real)) resolved.push(real)
  }
  return resolved
}

interface ShareRow {
  id: string
  session_id: string | null
  title: string | null
  paths: string | null
  url: string | null
  created_at: number
}

function fromRow(row: ShareRow): Share {
  const base = {
    id: row.id,
    session: row.session_id,
    title: row.title,
    createdAt: new Date(row.created_at).toISOString(),
  }
  return row.paths === null
    ? { ...base, kind: 'url', url: row.url ?? '' }
    : { ...base, kind: 'files', paths: JSON.parse(row.paths) as string[] }
}

/** The shares table (schema v11). One daemon writes it. */
export class ShareStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly config: ShowConfig,
  ) {}

  /** Record a share and drop those past the retention. */
  add(request: ShowRequest, now = Date.now()): Share {
    const id = randomBytes(6).toString('hex')
    this.db
      .prepare(
        'INSERT INTO shares (id, session_id, title, paths, url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        request.session,
        request.title,
        request.kind === 'files' ? JSON.stringify(request.paths) : null,
        request.kind === 'url' ? request.url : null,
        now,
      )
    this.db
      .prepare('DELETE FROM shares WHERE created_at < ?')
      .run(now - this.config.retentionDays * 24 * 60 * 60 * 1000)
    return this.get(id) as Share
  }

  get(id: string): Share | undefined {
    const row = this.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as unknown as
      | ShareRow
      | undefined
    return row && fromRow(row)
  }

  /** The newest shares, oldest first. */
  list(): Share[] {
    const rows = this.db
      .prepare('SELECT * FROM shares ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(MAX_LISTED_SHARES) as unknown as ShareRow[]
    return rows.reverse().map(fromRow)
  }
}

export function registerShowRoute(
  router: Router,
  events: EventBus,
  store: { db: DatabaseSync },
  config: ShowConfig,
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
    .add('GET', '/v1/shares', (_req, res) => {
      sendJson(res, 200, { items: shares.list() })
    })
}
