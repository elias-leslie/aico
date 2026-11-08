// Note routes: text notes and checklists (and the Groceries list the capture
// router fills), stored in notes.db. Same JSON style and error wording as
// captures. `groceries` works anywhere a note id does and makes the list on
// first use.

import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { hasBlob } from '@aico/notes/blobs'
import { maskSecrets } from '@aico/shared/secrets'
import { sendBlobVariant } from './captures'
import { objectBody, optionalString, RAW, type Router, requiredString, sendJson } from './http'
import {
  type AttachmentRow,
  NOTE_KINDS,
  type NoteDetail,
  type NoteItemRow,
  type NoteKind,
  type NotePatch,
  type NoteRow,
  type NoteSummary,
  PROJECT_ID,
  REVISED_FIELDS,
  type RevisedField,
  type RevisionRow,
} from './notes-data'
import type { NotesStore } from './notes-db'
import { HttpError } from './tether'

export interface NoteDeps {
  store: NotesStore
  blobsDir: string
}

const GROCERIES = 'groceries'
const NOTE_ID = /^[0-9a-f]{12}$/
const CHILD_ID = /^[0-9a-f]{12}(-[0-9]{1,4}|:.{1,200})?$/
const CAPTURE_ID = /^[0-9a-f]{12}$/
const TITLE_MAX = 500
const BODY_MAX = 200_000
const ITEM_MAX = 2000
const LABEL_MAX = 40
const LABELS_MAX = 30
const ITEMS_AT_CREATE_MAX = 500
const PAGE_DEFAULT = 100
const SNIPPET = 200
/** Read past the cut, so a token crossing it is still recognised and hidden whole. */
const SNIPPET_MARGIN = 400
const CREATE_KEYS = [
  'kind',
  'title',
  'body',
  'pinned',
  'labels',
  'items',
  'remindAt',
  'project',
  'madeBy',
]
const PATCH_KEYS = [
  'title',
  'body',
  'pinned',
  'archived',
  'kind',
  'keepRevision',
  'remindAt',
  'project',
]
/** A reminder time is a date between 2000 and 2100 (ms). */
const REMIND_MIN = Date.UTC(2000, 0, 1)
const REMIND_MAX = Date.UTC(2100, 0, 1)

interface ItemJson {
  id: string
  noteId: string
  text: string
  checked: boolean
  position: number
  /** A note from whoever added it, e.g. `struck` for a grocery line the reader saw crossed out. */
  hint: string | null
  updatedAt: number
}

interface AttachmentJson {
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

interface NoteJson {
  id: string
  kind: NoteKind
  title: string
  pinned: boolean
  archived: boolean
  scope: string | null
  /** The project it belongs to (the project registry's id), or null: a global note. */
  project: string | null
  source: string | null
  createdAt: number
  /** When the title or text was last changed (item changes do not move it). */
  editedAt: number
  updatedAt: number
  origin: string
  labels: string[]
  /** When to remind the owner (ms), or null. */
  remindAt: number | null
  /** When that reminder was sent, or null while it has not been. */
  remindedAt: number | null
}

export interface NoteSummaryJson extends NoteJson {
  /** The start of the text, one line's worth, for the list. */
  snippet: string
  unchecked: number
  checked: number
  attachmentCount: number
  /** The latest change to the note or any of its items; the list sorts by it. */
  activityAt: number
  /** The first unchecked items. */
  preview: ItemJson[]
}

export interface NoteDetailJson extends NoteJson {
  body: string
  unchecked: number
  checked: number
  items: ItemJson[]
  attachments: AttachmentJson[]
}

interface RevisionJson {
  id: string
  field: string
  text: string
  savedAt: number
  reason: string
}

function itemJson(row: NoteItemRow): ItemJson {
  return {
    id: row.id,
    noteId: row.note_id,
    text: row.text,
    checked: row.checked === 1,
    position: row.position,
    hint: row.hint,
    updatedAt: row.updated_at,
  }
}

function noteJson(row: NoteRow, labels: string[]): NoteJson {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    scope: row.scope,
    project: row.project,
    source: row.source,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    updatedAt: row.updated_at,
    origin: row.origin,
    labels,
    remindAt: row.remind_at,
    remindedAt: row.reminded_at,
  }
}

/** A list row: a preview, so anything that looks like a secret is hidden
 * (the note itself, opened, shows the real text). */
function summaryJson(row: NoteSummary): NoteSummaryJson {
  return {
    ...noteJson(row, row.labels),
    title: maskSecrets(row.title),
    snippet: maskSecrets(
      row.body
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SNIPPET + SNIPPET_MARGIN),
    ).slice(0, SNIPPET),
    unchecked: row.unchecked,
    checked: row.checked_count,
    attachmentCount: row.attachment_count,
    activityAt: row.activity_at,
    preview: row.preview.map((item) => ({ ...itemJson(item), text: maskSecrets(item.text) })),
  }
}

function detailJson(detail: NoteDetail, blobsDir: string): NoteDetailJson {
  return {
    ...noteJson(detail.note, detail.labels),
    body: detail.note.body,
    unchecked: detail.items.filter((item) => !item.checked).length,
    checked: detail.items.filter((item) => item.checked).length,
    items: detail.items.map(itemJson),
    attachments: detail.attachments.map((row) => attachmentJson(row, blobsDir)),
  }
}

function attachmentJson(row: AttachmentRow, blobsDir: string): AttachmentJson {
  return {
    id: row.id,
    noteId: row.note_id,
    captureId: row.capture_id,
    hash: row.hash,
    name: row.name,
    mime: row.mime,
    size: row.size,
    position: row.position,
    hasThumb: hasBlob(blobsDir, row.hash, 'thumb'),
  }
}

function revisionJson(row: RevisionRow): RevisionJson {
  return { id: row.id, field: row.field, text: row.text, savedAt: row.saved_at, reason: row.reason }
}

// -- Body checks ---------------------------------------------------------------

function onlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  message: string,
): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HttpError(422, message)
}

function optionalBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new HttpError(422, `${key} must be true or false`)
  return value
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new HttpError(422, `${key} must be a number`)
  return value
}

/** `remindAt`: a time in ms, null to clear it, undefined when the body leaves it out. */
function remindAt(body: Record<string, unknown>): number | null | undefined {
  if (!('remindAt' in body)) return undefined
  const value = body.remindAt
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < REMIND_MIN ||
    value > REMIND_MAX
  )
    throw new HttpError(422, 'remindAt must be a time in ms between 2000 and 2100, or null')
  return value
}

/** `project`: a project id, null for a global note, undefined when the body leaves it out. Only the
 * shape is checked: a project can leave the registry, or live on the other host, and its notes stay. */
function projectField(body: Record<string, unknown>): string | null | undefined {
  if (!('project' in body)) return undefined
  const value = body.project
  if (value === null) return null
  if (typeof value !== 'string' || !PROJECT_ID.test(value))
    throw new HttpError(422, 'project must be a project id, or null for no project')
  return value
}

function optionalKind(body: Record<string, unknown>): NoteKind | undefined {
  const kind = optionalString(body, 'kind', { max: 20 })
  if (kind === undefined) return undefined
  if (!(NOTE_KINDS as readonly string[]).includes(kind))
    throw new HttpError(422, `kind must be one of: ${NOTE_KINDS.join(', ')}`)
  return kind as NoteKind
}

function labelList(value: unknown, key = 'labels'): string[] {
  if (!Array.isArray(value)) throw new HttpError(422, `${key} must be a list of text`)
  if (value.length > LABELS_MAX) throw new HttpError(422, `At most ${LABELS_MAX} labels`)
  return value.map((label) => {
    if (typeof label !== 'string') throw new HttpError(422, `${key} must be a list of text`)
    const clean = label.trim()
    if (!clean) throw new HttpError(422, 'A label cannot be empty')
    if (clean.length > LABEL_MAX)
      throw new HttpError(422, `A label is at most ${LABEL_MAX} characters`)
    return clean
  })
}

function itemText(body: Record<string, unknown>, required: boolean): string | undefined {
  const text = required
    ? requiredString(body, 'text', { max: ITEM_MAX })
    : optionalString(body, 'text', { max: ITEM_MAX })
  if (text !== undefined && !text.trim()) throw new HttpError(422, 'text cannot be empty')
  return text
}

function boolQuery(value: string | null, name: string): boolean | undefined {
  if (value === null || value === '') return undefined
  if (value !== 'true' && value !== 'false')
    throw new HttpError(422, `${name} must be true or false`)
  return value === 'true'
}

/** `?project=ID` shows one project's notes; left out, every note (the All scope). */
function projectQuery(query: URLSearchParams): string | undefined {
  const value = query.get('project')
  if (value === null || value === '') return undefined
  if (!PROJECT_ID.test(value)) throw new HttpError(422, 'project must be a project id')
  return value
}

/** An Aico session's id: who made a note, for `tether note delete`. */
const SESSION_ID = /^[0-9a-f]{8}$/

/** The note's `source` when a session makes it: synced with the note, and unique as a source must be. */
function madeBySource(madeBy: unknown): string | undefined {
  if (madeBy === undefined) return undefined
  if (typeof madeBy !== 'string' || !SESSION_ID.test(madeBy))
    throw new HttpError(422, 'madeBy must be a session id')
  return `session:${madeBy}:${randomBytes(4).toString('hex')}`
}

/** A session deletes only a note it made, and not once the owner has reworded it: no agent command
 * changes a title or body. The route is a guard against mistakes; the owner's own delete sends no `madeBy`. */
function refuseUnlessMadeBy(row: NoteRow, session: string): void {
  if (!SESSION_ID.test(session) || !row.source?.startsWith(`session:${session}:`))
    throw new HttpError(
      403,
      "This session didn't make that note, so it stays; the owner can delete it on the Notes page",
    )
  if (row.edited_at > row.created_at)
    throw new HttpError(
      403,
      'The owner has edited that note since this session made it, so it stays; they can delete it on the Notes page',
    )
}

function created(res: ServerResponse, payload: unknown): typeof RAW {
  sendJson(res, 201, payload)
  return RAW
}

export function registerNoteRoutes(router: Router, deps: NoteDeps): void {
  const notes = deps.store.notes
  const { blobsDir } = deps

  /** A live note by id, or the Groceries list by its alias. */
  function need(id: string): NoteRow {
    if (id === GROCERIES) return notes.groceries()
    const row = NOTE_ID.test(id) ? notes.getNote(id) : null
    if (!row) throw new HttpError(404, 'That note is gone')
    return row
  }

  function child(id: string, what: string): string {
    if (!CHILD_ID.test(id)) throw new HttpError(404, `That ${what} is gone`)
    return id
  }

  const detail = (id: string): NoteDetailJson =>
    detailJson(notes.detail(id) as NoteDetail, blobsDir)

  router.on('GET', '/api/notes/labels', (ctx) => {
    const archivedText = ctx.query.get('archived')
    const archived = archivedText === 'all' ? 'all' : boolQuery(archivedText, 'archived')
    return { labels: deps.store.notes.labelCounts(archived, projectQuery(ctx.query)) }
  })

  router.on('GET', '/api/notes', (ctx) => {
    const kind = ctx.query.get('kind') || undefined
    if (kind && !(NOTE_KINDS as readonly string[]).includes(kind))
      throw new HttpError(422, `Unknown kind. Use one of: ${NOTE_KINDS.join(', ')}`)
    const archivedText = ctx.query.get('archived')
    const archived = archivedText === 'all' ? 'all' : boolQuery(archivedText, 'archived')
    const limitText = ctx.query.get('limit')
    const limit = limitText === null || limitText === '' ? PAGE_DEFAULT : Number(limitText)
    const offsetText = ctx.query.get('offset')
    const offset = offsetText === null || offsetText === '' ? 0 : Number(offsetText)
    if (!Number.isInteger(limit) || limit < 1)
      throw new HttpError(422, 'limit must be a whole number from 1')
    if (!Number.isInteger(offset) || offset < 0)
      throw new HttpError(422, 'offset must be a whole number from 0')
    const q = ctx.query.get('q') || undefined
    if (q && q.length > 200) throw new HttpError(422, 'q is too long')
    const { notes: rows, total } = notes.list({
      kind: kind as NoteKind | undefined,
      label: ctx.query.get('label') || undefined,
      pinned: boolQuery(ctx.query.get('pinned'), 'pinned'),
      project: projectQuery(ctx.query),
      reminders: boolQuery(ctx.query.get('reminders'), 'reminders'),
      archived,
      q,
      limit,
      offset,
    })
    return { notes: rows.map(summaryJson), total }
  })

  router.on('POST', '/api/notes', async (ctx) => {
    const body = objectBody(await ctx.body())
    onlyKeys(body, CREATE_KEYS, `Only ${CREATE_KEYS.join(', ')} can be set`)
    const title = optionalString(body, 'title', { max: TITLE_MAX }) ?? ''
    const text = optionalString(body, 'body', { max: BODY_MAX }) ?? ''
    const rawItems = body.items
    if (rawItems !== undefined && !Array.isArray(rawItems))
      throw new HttpError(422, 'items must be a list')
    if ((rawItems?.length ?? 0) > ITEMS_AT_CREATE_MAX)
      throw new HttpError(422, `At most ${ITEMS_AT_CREATE_MAX} items at once`)
    const items = (rawItems ?? []).map((entry: unknown) => {
      const fields = typeof entry === 'string' ? { text: entry } : entry
      if (!fields || typeof fields !== 'object' || Array.isArray(fields))
        throw new HttpError(422, 'items must be text or {text, checked}')
      const itemBody = fields as Record<string, unknown>
      return {
        text: itemText(itemBody, true) as string,
        checked: optionalBool(itemBody, 'checked'),
      }
    })
    const row = notes.create({
      source: madeBySource(body.madeBy),
      kind: optionalKind(body),
      title,
      body: text,
      pinned: optionalBool(body, 'pinned'),
      project: projectField(body) ?? null,
      labels: body.labels === undefined ? undefined : labelList(body.labels),
      items,
      remindAt: remindAt(body),
    })
    return created(ctx.res, detail(row.id))
  })

  router.on('GET', '/api/notes/:id', (ctx) => detail(need(ctx.params.id).id))

  router.on('PATCH', '/api/notes/:id', async (ctx) => {
    const row = need(ctx.params.id)
    const body = objectBody(await ctx.body())
    onlyKeys(body, PATCH_KEYS, `Only ${PATCH_KEYS.join(', ')} can be changed`)
    const patch: NotePatch = {
      title: optionalString(body, 'title', { max: TITLE_MAX }),
      body: optionalString(body, 'body', { max: BODY_MAX }),
      pinned: optionalBool(body, 'pinned'),
      archived: optionalBool(body, 'archived'),
      kind: optionalKind(body),
      keepRevision: optionalBool(body, 'keepRevision'),
      remindAt: remindAt(body),
      project: projectField(body),
    }
    if (!notes.update(row.id, patch)) throw new HttpError(404, 'That note is gone')
    return detail(row.id)
  })

  router.on('DELETE', '/api/notes/:id', (ctx) => {
    const row = need(ctx.params.id)
    const session = ctx.query.get('madeBy')
    if (session !== null) refuseUnlessMadeBy(row, session)
    notes.remove(row.id)
    return { deleted: true, id: row.id }
  })

  // -- Items --------------------------------------------------------------------

  router.on('POST', '/api/notes/:id/items', async (ctx) => {
    const row = need(ctx.params.id)
    const body = objectBody(await ctx.body())
    onlyKeys(body, ['text', 'checked', 'position'], 'Only text, checked and position can be set')
    const item = notes.addItem(row.id, {
      text: itemText(body, true) as string,
      checked: optionalBool(body, 'checked'),
      position: optionalNumber(body, 'position'),
    })
    if (!item) throw new HttpError(404, 'That note is gone')
    return created(ctx.res, itemJson(item))
  })

  router.on('PATCH', '/api/notes/:id/items/:itemId', async (ctx) => {
    const row = need(ctx.params.id)
    const body = objectBody(await ctx.body())
    onlyKeys(
      body,
      ['text', 'checked', 'position'],
      'Only text, checked and position can be changed',
    )
    const item = notes.updateItem(row.id, child(ctx.params.itemId, 'item'), {
      text: itemText(body, false),
      checked: optionalBool(body, 'checked'),
      position: optionalNumber(body, 'position'),
    })
    if (!item) throw new HttpError(404, 'That item is gone')
    return itemJson(item)
  })

  router.on('DELETE', '/api/notes/:id/items/:itemId', (ctx) => {
    const row = need(ctx.params.id)
    const id = child(ctx.params.itemId, 'item')
    if (!notes.removeItem(row.id, id)) throw new HttpError(404, 'That item is gone')
    return { deleted: true, id }
  })

  // -- Labels -------------------------------------------------------------------

  router.on('PUT', '/api/notes/:id/labels', async (ctx) => {
    const row = need(ctx.params.id)
    const body = objectBody(await ctx.body())
    const labels = notes.setLabels(row.id, labelList(body.labels))
    if (!labels) throw new HttpError(404, 'That note is gone')
    return { labels }
  })

  // -- Attachments ----------------------------------------------------------------

  router.on('POST', '/api/notes/:id/attachments', async (ctx) => {
    const row = need(ctx.params.id)
    const body = objectBody(await ctx.body())
    const captureId = requiredString(body, 'captureId', { max: 12, pattern: CAPTURE_ID })
    const capture = deps.store.getCapture(captureId)
    if (!capture) throw new HttpError(404, 'That capture is gone')
    if (!capture.hash) throw new HttpError(409, 'That capture has no file to attach')
    const attachment = notes.attach(row.id, {
      captureId: capture.id,
      hash: capture.hash,
      name: capture.name,
      mime: capture.mime,
      size: capture.size,
    })
    if (!attachment) throw new HttpError(404, 'That note is gone')
    return created(ctx.res, attachmentJson(attachment, blobsDir))
  })

  router.on('DELETE', '/api/notes/:id/attachments/:attachmentId', (ctx) => {
    const row = need(ctx.params.id)
    const id = child(ctx.params.attachmentId, 'attachment')
    if (!notes.removeAttachment(row.id, id)) throw new HttpError(404, 'That attachment is gone')
    return { deleted: true, id }
  })

  /** The attachment's own bytes (by hash), so it still shows if the capture is deleted. */
  for (const variant of ['file', 'thumb', 'preview'] as const)
    router.on('GET', `/api/notes/:id/attachments/:attachmentId/${variant}`, async (ctx) => {
      const row = need(ctx.params.id)
      const attachment = notes.getAttachment(row.id, child(ctx.params.attachmentId, 'attachment'))
      if (!attachment) throw new HttpError(404, 'That attachment is gone')
      await sendBlobVariant(
        ctx.res,
        blobsDir,
        attachment,
        variant === 'file' ? 'original' : variant,
      )
      return RAW
    })

  // -- Revisions ------------------------------------------------------------------

  router.on('GET', '/api/notes/:id/revisions', (ctx) => {
    const row = need(ctx.params.id)
    const field = ctx.query.get('field') || undefined
    if (field && !(REVISED_FIELDS as readonly string[]).includes(field))
      throw new HttpError(422, `field must be one of: ${REVISED_FIELDS.join(', ')}`)
    return {
      revisions: notes.revisions(row.id, field as RevisedField | undefined).map(revisionJson),
    }
  })
}
