// Files by location: the viewer behind shared files and file paths clicked in
// a terminal. A location is a folder (`root`, absolute) and a path inside it;
// tether/files keeps every read inside the folder and refuses secrets, and
// the folder itself may not name one. The file is read where it is, never
// copied.

import { constants, realpathSync, statSync } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { isDenied, listDirectory, readFile, resolveSafePath } from 'tether/files'
import { RAW, type RequestContext, type Router } from './http'
import { translate } from './pane-files'
import { HttpError } from './tether'

/** The largest file the viewer streams. */
export const MAX_RAW_BYTES = 25 * 1024 * 1024
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
  } catch {
    throw new HttpError(404, 'This folder was moved or deleted')
  }
  if (!isDir) throw new HttpError(400, 'root must be a folder')
  return root
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
  } catch {
    throw new HttpError(404, 'This file was moved or deleted')
  }
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new HttpError(404, 'Not a file')
    if (info.size > MAX_RAW_BYTES) throw new HttpError(413, 'File is over 25 MB')
    const header = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead: headRead } = await file.read(header, 0, SNIFF_BYTES, 0)
    const { type, inline } = rawType(header.subarray(0, headRead))
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

/** What a path names (a clicked path may start with `~`): its real location and kind. */
export function statLocation(raw: string): { path: string; kind: 'file' | 'folder' } {
  const expanded =
    raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  if (!isAbsolute(expanded) || expanded.includes('\0'))
    throw new HttpError(400, 'path must be absolute')
  let path: string
  try {
    path = realpathSync(expanded)
  } catch {
    throw new HttpError(404, 'This file was moved or deleted')
  }
  if (path.split('/').some((part) => part && isDenied(part)))
    throw new HttpError(403, 'Access denied')
  const info = statSync(path)
  if (info.isDirectory()) return { path, kind: 'folder' }
  if (info.isFile()) return { path, kind: 'file' }
  throw new HttpError(400, 'Not a file or folder')
}

export function registerFileLocationRoutes(router: Router): void {
  router.on('GET', '/api/files/stat', (ctx) => statLocation(ctx.query.get('path') ?? ''))

  router.on('GET', '/api/files/tree', (ctx) => {
    const root = locationRoot(ctx)
    try {
      return listDirectory(root, ctx.query.get('path') ?? '')
    } catch (error) {
      throw translate(error)
    }
  })

  router.on('GET', '/api/files/content', (ctx) => {
    const root = locationRoot(ctx)
    const path = ctx.query.get('path')
    if (path === null) throw new HttpError(422, 'path is required')
    try {
      return readFile(root, path)
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
      target = resolveSafePath(root, path)
    } catch (error) {
      throw translate(error)
    }
    return streamFile(ctx, target)
  })
}
