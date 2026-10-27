// Agent shares: the default Tether announces `show.requested` with links to
// files or folders where they already are (or a web link) and keeps the list
// (GET /v1/shares). The server pushes a fixed-text Nightshift notice for each
// new one and hands the UI the list; the files open through the location
// routes (file-locations.ts). Every field crosses an agent-controlled
// boundary, so each is checked again here.

import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { Router } from './http'

const PUSH_TIMEOUT_MS = 10_000
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

export type RunPush = (argv: string[]) => Promise<void>

const runPush: RunPush = (argv) =>
  new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { timeout: PUSH_TIMEOUT_MS }, (error) =>
      error ? reject(error) : resolve(),
    )
  })

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

/** The Nightshift notice argv. */
export function pushArgv(share: Share, publicHost: string | null): string[] {
  const argv = [
    'nightshift',
    'push',
    '--title',
    pushTitle(share),
    '--severity',
    'info',
    '--key',
    `show:${share.id}`,
  ]
  if (publicHost) argv.push('--open', `https://${publicHost}/?show=${share.id}`)
  argv.push('Open Aico to see it.')
  return argv
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
      run?: RunPush
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
    try {
      await (this.options.run ?? runPush)(pushArgv(share, this.options.publicHost))
    } catch (error) {
      console.warn(`[aico-web] show push failed show_id=${share.id}: ${(error as Error).message}`)
    }
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
