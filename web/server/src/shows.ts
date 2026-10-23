// Agent shares (the Python backend's services/shows.py and api/shows.py): the
// default Tether announces `show.requested` with a file it copied into the
// exchange dir or a URL; the server keeps the last 50 in memory, pushes a
// fixed-text Nightshift notice, and serves the metadata and the file. Every
// field crosses an agent-controlled boundary, so each is checked again here.

import { execFile } from 'node:child_process'
import { constants, type promises as fsp } from 'node:fs'
import { open } from 'node:fs/promises'
import { RAW, type Router } from './http'
import { HttpError } from './tether'

export const MAX_SHOW_BYTES = 25 * 1024 * 1024
const RING_SIZE = 50
const PUSH_TIMEOUT_MS = 10_000

const ID = /^[0-9a-f]{1,64}$/
const SESSION = /^[0-9a-f]{8}$/
const NAME = /^([0-9a-f]{8}|none)\/out\/[A-Za-z0-9._-]{1,120}$/
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

export interface Show {
  id: string
  session: string | null
  kind: 'file' | 'url'
  title: string | null
  name: string
  url?: string
}

const length = (text: string) => Array.from(text).length

/** A share Tether announced, or null when any field is not what Tether sends. */
export function validateShow(data: unknown): Show | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const { id, session, title, name, kind, url } = data as Record<string, unknown>
  if (typeof id !== 'string' || !ID.test(id)) return null
  if (
    session !== null &&
    session !== undefined &&
    (typeof session !== 'string' || !SESSION.test(session))
  )
    return null
  const owner = (session as string | null | undefined) ?? null
  if (
    title !== null &&
    title !== undefined &&
    (typeof title !== 'string' || length(title) > 120 || NOT_PLAIN.test(title))
  )
    return null
  const heading = (title as string | null | undefined) ?? null
  if (typeof name !== 'string') return null
  if (kind === 'file') {
    if (!NAME.test(name)) return null
    const last = name.slice(name.lastIndexOf('/') + 1)
    if (last === '.' || last === '..') return null
    if (name.split('/', 1)[0] !== (owner ?? 'none') || (url !== null && url !== undefined))
      return null
    return { id, session: owner, kind: 'file', title: heading, name }
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
    if (name !== url) return null
    return { id, session: owner, kind: 'url', title: heading, name, url }
  }
  return null
}

/** What the UI reads: a file share has no `url` key. */
export function metadata(show: Show): Record<string, string | null> {
  const { id, session, kind, title, name } = show
  return kind === 'file'
    ? { id, session, kind, title, name }
    : { id, session, kind, title, name, url: show.url ?? null }
}

export class ShowStore {
  private items: Show[] = []

  /** False when this id is already kept (a replayed event). */
  add(show: Show): boolean {
    if (this.items.some((item) => item.id === show.id)) return false
    this.items.push(show)
    if (this.items.length > RING_SIZE) this.items = this.items.slice(-RING_SIZE)
    return true
  }

  /** The shares after `since`; an unknown cursor (expired, or a restart) gets the whole ring. */
  recent(since?: string | null): Show[] {
    const index = since ? this.items.findIndex((item) => item.id === since) : -1
    return index >= 0 ? this.items.slice(index + 1) : [...this.items]
  }

  get(id: string): Show | undefined {
    return this.items.find((item) => item.id === id)
  }
}

export type RunPush = (argv: string[]) => Promise<void>

const runPush: RunPush = (argv) =>
  new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { timeout: PUSH_TIMEOUT_MS }, (error) =>
      error ? reject(error) : resolve(),
    )
  })

/** The Nightshift notice argv: fixed text, so nothing the agent wrote reaches the push. */
export function pushArgv(show: Show, publicHost: string | null): string[] {
  const argv = [
    'nightshift',
    'push',
    '--title',
    'Agent shared something',
    '--severity',
    'info',
    '--key',
    `show:${show.id}`,
  ]
  if (publicHost) argv.push('--open', `https://${publicHost}/?show=${show.id}`)
  argv.push('Open Aico to see it.')
  return argv
}

export class Shows {
  readonly store = new ShowStore()

  constructor(
    private readonly options: {
      exchangeRoot: string
      publicHost: string | null
      run?: RunPush
    },
  ) {}

  /** A `show.requested` event's data from the trusted Tether. */
  async receive(data: unknown): Promise<void> {
    const show = validateShow(data)
    if (!show) {
      console.log('[aico-web] show rejected')
      return
    }
    if (!this.store.add(show)) return
    try {
      await (this.options.run ?? runPush)(pushArgv(show, this.options.publicHost))
    } catch (error) {
      console.warn(`[aico-web] show push failed show_id=${show.id}: ${(error as Error).message}`)
    }
  }

  /**
   * The shared file, opened one directory at a time below the exchange root
   * with no symlink followed (each step pinned by its descriptor, so an
   * agent-controlled parent cannot redirect the read), and only a regular file.
   */
  async openFile(name: string): Promise<fsp.FileHandle> {
    const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants
    const steps = ['agent', ...name.split('/')]
    let directory = await open(this.options.exchangeRoot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    try {
      for (const step of steps.slice(0, -1)) {
        const child = await open(
          `/proc/self/fd/${directory.fd}/${step}`,
          O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
        )
        await directory.close()
        directory = child
      }
      const file = await open(
        `/proc/self/fd/${directory.fd}/${steps[steps.length - 1]}`,
        O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
      )
      return file
    } finally {
      await directory.close()
    }
  }
}

export function imageType(header: Buffer): string | null {
  if (header.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))) return 'image/png'
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  const start = header.subarray(0, 6).toString('latin1')
  if (start === 'GIF87a' || start === 'GIF89a') return 'image/gif'
  if (
    header.subarray(0, 4).toString('latin1') === 'RIFF' &&
    header.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  return null
}

const CHUNK_BYTES = 64 * 1024

export function registerShowRoutes(
  router: Router,
  shows: Shows,
  hooks: { headerRead?: () => void } = {},
): void {
  router.on('GET', '/api/shows', (ctx) => ({
    shows: shows.store.recent(ctx.query.get('since')).map(metadata),
  }))

  router.on('GET', '/api/shows/:showId/file', async (ctx) => {
    const show = shows.store.get(ctx.params.showId)
    if (show?.kind !== 'file') throw new HttpError(404, 'Shared file not found')
    let file: fsp.FileHandle
    try {
      file = await shows.openFile(show.name)
    } catch {
      throw new HttpError(404, 'Shared file unavailable')
    }
    let size: number
    let mime: string | null
    try {
      const info = await file.stat()
      if (!info.isFile()) throw new HttpError(404, 'Shared file unavailable')
      if (info.size > MAX_SHOW_BYTES) throw new HttpError(413, 'Shared file exceeds 25 MB')
      size = info.size
      const header = Buffer.alloc(16)
      const { bytesRead } = await file.read(header, 0, 16, 0)
      mime = imageType(header.subarray(0, bytesRead))
      hooks.headerRead?.()
    } catch (error) {
      await file.close()
      throw error
    }
    const filename = show.name.slice(show.name.lastIndexOf('/') + 1)
    const { res } = ctx
    res.statusCode = 200
    res.setHeader('Content-Type', mime ?? 'application/octet-stream')
    res.setHeader(
      'Content-Disposition',
      `${mime ? 'inline' : 'attachment'}; filename="${filename}"`,
    )
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    try {
      // Bounded by the checked size even if the agent grows the file meanwhile.
      let position = 0
      while (position < size) {
        const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position))
        const { bytesRead } = await file.read(chunk, 0, chunk.length, position)
        if (bytesRead === 0) break
        position += bytesRead
        if (!res.write(chunk.subarray(0, bytesRead)))
          await new Promise<void>((resolve) => {
            res.once('drain', resolve)
            res.once('close', resolve)
          })
        if (res.destroyed) break
      }
      res.end()
    } finally {
      await file.close()
    }
    return RAW
  })
}
