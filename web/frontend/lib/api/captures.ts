// Captures: the owner's photos and files, saved by aico-web (notes.db plus
// hash-named files) and listed on the Captures page. The server's contract
// is web/server/src/captures.ts.

import { ApiError, apiFetch } from '../api-fetch'

export type CaptureStatus = 'new' | 'extracting' | 'ready' | 'failed' | 'filed'
export type PreviewState = 'ready' | 'pending' | 'unavailable'

export interface Capture {
  id: string
  clientId: string
  groupId: string | null
  askId: string | null
  kind: string
  name: string
  mime: string
  size: number
  caption: string
  status: CaptureStatus
  type: string | null
  text: string | null
  createdAt: number
  updatedAt: number
  hasThumb: boolean
  previewState: PreviewState
  /** Why the last read failed, in plain words. */
  extractError?: string | null
  /** The fallback reader read it, so it should be checked against the picture. */
  needsCheck?: boolean
  /** False once the file was handed to its owner and Aico's copy removed. */
  hasFile?: boolean
  route?: CaptureRoute | null
  /** What was read; only on a single capture, not in lists. */
  extract?: CaptureExtract | null
}

export type RouteState =
  | 'suggested'
  | 'confirmed'
  | 'filed'
  | 'waiting'
  | 'failed'
  | 'kept'
export type RouteAction = 'send' | 'keep' | 'not_this'

/** Where a capture is on its way to an owner (Portfolio AI, Notes...). */
export interface CaptureRoute {
  state: RouteState
  owner: string | null
  ownerLabel: string | null
  ownerRef: string | null
  /** Why it waits or failed, or what is not built yet. */
  note: string | null
  /** The suggestion, as a question, while it waits for a tap. */
  question: string | null
  /** The button for "this is not that". */
  notLabel: string | null
  /** The owner is set up, so Send works. */
  canSend: boolean
  /** The owner's page, once filed. */
  url: string | null
}

export interface ExtractedItem {
  as_written: string
  item: string
  quantity: string | null
  struck: boolean
}

export interface CaptureExtract {
  title?: string
  summary?: string
  items?: ExtractedItem[]
}

/** The list items out of a reading, ignoring anything shaped wrong. */
export function extractedItems(capture: Capture): ExtractedItem[] {
  const items = capture.extract?.items
  if (!Array.isArray(items)) return []
  return items.filter(
    (entry): entry is ExtractedItem =>
      !!entry &&
      typeof entry.item === 'string' &&
      typeof entry.as_written === 'string' &&
      (entry.item !== '' || entry.as_written !== ''),
  )
}

export interface CaptureLimits {
  max_bytes: number
  max_files: number
  types: { ext: string; mime: string; kind: string }[]
  /** The `accept` string for Choose files, built from the same table the server sniffs with. */
  accept: string
}

export interface CapturePage {
  captures: Capture[]
  total: number
}

const STATUSES: readonly string[] = [
  'new',
  'extracting',
  'ready',
  'failed',
  'filed',
]
const PREVIEWS: readonly string[] = ['ready', 'pending', 'unavailable']

export function isCapture(value: unknown): value is Capture {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    /^[0-9a-f]{12}$/.test(item.id) &&
    typeof item.name === 'string' &&
    typeof item.kind === 'string' &&
    typeof item.mime === 'string' &&
    typeof item.size === 'number' &&
    typeof item.caption === 'string' &&
    typeof item.createdAt === 'number' &&
    typeof item.hasThumb === 'boolean' &&
    STATUSES.includes(item.status as string) &&
    PREVIEWS.includes(item.previewState as string)
  )
}

export function parseCapture(value: unknown): Capture {
  if (!isCapture(value)) throw new Error('Invalid capture')
  return value
}

export function parseCapturePage(value: unknown): CapturePage {
  const page = value as { captures?: unknown; total?: unknown } | null
  if (!page || !Array.isArray(page.captures) || typeof page.total !== 'number')
    throw new Error('Invalid captures')
  return { captures: page.captures.filter(isCapture), total: page.total }
}

export const captureFileUrl = (id: string) => `/api/captures/${id}/file`
export const captureThumbUrl = (id: string) => `/api/captures/${id}/thumb`
export const capturePreviewUrl = (id: string) => `/api/captures/${id}/preview`

/** The picture to show small: the browser-made thumbnail, else the server's
 * preview (an undecodable HEIC), else none (an icon stands in). */
export function captureThumbSource(capture: Capture): string | null {
  if (capture.hasThumb) return captureThumbUrl(capture.id)
  if (capture.kind === 'image' && capture.previewState === 'ready')
    return capturePreviewUrl(capture.id)
  return null
}

export function fetchCaptureLimits(
  signal?: AbortSignal,
): Promise<CaptureLimits> {
  return apiFetch<CaptureLimits>(
    '/api/captures/limits',
    { signal },
    "Couldn't read the upload limits",
  )
}

export function fetchCaptures(
  options: { before?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<CapturePage> {
  const query = new URLSearchParams()
  if (options.limit) query.set('limit', String(options.limit))
  if (options.before) query.set('before', options.before)
  const text = query.toString()
  return apiFetch<unknown>(
    `/api/captures${text ? `?${text}` : ''}`,
    { signal: options.signal, cache: 'no-store' },
    "Couldn't load captures",
  ).then(parseCapturePage)
}

export function fetchCapture(
  id: string,
  signal?: AbortSignal,
): Promise<Capture> {
  return apiFetch<unknown>(
    `/api/captures/${id}`,
    { signal, cache: 'no-store' },
    "Couldn't load that capture",
  ).then(parseCapture)
}

export function saveCaption(id: string, caption: string): Promise<Capture> {
  return apiFetch<unknown>(
    `/api/captures/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption }),
    },
    "Couldn't save the caption. Try again.",
  ).then(parseCapture)
}

/** Reads a capture again after it couldn't be read. */
export function retryCapture(id: string): Promise<Capture> {
  return apiFetch<unknown>(
    `/api/captures/${id}/retry`,
    { method: 'POST' },
    "Couldn't start reading it again. Try again.",
  ).then(parseCapture)
}

/** The owner's tap on a suggestion: send it on, keep it here, or say it is not that kind. */
export function routeCapture(
  id: string,
  action: RouteAction,
): Promise<Capture> {
  return apiFetch<unknown>(
    `/api/captures/${id}/route`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    },
    "Couldn't do that. Try again.",
  ).then(parseCapture)
}

export function deleteCapture(id: string): Promise<void> {
  return apiFetch<unknown>(
    `/api/captures/${id}`,
    { method: 'DELETE' },
    "Couldn't delete it. Try again.",
  ).then(() => undefined)
}

export interface CaptureUpload {
  file: File
  /** Makes a retry safe: the same id again returns the saved capture. */
  clientId: string
  groupId?: string
  askId?: string
  caption?: string
  onProgress?: (percent: number) => void
  signal?: AbortSignal
}

function failure(xhr: XMLHttpRequest): ApiError {
  let message = "Couldn't send it"
  try {
    const detail = (JSON.parse(xhr.responseText) as { detail?: unknown }).detail
    if (typeof detail === 'string' && detail) message = detail
  } catch {
    // Not JSON (a proxy's page): keep the plain message.
  }
  return new ApiError(message, xhr.status)
}

/** Sends one file. XHR, not fetch, for the upload progress. */
export function uploadCapture(upload: CaptureUpload): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const form = new FormData()
    form.append('client_id', upload.clientId)
    if (upload.groupId) form.append('group_id', upload.groupId)
    if (upload.askId) form.append('ask_id', upload.askId)
    if (upload.caption) form.append('caption', upload.caption)
    form.append('file', upload.file, upload.file.name)

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable)
        upload.onProgress?.(Math.round((event.loaded / event.total) * 100))
    })
    xhr.addEventListener('load', () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(failure(xhr))
      try {
        resolve(parseCapture(JSON.parse(xhr.responseText)))
      } catch {
        reject(
          new ApiError('The server sent back something unexpected', xhr.status),
        )
      }
    })
    xhr.addEventListener('error', () =>
      reject(
        new ApiError("Couldn't reach Aico. Check the connection and retry", 0),
      ),
    )
    xhr.addEventListener('abort', () => reject(new ApiError('Cancelled', 0)))
    upload.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.open('POST', '/api/captures')
    xhr.send(form)
  })
}

/** Attaches the browser-made thumbnail; the capture is already saved either way. */
export async function uploadThumb(id: string, jpeg: Blob): Promise<void> {
  await apiFetch<unknown>(
    `/api/captures/${id}/thumb`,
    { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg },
    "Couldn't save the thumbnail",
  )
}
