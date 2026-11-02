// Capture routes: the owner's photos and files, saved durably (notes.db plus
// hash-named blobs, never the session upload dir) and readable by agents
// through `tether capture`. Extraction, the router and asks come later.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { Ask } from './asks'
import { type BlobVariant, blobPath, hasBlob, putOriginal, putVariant } from './blobs'
import {
  acceptString,
  captureTypes,
  isInlineMime,
  needsPreview,
  sniffCapture,
} from './capture-files'
import type { CaptureConfig } from './config'
import { execRunner, PreviewJobs, type PreviewState, type Runner } from './heic'
import { objectBody, RAW, type Router, sendJson } from './http'
import { CAPTURE_STATUSES, type CaptureRow, type CaptureStatus, type NotesStore } from './notes-db'
import { HttpError } from './tether'
import { RateLimiter, readUploadForm } from './uploads'
import { ROUTE_NEEDS_CHECK, type RouteName } from './vision-extract'

export interface CaptureDeps {
  store: NotesStore
  blobsDir: string
  limits: CaptureConfig
  /** Runs `heif-convert`; tests pass a fake. */
  runner?: Runner
  /** Tests pass their own to wait on previews. */
  previews?: PreviewJobs
  limiter?: RateLimiter
  /** Reads an ask from Tether, to check an upload tagged with `ask_id`. Without
   * it the tag is stored as given. */
  asks?: { get(id: string): Promise<Ask> }
  /** Wakes the background reader after a new or retried capture. */
  reader?: { kick(): void }
}

const RATE_LIMIT = 60
const THUMB_MAX_BYTES = 256 * 1024
const CAPTION_MAX = 4000
const NAME_MAX = 255
const PAGE_DEFAULT = 50
const CAPTURE_ID = /^[0-9a-f]{12}$/
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/
const CACHE_FOREVER = 'private, max-age=31536000, immutable'
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

const megabytes = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10

/** The capture as the page and `tether capture` see it. */
export interface CaptureJson {
  id: string
  clientId: string
  groupId: string | null
  askId: string | null
  kind: string
  name: string
  mime: string
  size: number
  hash: string | null
  caption: string
  status: CaptureStatus
  type: string | null
  text: string | null
  createdAt: number
  updatedAt: number
  origin: string
  hasThumb: boolean
  previewState: PreviewState
  /** Where the last read failed, in plain words; null otherwise. */
  extractError: string | null
  /** Which route read it (`agy`, `ollama`); null if nothing was read. */
  extractRoute: string | null
  /** The fallback route read it, so the owner should look it over. */
  needsCheck: boolean
  /** What was read (title, summary, lines, items, receipt, odometer); only on one capture, not in lists. */
  extract?: unknown
}

function parseExtract(text: string | null): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A display name: no path, no control characters, bounded. */
function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const name = [...base]
    .filter((char) => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, NAME_MAX)
  return name || 'file'
}

function contentDisposition(inline: boolean, name: string): string {
  if (inline) return 'inline'
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16)}`,
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

function formText(form: FormData, key: string, max: number, pattern?: RegExp): string | undefined {
  const value = form.get(key)
  if (value === null || value === '') return undefined
  if (typeof value !== 'string') throw new HttpError(422, `${key} must be text`)
  if (value.length > max) throw new HttpError(422, `${key} is too long`)
  if (pattern && !pattern.test(value)) throw new HttpError(422, `${key} is invalid`)
  return value
}

/** The whole body, refused past `max` bytes. */
async function readRaw(
  req: IncomingMessage,
  max: number,
  tooLarge: () => HttpError,
): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > max) throw tooLarge()
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > max) throw tooLarge()
    parts.push(chunk as Buffer)
  }
  return Buffer.concat(parts)
}

async function sendFile(
  res: ServerResponse,
  path: string,
  headers: { mime: string; inline: boolean; name: string },
): Promise<void> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new HttpError(404, 'The file for this capture is not on this computer')
    throw error
  }
  res.statusCode = 200
  res.setHeader('Content-Type', headers.mime)
  res.setHeader('Content-Length', size)
  res.setHeader('Content-Disposition', contentDisposition(headers.inline, headers.name))
  res.setHeader('Cache-Control', CACHE_FOREVER)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
  try {
    await pipeline(createReadStream(path), res)
  } catch (error) {
    console.error('[aico-web] capture file send failed:', error)
    res.destroy()
  }
}

export function registerCaptureRoutes(
  router: Router,
  deps: CaptureDeps,
): { previews: PreviewJobs } {
  const { store, blobsDir, limits } = deps
  const limiter = deps.limiter ?? new RateLimiter(RATE_LIMIT)
  const previews = deps.previews ?? new PreviewJobs(blobsDir, deps.runner ?? execRunner)
  const types = captureTypes()
  const accept = acceptString()

  /** A file for an ask: the ask must be open or answered, want files and have room. */
  async function checkAsk(askId: string): Promise<void> {
    if (!deps.asks) return
    let ask: Ask
    try {
      ask = await deps.asks.get(askId)
    } catch (error) {
      if (error instanceof HttpError && error.status === 404)
        throw new HttpError(409, 'This question was closed')
      throw error
    }
    if (ask.state !== 'open' && ask.state !== 'answered')
      throw new HttpError(409, 'This question was closed')
    if (!ask.wantsFiles) throw new HttpError(409, 'This question does not take files')
    if (store.capturesForAsk(askId).length >= ask.wantsFiles.max)
      throw new HttpError(409, `This question takes at most ${ask.wantsFiles.max} files`)
  }

  const tooBig = () => new HttpError(413, `That file is over ${megabytes(limits.maxBytes)} MB`)

  function previewState(row: CaptureRow): PreviewState {
    if (!row.hash) return 'unavailable'
    if (needsPreview(row.mime)) return previews.state(row.hash)
    return isInlineMime(row.mime) ? 'ready' : 'unavailable'
  }

  function json(row: CaptureRow, detail = false): CaptureJson {
    return {
      id: row.id,
      clientId: row.client_id,
      groupId: row.group_id,
      askId: row.ask_id,
      kind: row.kind,
      name: row.name,
      mime: row.mime,
      size: row.size,
      hash: row.hash,
      caption: row.caption,
      status: row.status,
      type: row.type,
      text: row.text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      origin: row.origin,
      hasThumb: row.hash !== null && hasBlob(blobsDir, row.hash, 'thumb'),
      previewState: previewState(row),
      extractError: row.extract_error,
      extractRoute: row.extract_route,
      needsCheck:
        row.extract_route !== null && ROUTE_NEEDS_CHECK[row.extract_route as RouteName] === true,
      ...(detail ? { extract: parseExtract(row.extract_json) } : {}),
    }
  }

  function need(id: string): CaptureRow {
    const row = CAPTURE_ID.test(id) ? store.getCapture(id) : null
    if (!row) throw new HttpError(404, 'That capture is gone')
    return row
  }

  router.on('GET', '/api/captures/limits', () => ({
    max_bytes: limits.maxBytes,
    max_files: limits.maxFiles,
    types,
    accept,
  }))

  router.on('POST', '/api/captures', async (ctx) => {
    if (!limiter.allow(ctx.req.socket.remoteAddress ?? '')) {
      sendJson(ctx.res, 429, {
        detail: `Too many files at once (${RATE_LIMIT} a minute). Wait a minute and try again`,
      })
      ctx.req.resume()
      return RAW
    }
    const { form, file } = await readUploadForm(ctx.req, limits.maxBytes, tooBig)
    const clientId = formText(form, 'client_id', 64, CLIENT_ID)
    if (!clientId) throw new HttpError(422, 'client_id is required')
    const groupId = formText(form, 'group_id', 64, CLIENT_ID)
    const askId = formText(form, 'ask_id', 12, /^[0-9a-f]{12}$/)
    const caption = formText(form, 'caption', CAPTION_MAX) ?? ''

    const earlier = store.findByClientId(clientId)
    if (earlier?.deleted) throw new HttpError(409, 'That file was removed')
    if (askId && !earlier) await checkAsk(askId)
    if (!earlier && groupId && store.countInGroup(groupId) >= limits.maxFiles)
      throw new HttpError(409, `That batch already has ${limits.maxFiles} files`)

    const content = new Uint8Array(await file.arrayBuffer())
    if (content.length === 0) throw new HttpError(400, 'That file is empty')
    const name = cleanName(file.name)
    const type = sniffCapture(content, name, file.type)
    if (!type) throw new HttpError(415, "Aico can't store this kind of file yet")

    const hash = await putOriginal(blobsDir, content)
    const { capture, created } = store.insertCapture({
      clientId,
      groupId,
      askId,
      kind: type.kind,
      name,
      mime: type.mime,
      size: content.length,
      hash,
      caption,
    })
    if (created && needsPreview(type.mime)) previews.schedule(hash)
    if (created) deps.reader?.kick()
    sendJson(ctx.res, created ? 201 : 200, json(capture))
    return RAW
  })

  router.on('PUT', '/api/captures/:id/thumb', async (ctx) => {
    const row = need(ctx.params.id)
    if (!row.hash) throw new HttpError(404, 'That capture has no file')
    const bytes = await readRaw(
      ctx.req,
      THUMB_MAX_BYTES,
      () => new HttpError(413, `That thumbnail is over ${THUMB_MAX_BYTES / 1024} KB`),
    )
    if (bytes.length < JPEG_MAGIC.length || !bytes.subarray(0, 3).equals(JPEG_MAGIC))
      throw new HttpError(415, "That thumbnail isn't a JPEG")
    await putVariant(blobsDir, row.hash, 'thumb', bytes)
    return json(row)
  })

  router.on('GET', '/api/captures', (ctx) => {
    const status = ctx.query.get('status') || undefined
    if (status && !(CAPTURE_STATUSES as readonly string[]).includes(status))
      throw new HttpError(422, `Unknown status. Use one of: ${CAPTURE_STATUSES.join(', ')}`)
    const limitText = ctx.query.get('limit')
    const limit = limitText === null || limitText === '' ? PAGE_DEFAULT : Number(limitText)
    if (!Number.isInteger(limit) || limit < 1)
      throw new HttpError(422, 'limit must be a whole number from 1')
    const { captures, total } = store.listCaptures({
      status: status as CaptureStatus | undefined,
      ask: ctx.query.get('ask') || undefined,
      before: ctx.query.get('before') || undefined,
      limit,
    })
    return { captures: captures.map((row) => json(row)), total }
  })

  router.on('GET', '/api/captures/:id', (ctx) => json(need(ctx.params.id), true))

  router.on('POST', '/api/captures/:id/retry', (ctx) => {
    const row = need(ctx.params.id)
    const queued = store.retryExtraction(row.id)
    if (!queued) throw new HttpError(409, "Only a capture that couldn't be read can be tried again")
    deps.reader?.kick()
    return json(queued, true)
  })

  /** Streams one variant of a capture's bytes; `pick` says which file and how it is shown. */
  const serve =
    (variant: BlobVariant) =>
    async (ctx: { params: Record<string, string>; res: ServerResponse }) => {
      const row = need(ctx.params.id)
      if (!row.hash) throw new HttpError(404, 'The file for this capture was handed off')
      let path = blobPath(blobsDir, row.hash, variant)
      let mime = row.mime
      let inline = false
      if (variant === 'thumb') {
        mime = 'image/jpeg'
        inline = true
      } else if (variant === 'preview') {
        if (needsPreview(row.mime)) {
          mime = 'image/jpeg'
          inline = true
        } else if (isInlineMime(row.mime)) {
          path = blobPath(blobsDir, row.hash)
          inline = true
        } else throw new HttpError(404, 'This kind of file has no preview')
      } else inline = isInlineMime(row.mime)
      await sendFile(ctx.res, path, { mime, inline, name: row.name })
      return RAW
    }
  router.on('GET', '/api/captures/:id/file', serve('original'))
  router.on('GET', '/api/captures/:id/thumb', serve('thumb'))
  router.on('GET', '/api/captures/:id/preview', serve('preview'))

  router.on('PATCH', '/api/captures/:id', async (ctx) => {
    const row = need(ctx.params.id)
    const body = objectBody(await ctx.body())
    if (Object.keys(body).some((key) => key !== 'caption') || typeof body.caption !== 'string')
      throw new HttpError(422, 'Only the caption can be changed')
    if (body.caption.length > CAPTION_MAX) throw new HttpError(422, 'caption is too long')
    return json(store.updateCaption(row.id, body.caption) ?? row)
  })

  router.on('DELETE', '/api/captures/:id', (ctx) => {
    const row = need(ctx.params.id)
    store.tombstoneCapture(row.id)
    return { deleted: true, id: row.id }
  })

  return { previews }
}
