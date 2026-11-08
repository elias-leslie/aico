// The shares table and the path check a share needs. Asks file shares too, so
// this sits below both the show route (show.ts) and asks.

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import type { Store } from '@aico/session-engine/store'
import { HttpError } from '@aico/shared/http'
import type { ShowConfig } from './config'

/** The most shares listed at once (newest kept). */
const MAX_LISTED_SHARES = 200

export type ShowRequest = {
  session: string | null
  title: string | null
} & ({ kind: 'url'; url: string } | { kind: 'files'; paths: string[] })

/** An agent's share: links to files or folders where they already are, or a web link. */
export type Share = {
  id: string
  session: string | null
  title: string | null
  createdAt: string
} & ({ kind: 'files'; paths: string[] } | { kind: 'url'; url: string })

/** Each path as it really is on disk: it must exist, be readable and be a file or a folder; a folder ends in `/`. */
export async function realPaths(paths: string[]): Promise<string[]> {
  const resolved: string[] = []
  for (const path of paths) {
    let real: string
    try {
      real = await realpath(path)
      const info = await stat(real)
      if (info.isDirectory()) real = real.endsWith('/') ? real : `${real}/`
      else if (!info.isFile()) throw new Error('not a file or folder')
      await access(real, constants.R_OK)
    } catch {
      throw new HttpError(400, 'invalid_path', {
        detail: `Not an existing, readable file or folder: ${path}`,
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
    private readonly db: Store['db'],
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

  /** A files share for these paths: the session's newest one naming exactly
   * them, else a new one (re-asking a question with the same files adds none). */
  filesShare(
    session: string | null,
    title: string | null,
    paths: string[],
    now = Date.now(),
  ): Share {
    const row = this.db
      .prepare(
        `SELECT * FROM shares WHERE paths = ? AND session_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(JSON.stringify(paths), session) as unknown as ShareRow | undefined
    return row ? fromRow(row) : this.add({ session, title, kind: 'files', paths }, now)
  }

  get(id: string): Share | undefined {
    const row = this.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as unknown as
      | ShareRow
      | undefined
    return row && fromRow(row)
  }

  /** Drop one share; false when there is none with that ID. */
  remove(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM shares WHERE id = ?').run(id).changes) > 0
  }

  /** The newest shares, oldest first. */
  list(): Share[] {
    const rows = this.db
      .prepare('SELECT * FROM shares ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(MAX_LISTED_SHARES) as unknown as ShareRow[]
    return rows.reverse().map(fromRow)
  }
}
