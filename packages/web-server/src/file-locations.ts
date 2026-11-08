// Files by location: the viewer behind Files > Everywhere, shared files and
// file paths clicked in a terminal. A location is a starting folder (`root`,
// absolute) and a path from it; the whole host filesystem is browsable (Cloudflare
// Access is the boundary), so `..` and symlinks may lead out of the folder.
// @aico/tether-client/files still refuses secret names, and the folder itself
// may not name one. Folders list a page at a time; a file is streamed where it is,
// never copied or read whole into memory.

import { constants, realpathSync, statSync } from 'node:fs'
import { type FileHandle, open, readFile as readWhole } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import {
  type BrowseOptions,
  isDenied,
  listDirectory,
  readFile,
  resolveSafePath,
} from '@aico/tether-client/files'
import {
  designKindOf,
  MOCKUP_CSP,
  PDF_CSP,
  sniffMedia,
  viewDocument,
  WRAPPED_CSP,
} from './design-render'
import { RAW, type RequestContext, type Router } from './http'
import { translate } from './pane-files'
import { HttpError } from './tether'

/** A text or image file over this opens as a download, not in the browser. */
const MAX_INLINE_BYTES = 25 * 1024 * 1024
const ANYWHERE: BrowseOptions = { anywhere: true }
const CHUNK_BYTES = 64 * 1024
const SNIFF_BYTES = 8192

function locationRoot(ctx: RequestContext): string {
  const root = ctx.query.get('root')
  if (!root || !isAbsolute(root) || root.includes('\0'))
    throw new HttpError(400, 'root must be an absolute folder')
  if (root.split('/').some((part) => part && isDenied(part)))
    throw new HttpError(403, 'Access denied')
  let isDir: boolean
  try {
    isDir = statSync(root).isDirectory()
  } catch (error) {
    if (isPermissionError(error))
      throw new HttpError(403, 'Can’t read this folder: permission denied')
    throw new HttpError(404, 'This folder was moved or deleted')
  }
  if (!isDir) throw new HttpError(400, 'root must be a folder')
  return root
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM'
}

function imageType(header: Buffer): string | null {
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

/** Images and text open in the browser; anything else downloads. */
export function rawType(header: Buffer): { type: string; inline: boolean } {
  const image = imageType(header)
  if (image) return { type: image, inline: true }
  if (!header.includes(0)) return { type: 'text/plain; charset=utf-8', inline: true }
  return { type: 'application/octet-stream', inline: false }
}

async function streamFile(ctx: RequestContext, target: string): Promise<typeof RAW> {
  let file: FileHandle
  try {
    file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error) {
    if (isPermissionError(error))
      throw new HttpError(403, 'Can’t read this file: permission denied')
    throw new HttpError(404, 'This file was moved or deleted')
  }
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new HttpError(404, 'Not a file')
    const header = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead: headRead } = await file.read(header, 0, SNIFF_BYTES, 0)
    const sniffed = rawType(header.subarray(0, headRead))
    const type = sniffed.type
    // A very large text file or image downloads rather than filling a browser tab.
    const inline = sniffed.inline && info.size <= MAX_INLINE_BYTES
    const { res } = ctx
    const name = basename(target).replace(/[^\x20-\x7e]|["\\]/g, '_')
    res.statusCode = 200
    res.setHeader('Content-Type', type)
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'")
    res.setHeader('Cache-Control', 'no-store')
    // Bounded by the checked size even if the file grows meanwhile.
    let position = 0
    while (position < info.size) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, info.size - position))
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
    return RAW
  } finally {
    await file.close()
  }
}

/** A file shown rendered (the Files preview's Rendered view) is read whole, so it has a bound. */
const MAX_RENDERED_BYTES = 8 * 1024 * 1024

/**
 * A file as a page for a frame: HTML as it is, SVG and Markdown wrapped, a PDF as itself. All of
 * it sandboxed or inert (see design-render.ts); the page loads nothing from beside the file.
 */
async function sendRendered(ctx: RequestContext, target: string): Promise<typeof RAW> {
  const kind = designKindOf(target)
  if (kind !== 'html' && kind !== 'svg' && kind !== 'markdown' && kind !== 'pdf')
    throw new HttpError(415, 'This kind of file has no rendered view')
  let bytes: Buffer
  try {
    const info = statSync(target)
    if (!info.isFile()) throw new HttpError(404, 'Not a file')
    if (info.size > MAX_RENDERED_BYTES)
      throw new HttpError(413, 'This file is over 8 MB, too big to show rendered')
    bytes = await readWhole(target)
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (isPermissionError(error))
      throw new HttpError(403, 'Can’t read this file: permission denied')
    throw new HttpError(404, 'This file was moved or deleted')
  }
  const { res } = ctx
  res.statusCode = 200
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (kind === 'pdf') {
    if (sniffMedia(bytes)?.kind !== 'pdf') throw new HttpError(415, 'This is not a PDF')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Security-Policy', PDF_CSP)
    res.setHeader('Content-Disposition', 'inline')
    res.end(bytes)
    return RAW
  }
  const text = bytes.toString('utf8')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Security-Policy', kind === 'html' ? MOCKUP_CSP : WRAPPED_CSP)
  res.end(kind === 'html' ? text : viewDocument(kind, text, basename(target)))
  return RAW
}

/** What a path names (a clicked path may start with `~`): its real location and kind. */
function statLocation(raw: string): { path: string; kind: 'file' | 'folder' } {
  const expanded =
    raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  if (!isAbsolute(expanded) || expanded.includes('\0'))
    throw new HttpError(400, 'path must be absolute')
  let path: string
  try {
    path = realpathSync(expanded)
  } catch (error) {
    if (isPermissionError(error))
      throw new HttpError(403, 'Can’t read this path: permission denied')
    throw new HttpError(404, 'This file was moved or deleted')
  }
  if (path.split('/').some((part) => part && isDenied(part)))
    throw new HttpError(403, 'Access denied')
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(path)
  } catch (error) {
    if (isPermissionError(error))
      throw new HttpError(403, 'Can’t read this path: permission denied')
    throw new HttpError(404, 'This file was moved or deleted')
  }
  if (info.isDirectory()) return { path, kind: 'folder' }
  if (info.isFile()) return { path, kind: 'file' }
  throw new HttpError(400, 'Not a file or folder')
}

/** A listing page's bounds from the query; absent or unreadable values mean the defaults. */
function pageOf(ctx: RequestContext): BrowseOptions {
  const number = (name: string): number | undefined => {
    const value = Number(ctx.query.get(name))
    return ctx.query.get(name) !== null && Number.isFinite(value) ? value : undefined
  }
  return {
    ...ANYWHERE,
    offset: number('offset'),
    limit: number('limit'),
    sort: ctx.query.get('sort') === 'modified' ? 'modified' : 'name',
    // Dotfiles show unless the page asks to hide them.
    hidden: ctx.query.get('hidden') !== '0',
    match: ctx.query.get('match') ?? undefined,
  }
}

export interface FilePlace {
  id: string
  label: string
  path: string
}

/** Home and the configured shortcut folders that exist here, in order. */
export function filePlaces(shortcuts: readonly string[]): FilePlace[] {
  const places: FilePlace[] = [{ id: 'home', label: 'Home', path: homedir() }]
  for (const path of shortcuts) {
    try {
      if (statSync(path).isDirectory())
        places.push({ id: path, label: path, path: realpathSync(path) })
    } catch {}
  }
  return places
}

export function registerFileLocationRoutes(
  router: Router,
  options: { shortcuts: readonly string[] } = { shortcuts: [] },
): void {
  router.on('GET', '/api/files/stat', (ctx) => statLocation(ctx.query.get('path') ?? ''))

  router.on('GET', '/api/files/places', () => ({ places: filePlaces(options.shortcuts) }))

  router.on('GET', '/api/files/tree', (ctx) => {
    const root = locationRoot(ctx)
    try {
      return listDirectory(root, ctx.query.get('path') ?? '', pageOf(ctx))
    } catch (error) {
      throw translate(error)
    }
  })

  router.on('GET', '/api/files/content', (ctx) => {
    const root = locationRoot(ctx)
    const path = ctx.query.get('path')
    if (path === null) throw new HttpError(422, 'path is required')
    try {
      return readFile(root, path, ANYWHERE)
    } catch (error) {
      throw translate(error)
    }
  })

  router.on('GET', '/api/files/raw', async (ctx) => {
    const root = locationRoot(ctx)
    const path = ctx.query.get('path')
    if (path === null) throw new HttpError(422, 'path is required')
    let target: string
    try {
      target = resolveSafePath(root, path, ANYWHERE)
    } catch (error) {
      throw translate(error)
    }
    return streamFile(ctx, target)
  })
  router.on('GET', '/api/files/view', async (ctx) => {
    const root = locationRoot(ctx)
    const path = ctx.query.get('path')
    if (path === null) throw new HttpError(422, 'path is required')
    let target: string
    try {
      target = resolveSafePath(root, path, ANYWHERE)
    } catch (error) {
      throw translate(error)
    }
    return sendRendered(ctx, target)
  })
}
