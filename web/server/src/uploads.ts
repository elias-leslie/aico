// Uploads (the Python backend's api/files.py and upload_cleanup.py): a file
// the owner drops into a terminal is stored under the upload dir with a UUID
// name, and its `~/…` path is typed for the agent. Types are sniffed from the
// content, not taken from the browser's word; maintenance deletes old ones.

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { Readable, Transform } from 'node:stream'
import type { UploadConfig } from './config'
import { RAW, type Router, sendJson } from './http'
import { HttpError } from './tether'

const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/markdown',
  'text/plain',
  'application/json',
  'application/pdf',
]

const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'application/json': '.json',
  'application/pdf': '.pdf',
}

const MAGIC_SIGNATURES: [Buffer, string][] = [
  [Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), 'image/png'],
  [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
  [Buffer.from('GIF87a'), 'image/gif'],
  [Buffer.from('GIF89a'), 'image/gif'],
  [Buffer.from('RIFF'), 'image/webp'],
  [Buffer.from('%PDF'), 'application/pdf'],
]

const TEXT_MIME_TYPES = new Set(['text/markdown', 'text/plain', 'application/json'])

/** Room for the multipart framing around the file itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

/** The type the content proves, or null. Text types have no magic bytes: their claim stands. */
export function detectMimeType(content: Uint8Array, claimed: string): string | null {
  if (TEXT_MIME_TYPES.has(claimed)) return claimed
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  for (const [signature, mime] of MAGIC_SIGNATURES) {
    if (!bytes.subarray(0, signature.length).equals(signature)) continue
    if (mime === 'image/webp' && bytes.subarray(8, 12).toString('latin1') !== 'WEBP') continue
    return mime
  }
  return null
}

export function validateMimeType(content: Uint8Array, claimed: string): string {
  if (!ALLOWED_MIME_TYPES.includes(claimed))
    throw new HttpError(
      400,
      `File type '${claimed}' not allowed. Allowed: ${[...ALLOWED_MIME_TYPES].sort().join(', ')}`,
    )
  const detected = detectMimeType(content, claimed)
  if (detected === null)
    throw new HttpError(400, `File content does not match claimed type '${claimed}'`)
  return detected
}

/** `~/…` when under the home directory, so the full server path is not shown. */
export function shellPath(path: string, home = homedir()): string {
  const inHome = relative(home, path)
  return inHome && !inHome.startsWith('..') && !inHome.startsWith('/') ? `~/${inHome}` : path
}

function tooLarge(config: UploadConfig): HttpError {
  return new HttpError(413, `File too large. Maximum size: ${config.maxBytes / (1024 * 1024)}MB`)
}

/** The request's `file` part, read with the body capped near the limit. */
async function readUpload(req: IncomingMessage, config: UploadConfig): Promise<File> {
  const cap = config.maxBytes + MULTIPART_OVERHEAD_BYTES
  if (Number(req.headers['content-length'] ?? 0) > cap) throw tooLarge(config)
  let seen = 0
  const counted = req.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        seen += chunk.length
        done(seen > cap ? tooLarge(config) : null, chunk)
      },
    }),
  )
  let form: FormData
  try {
    form = await new Request('http://upload.invalid/', {
      method: 'POST',
      headers: { 'content-type': String(req.headers['content-type'] ?? '') },
      body: Readable.toWeb(counted) as ReadableStream,
      duplex: 'half',
    } as RequestInit).formData()
  } catch (error) {
    if (seen > cap) throw tooLarge(config)
    throw new HttpError(422, `Expected a multipart form with a file: ${(error as Error).message}`)
  }
  const file = form.get('file')
  if (!(file instanceof File)) throw new HttpError(422, 'file is required')
  if (file.size > config.maxBytes) throw tooLarge(config)
  return file
}

/** At most `limit` calls per window per key (the Python backend's 10/minute). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit = RATE_LIMIT,
    private readonly windowMs = RATE_WINDOW_MS,
    private readonly now = () => Date.now(),
  ) {}

  allow(key: string): boolean {
    const at = this.now()
    const recent = (this.hits.get(key) ?? []).filter((time) => at - time < this.windowMs)
    const allowed = recent.length < this.limit
    if (allowed) recent.push(at)
    if (recent.length) this.hits.set(key, recent)
    else this.hits.delete(key)
    return allowed
  }
}

export function registerUploadRoutes(router: Router, config: UploadConfig): void {
  const limiter = new RateLimiter()

  router.on('GET', '/api/files/limits', () => ({ max_bytes: config.maxBytes }))

  router.on('POST', '/api/files', async (ctx) => {
    if (!limiter.allow(ctx.req.socket.remoteAddress ?? '')) {
      sendJson(ctx.res, 429, { detail: `Rate limit exceeded: ${RATE_LIMIT} per 1 minute` })
      ctx.req.resume()
      return RAW
    }
    const file = await readUpload(ctx.req, config)
    const content = new Uint8Array(await file.arrayBuffer())
    if (content.length === 0) throw new HttpError(400, 'Empty file not allowed')
    const mime = validateMimeType(content, file.type || 'application/octet-stream')
    await mkdir(config.dir, { recursive: true, mode: 0o700 })
    const filename = `${randomUUID()}${MIME_TO_EXTENSION[mime] ?? ''}`
    const path = join(config.dir, filename)
    await writeFile(path, content, { flag: 'wx', mode: 0o600 })
    console.log(
      `[aico-web] file uploaded filename=${filename} size=${content.length} mime_type=${mime}`,
    )
    return { path: shellPath(path), filename, size: content.length, mime_type: mime }
  })
}

export interface UploadCleanupStats {
  scanned_files: number
  deleted_files: number
  pruned_directories: number
  errors: number
  max_age_seconds: number
}

/**
 * Delete uploads older than the max age and prune directories left empty
 * (never the upload dir itself). Symlinks are removed as links, never followed.
 */
export async function cleanupOldUploads(
  config: UploadConfig,
  now = Date.now(),
): Promise<UploadCleanupStats> {
  const stats: UploadCleanupStats = {
    scanned_files: 0,
    deleted_files: 0,
    pruned_directories: 0,
    errors: 0,
    max_age_seconds: Math.round(config.maxAgeMs / 1000),
  }
  const cutoff = now - config.maxAgeMs
  const directories: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (dir !== config.dir || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        stats.errors += 1
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        directories.push(path)
        await walk(path)
        continue
      }
      stats.scanned_files += 1
      try {
        if ((await lstat(path)).mtimeMs >= cutoff) continue
        await unlink(path)
        stats.deleted_files += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stats.errors += 1
      }
    }
  }
  await walk(config.dir)
  // Deepest first, so a parent emptied by its children's removal goes too.
  for (const dir of directories.sort((a, b) => b.split('/').length - a.split('/').length)) {
    try {
      if ((await readdir(dir)).length > 0) continue
      await rmdir(dir)
      stats.pruned_directories += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stats.errors += 1
    }
  }
  return stats
}
