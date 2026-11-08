// Agent shares: Tether keeps a list (GET /v1/shares) of links to files or folders
// where they already are, or web links. A share is filed quietly: nothing pops up
// or pushes for one; to get the owner to look at something, an agent files an ask.
// The server hands the UI the list; the files open through the location routes
// (file-locations.ts). Every field crosses an agent-controlled boundary, so each
// is checked again here.

import { isAbsolute } from 'node:path'
import type { Router } from './http'
import { tetherCall } from './lifecycle'
import { HttpError } from './tether'

const MAX_PATHS = 20

const ID = /^[0-9a-f]{12}$/
const SESSION = /^[0-9a-f]{8}$/
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

export type Share = {
  id: string
  session: string | null
  title: string | null
  createdAt: string
  /** The linked host that shared it; absent: this door's own. Its file paths are on that host. */
  host?: string
  /** Why a linked host's share is not live (its link is down). */
  peer?: { state: string; since: number; listedAt: number | null }
} & ({ kind: 'files'; paths: string[] } | { kind: 'url'; url: string })

const length = (text: string) => Array.from(text).length

/** A share as Tether sends it, or null when any field is not what Tether sends. */
export function validateShare(data: unknown): Share | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const { id, session, title, createdAt, kind, paths, url, host, peer } = data as Record<
    string,
    unknown
  >
  if (typeof id !== 'string' || !ID.test(id)) return null
  if (session !== null && (typeof session !== 'string' || !SESSION.test(session))) return null
  if (title !== null && (typeof title !== 'string' || length(title) > 120 || NOT_PLAIN.test(title)))
    return null
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null
  if (
    host !== undefined &&
    (typeof host !== 'string' || !host || length(host) > 120 || NOT_PLAIN.test(host))
  )
    return null
  const mark = peer as Record<string, unknown> | undefined
  if (
    mark !== undefined &&
    !(
      mark &&
      typeof mark === 'object' &&
      typeof mark.state === 'string' &&
      Number.isSafeInteger(mark.since) &&
      (mark.listedAt === null || Number.isSafeInteger(mark.listedAt))
    )
  )
    return null
  const base = {
    id,
    session,
    title,
    createdAt,
    ...(host !== undefined ? { host } : {}),
    ...(mark !== undefined ? { peer: mark as unknown as NonNullable<Share['peer']> } : {}),
  }
  if (kind === 'files') {
    if (
      !Array.isArray(paths) ||
      paths.length < 1 ||
      paths.length > MAX_PATHS ||
      !paths.every(
        (path) =>
          typeof path === 'string' &&
          isAbsolute(path) &&
          length(path) <= 4096 &&
          !NOT_PLAIN.test(path) &&
          !path.split('/').includes('..'),
      )
    )
      return null
    return { ...base, kind, paths: paths as string[] }
  }
  if (kind === 'url') {
    if (typeof url !== 'string' || length(url) < 1 || length(url) > 2000) return null
    if (NOT_PLAIN.test(url) || url.trim() !== url) return null
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null
    if (!/^https?:\/\/[^/]/i.test(url)) return null
    return { ...base, kind, url }
  }
  return null
}

/** What Shows needs of Tether. */
interface ShareSource {
  request<T>(method: string, path: string): Promise<{ status: number; body: T }>
}

export class Shows {
  constructor(private readonly options: { tether: ShareSource }) {}

  /** Take one of this computer's shares out of Tether's list. */
  async remove(id: string): Promise<void> {
    await this.options.tether.request('DELETE', `/v1/shares/${id}`)
  }

  /** Tether's shares (with the linked hosts', or this host's only), oldest first; any that fail the checks are left out. */
  async list(hosts: 'all' | 'here' = 'all'): Promise<Share[]> {
    const { body } = await this.options.tether.request<{ items?: unknown }>(
      'GET',
      hosts === 'all' ? '/v1/shares?hosts=all' : '/v1/shares',
    )
    if (!Array.isArray(body?.items)) return []
    return body.items.map(validateShare).filter((share): share is Share => share !== null)
  }
}

export function registerShowRoutes(router: Router, shows: Shows): void {
  router.on('GET', '/api/shows', async () => ({ shows: await shows.list() }))

  // Takes an entry out of Files > Shared. A linked host's share is removed on that host.
  router.on('DELETE', '/api/shows/:id', async (ctx) => {
    const id = ctx.params.id ?? ''
    if (!ID.test(id)) throw new HttpError(404, 'That share is already gone')
    await tetherCall(() => shows.remove(id), 'That share is already gone')
    return { id, removed: true }
  })
}
