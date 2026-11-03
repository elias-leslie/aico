// Notes: text notes and checklists (the Groceries list too), saved by
// aico-web in notes.db. The server's contract is packages/web-server/src/notes.ts.

import { apiFetch } from '../api-fetch'

export type NoteKind = 'note' | 'list' | 'prompt'

export interface NoteItem {
  id: string
  noteId: string
  text: string
  checked: boolean
  position: number
  /** From whoever added it: `struck` is a line the reader saw crossed out on the photo. */
  hint: string | null
  updatedAt: number
}

export interface NoteAttachment {
  id: string
  noteId: string
  captureId: string | null
  hash: string
  name: string
  mime: string
  size: number
  position: number
  hasThumb: boolean
}

interface NoteBase {
  id: string
  kind: NoteKind
  title: string
  pinned: boolean
  archived: boolean
  source: string | null
  createdAt: number
  editedAt: number
  updatedAt: number
  labels: string[]
  unchecked: number
  checked: number
}

export interface NoteSummary extends NoteBase {
  snippet: string
  attachmentCount: number
  activityAt: number
  /** The first unchecked items. */
  preview: NoteItem[]
}

export interface NoteDetail extends NoteBase {
  body: string
  items: NoteItem[]
  attachments: NoteAttachment[]
}

export interface NoteRevision {
  id: string
  field: 'title' | 'body'
  text: string
  savedAt: number
  reason: string
}

export const GROCERIES_SOURCE = 'aico:groceries'
export const GROCERIES_ID = 'groceries'
const NOTE_ID = /^([0-9a-f]{12}|groceries)$/

export const isNoteId = (value: string | null): value is string =>
  value !== null && NOTE_ID.test(value)

export const noteHref = (id: string) => `/notes?id=${id}`

export const attachmentUrl = (
  note: string,
  attachment: string,
  variant: 'file' | 'thumb' | 'preview',
) =>
  `/api/notes/${note}/attachments/${encodeURIComponent(attachment)}/${variant}`

/** The picture to show small: the thumbnail, else the server's preview (an
 * undecodable HEIC), else the image itself; null for a file with no picture. */
export function attachmentThumbSource(
  attachment: NoteAttachment,
): string | null {
  if (attachment.hasThumb)
    return attachmentUrl(attachment.noteId, attachment.id, 'thumb')
  if (!attachment.mime.startsWith('image/')) return null
  const heic = /hei[cf]/.test(attachment.mime)
  return attachmentUrl(
    attachment.noteId,
    attachment.id,
    heic ? 'preview' : 'file',
  )
}

function isNoteSummary(value: unknown): value is NoteSummary {
  if (!value || typeof value !== 'object') return false
  const note = value as Record<string, unknown>
  return (
    typeof note.id === 'string' &&
    typeof note.title === 'string' &&
    typeof note.pinned === 'boolean' &&
    Array.isArray(note.labels) &&
    typeof note.unchecked === 'number' &&
    typeof note.activityAt === 'number'
  )
}

export function parseNoteList(value: unknown): {
  notes: NoteSummary[]
  total: number
} {
  const page = value as { notes?: unknown; total?: unknown } | null
  if (!page || !Array.isArray(page.notes) || typeof page.total !== 'number')
    throw new Error('Invalid notes')
  return { notes: page.notes.filter(isNoteSummary), total: page.total }
}

export function parseNote(value: unknown): NoteDetail {
  const note = value as Record<string, unknown> | null
  if (
    !note ||
    typeof note.id !== 'string' ||
    typeof note.title !== 'string' ||
    typeof note.body !== 'string' ||
    !Array.isArray(note.items) ||
    !Array.isArray(note.attachments) ||
    !Array.isArray(note.labels)
  )
    throw new Error('Invalid note')
  return value as NoteDetail
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const KEEPALIVE_MAX = 60_000

function send<T>(
  url: string,
  method: string,
  body: unknown,
  failure: string,
): Promise<T> {
  const text = body === undefined ? undefined : JSON.stringify(body)
  return apiFetch<T>(
    url,
    {
      method,
      headers: text === undefined ? undefined : JSON_HEADERS,
      body: text,
      // A save sent as the window closes still arrives. The browser refuses
      // keepalive past 64 KB, so a long text goes as an ordinary request.
      keepalive: new TextEncoder().encode(text ?? '').length < KEEPALIVE_MAX,
    },
    failure,
  )
}

export interface NoteQuery {
  q?: string
  archived?: boolean
  signal?: AbortSignal
}

export function fetchNotes(query: NoteQuery = {}) {
  const params = new URLSearchParams({ limit: '500' })
  if (query.q) params.set('q', query.q)
  if (query.archived) params.set('archived', 'true')
  return apiFetch<unknown>(
    `/api/notes?${params}`,
    { signal: query.signal, cache: 'no-store' },
    "Couldn't load notes",
  ).then(parseNoteList)
}

export function fetchNote(id: string, signal?: AbortSignal) {
  return apiFetch<unknown>(
    `/api/notes/${id}`,
    { signal, cache: 'no-store' },
    "Couldn't load that note",
  ).then(parseNote)
}

export function createNote(
  input: { kind: NoteKind; title?: string } = { kind: 'note' },
) {
  return send<unknown>(
    '/api/notes',
    'POST',
    input,
    "Couldn't make the note. Try again.",
  ).then(parseNote)
}

export interface NotePatch {
  title?: string
  body?: string
  pinned?: boolean
  archived?: boolean
  kind?: NoteKind
  /** A restore: the server keeps the text it replaces. */
  keepRevision?: boolean
}

export function patchNote(id: string, patch: NotePatch) {
  return send<unknown>(
    `/api/notes/${id}`,
    'PATCH',
    patch,
    "Couldn't save the note",
  ).then(parseNote)
}

export function deleteNote(id: string) {
  return send<unknown>(
    `/api/notes/${id}`,
    'DELETE',
    undefined,
    "Couldn't delete it. Try again.",
  ).then(() => undefined)
}

export function addItem(noteId: string, text: string, position?: number) {
  return send<NoteItem>(
    `/api/notes/${noteId}/items`,
    'POST',
    position === undefined ? { text } : { text, position },
    "Couldn't add the item",
  )
}

export function patchItem(
  noteId: string,
  itemId: string,
  patch: { text?: string; checked?: boolean; position?: number },
) {
  return send<NoteItem>(
    `/api/notes/${noteId}/items/${itemId}`,
    'PATCH',
    patch,
    "Couldn't save the item",
  )
}

export function deleteItem(noteId: string, itemId: string) {
  return send<unknown>(
    `/api/notes/${noteId}/items/${itemId}`,
    'DELETE',
    undefined,
    "Couldn't remove the item",
  ).then(() => undefined)
}

export function putLabels(noteId: string, labels: string[]) {
  return send<{ labels: string[] }>(
    `/api/notes/${noteId}/labels`,
    'PUT',
    { labels },
    "Couldn't save the labels",
  )
}

export function attachCapture(noteId: string, captureId: string) {
  return send<NoteAttachment>(
    `/api/notes/${noteId}/attachments`,
    'POST',
    { captureId },
    "Couldn't attach it to the note",
  )
}

export function removeAttachment(noteId: string, attachmentId: string) {
  return send<unknown>(
    `/api/notes/${noteId}/attachments/${encodeURIComponent(attachmentId)}`,
    'DELETE',
    undefined,
    "Couldn't remove the file",
  ).then(() => undefined)
}

export function fetchRevisions(
  noteId: string,
  field: 'title' | 'body',
  signal?: AbortSignal,
) {
  return apiFetch<{ revisions?: NoteRevision[] }>(
    `/api/notes/${noteId}/revisions?field=${field}`,
    { signal, cache: 'no-store' },
    "Couldn't load the history",
  ).then((page) => (Array.isArray(page.revisions) ? page.revisions : []))
}

/** Where an item goes to land at `index` of the (position-ordered) `others`:
 * between its new neighbours, or a step past the end it joins. */
export function positionAt(others: readonly number[], index: number): number {
  const before = index > 0 ? others[index - 1] : undefined
  const after = index < others.length ? others[index] : undefined
  if (before !== undefined && after !== undefined) return (before + after) / 2
  if (before !== undefined) return before + 1
  if (after !== undefined) return after - 1
  return 1
}
