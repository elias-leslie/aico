// Agent shares: the default Tether announces `show.requested` with links to
// files or folders where they already are (or a web link) and keeps the list
// (GET /v1/shares). The server pushes a fixed-text Nightshift notice for each
// new one and hands the UI the list; the files open through the location
// routes (file-locations.ts). Every field crosses an agent-controlled
// boundary, so each is checked again here.

import { isAbsolute } from 'node:path'
import type { Router } from './http'
import { type Notice, type RunCommand, runCommand, sendNotice } from './notice'

/** Ids pushed already, so a replayed event never pushes twice. */
const PUSHED_KEPT = 500
const MAX_PATHS = 20

const ID = /^[0-9a-f]{12}$/
const SESSION = /^[0-9a-f]{8}$/
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

export type Share = {
  id: string
  session: string | null
  title: string | null
  createdAt: string
} & ({ kind: 'files'; paths: string[] } | { kind: 'url'; url: string })

const length = (text: string) => Array.from(text).length

/** A share as Tether sends it, or null when any field is not what Tether sends. */
export function validateShare(data: unknown): Share | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const { id, session, title, createdAt, kind, paths, url } = data as Record<string, unknown>
  if (typeof id !== 'string' || !ID.test(id)) return null
  if (session !== null && (typeof session !== 'string' || !SESSION.test(session))) return null
  if (title !== null && (typeof title !== 'string' || length(title) > 120 || NOT_PLAIN.test(title)))
    return null
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null
  const base = { id, session, title, createdAt }
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

/** A path's last part; a shared folder's path ends in `/`. */
const lastPart = (path: string) =>
  path
    .replace(/(?<=.)\/$/, '')
    .split('/')
    .pop() || path

/** The push title says what was shared: the share's title (checked plain text) or the first file's name. A URL
 * never goes into the push; a link without a title is just "a link". */
export function pushTitle(share: Share): string {
  const what =
    share.title ??
    (share.kind === 'files'
      ? `${lastPart(share.paths[0])}${share.paths.length > 1 ? ` and ${share.paths.length - 1} more` : ''}`
      : null)
  return what ? `Shared: ${what}` : 'Shared a link'
}

/** The Nightshift notice for a new share: something to look at, so a tray todo that leads to the share. */
export function showNotice(share: Share, publicHost: string | null): Notice {
  const notice: Notice = {
    v: 1,
    source: 'aico',
    kind: 'todo',
    severity: 'info',
    title: pushTitle(share),
    body: 'Open Aico to see it.',
    key: `show:${share.id}`,
    push: 'tray',
    actions: ['done'],
    primary: 'done',
  }
  if (publicHost) notice.open = `https://${publicHost}/?show=${share.id}`
  return notice
}

/** What Shows needs of Tether. */
interface ShareSource {
  request<T>(method: string, path: string): Promise<{ status: number; body: T }>
}

export class Shows {
  private readonly pushed = new Set<string>()

  constructor(
    private readonly options: {
      tether: ShareSource
      publicHost: string | null
      run?: RunCommand
    },
  ) {}

  /** A `show.requested` event's data from the trusted Tether. */
  async receive(data: unknown): Promise<void> {
    const share = validateShare(data)
    if (!share) {
      console.log('[aico-web] show rejected')
      return
    }
    if (this.pushed.has(share.id)) return
    this.pushed.add(share.id)
    if (this.pushed.size > PUSHED_KEPT) this.pushed.delete(this.pushed.values().next().value ?? '')
    await sendNotice(this.options.run ?? runCommand, showNotice(share, this.options.publicHost))
  }

  /** Tether's shares, oldest first; any that fail the checks are left out. */
  async list(): Promise<Share[]> {
    const { body } = await this.options.tether.request<{ items?: unknown }>('GET', '/v1/shares')
    if (!Array.isArray(body?.items)) return []
    return body.items.map(validateShare).filter((share): share is Share => share !== null)
  }
}

export function registerShowRoutes(router: Router, shows: Shows): void {
  router.on('GET', '/api/shows', async (ctx) => {
    const items = await shows.list()
    const since = ctx.query.get('since')
    const index = since ? items.findIndex((item) => item.id === since) : -1
    // An unknown cursor (an expired share) gets the whole list.
    return { shows: index >= 0 ? items.slice(index + 1) : items }
  })
}
