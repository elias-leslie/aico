// Notes: the rows behind lists and text notes (notes, note_items, note_labels,
// attachments, note_revisions) in notes.db. NotesStore owns the database, the
// clock and the transaction; this class only adds the rows, always through
// `core.stamp()`, so every change carries the sync columns like a capture does.
//
// Search uses FTS5 when the bundled SQLite has it (`notes_fts`, a local index
// rebuilt from the rows, never synced) and LIKE otherwise.

import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_NOTE_REVISION_MINUTES } from './config'
import { baseOf } from './sync/engine'

/** What the project registry's ids look like (a slug), bounded. */
export const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const NOTE_KINDS = ['note', 'list', 'prompt'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

/** The one well-known list captures of groceries are appended to. */
const GROCERIES_SOURCE = 'aico:groceries'
/** The only fields whose old text is kept as a revision. */
export const REVISED_FIELDS = ['title', 'body'] as const
export type RevisedField = (typeof REVISED_FIELDS)[number]

interface Sync {
  updated_at: number
  origin: string
  prev: number | null
  prev_origin: string | null
  deleted: number
  seq: number
}

export interface NoteRow extends Sync {
  id: string
  kind: NoteKind
  title: string
  body: string
  pinned: number
  archived: number
  scope: string | null
  /** The project it belongs to (the project registry's id), or null: a global note. */
  project: string | null
  source: string | null
  created_at: number
  edited_at: number
  /** When the owner wants a reminder (ms), or null. */
  remind_at: number | null
  /** When that reminder was sent, or null while it has not been. */
  reminded_at: number | null
}

export interface NoteItemRow extends Sync {
  id: string
  note_id: string
  text: string
  checked: number
  position: number
  /** Set by whoever added it (the grocery reader marks a struck line `struck`). */
  hint: string | null
}

interface NoteLabelRow extends Sync {
  id: string
  note_id: string
  label: string
}

export interface AttachmentRow extends Sync {
  id: string
  note_id: string
  capture_id: string | null
  hash: string
  name: string
  mime: string
  size: number
  position: number
}

export interface RevisionRow extends Sync {
  id: string
  table_name: string
  row_id: string
  field: string
  text: string
  saved_at: number
  reason: 'conflict' | 'edit'
}

/** A note as the list shows it: counts of live items, labels and a few unchecked items. */
export interface NoteSummary extends NoteRow {
  unchecked: number
  checked_count: number
  attachment_count: number
  /** The latest change to the note or any of its items (what the list sorts by). */
  activity_at: number
  labels: string[]
  preview: NoteItemRow[]
}

export interface NoteDetail {
  note: NoteRow
  items: NoteItemRow[]
  labels: string[]
  attachments: AttachmentRow[]
}

export interface NoteQuery {
  kind?: NoteKind
  label?: string
  pinned?: boolean
  /** Only notes with a reminder, soonest first. Archived ones count unless `archived` says otherwise. */
  reminders?: boolean
  /** false (default): live notes only; true: archived only; 'all': both. */
  archived?: boolean | 'all'
  /** Only this project's notes; left out: every note, global ones too. */
  project?: string
  q?: string
  limit?: number
  offset?: number
}

export interface NewNote {
  kind?: NoteKind
  title?: string
  body?: string
  pinned?: boolean
  archived?: boolean
  scope?: string | null
  project?: string | null
  source?: string | null
  labels?: string[]
  items?: { text: string; checked?: boolean; hint?: string | null }[]
  /** ms; an import keeps the note's original times (default: now). */
  createdAt?: number
  editedAt?: number
  /** ms: remind the owner then. */
  remindAt?: number | null
}

export interface NotePatch {
  title?: string
  body?: string
  pinned?: boolean
  archived?: boolean
  kind?: NoteKind
  scope?: string | null
  /** Move the note to a project, or null to make it global. */
  project?: string | null
  /** ms to remind the owner, or null for none. A new time sends again. */
  remindAt?: number | null
  /** ms; with a title or text change, the edit time to keep instead of now (imports). */
  editedAt?: number
  /** Keep the old title or text even inside the revision window: a restore
   * replaces it whole, so it must stay restorable. */
  keepRevision?: boolean
}

export interface ItemPatch {
  text?: string
  checked?: boolean
  position?: number
}

/** What a note needs of the store that owns the database. */
export interface NoteCore {
  db: DatabaseSync
  transaction<T>(work: () => T): T
  stamp(): { updated_at: number; origin: string; seq: number }
  now(): number
  /** Minimum time between two kept revisions of one field. */
  revisionWindowMs?: number
  /** false: use LIKE even where FTS5 exists (tests). */
  fts?: boolean
}

type Row = Record<string, unknown>
type Value = string | number | null

const newId = () => randomBytes(6).toString('hex')
const bit = (value: boolean) => (value ? 1 : 0)
const PREVIEW_ITEMS = 6

/** `%`, `_` and `\` in user text must not act as LIKE wildcards. */
const likePattern = (word: string) => `%${word.replace(/[\\%_]/g, '\\$&')}%`

export class NoteStore {
  private readonly db: DatabaseSync
  private readonly windowMs: number
  /** True when `notes_fts` exists and search goes through it. */
  readonly fts: boolean

  constructor(private readonly core: NoteCore) {
    this.db = core.db
    this.windowMs = core.revisionWindowMs ?? DEFAULT_NOTE_REVISION_MINUTES * 60_000
    this.fts = core.fts !== false && this.openFts()
    if (this.fts) this.rebuildIndex()
  }

  // -- Search index -------------------------------------------------------------

  private openFts(): boolean {
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
           note_id UNINDEXED, title, body, items, labels, tokenize = 'unicode61 remove_diacritics 2')`,
      )
      return true
    } catch {
      return false // this SQLite has no FTS5; search uses LIKE
    }
  }

  /** Rebuilds the whole index from the rows (small data); runs at open. */
  rebuildIndex(): void {
    if (!this.fts) return
    this.core.transaction(() => {
      this.db.exec('DELETE FROM notes_fts')
      const ids = this.db.prepare('SELECT id FROM notes WHERE deleted = 0').all() as Row[]
      for (const row of ids) this.reindex(String(row.id))
    })
  }

  /** Refreshes the search entries of notes whose rows sync just changed. */
  reindexNotes(noteIds: Iterable<string>): void {
    for (const id of new Set(noteIds)) this.reindex(id)
  }

  private reindex(noteId: string): void {
    if (!this.fts) return
    this.db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(noteId)
    const note = this.getNote(noteId)
    if (!note) return
    const items = (
      this.db
        .prepare('SELECT text FROM note_items WHERE note_id = ? AND deleted = 0')
        .all(noteId) as Row[]
    )
      .map((row) => String(row.text))
      .join('\n')
    this.db
      .prepare('INSERT INTO notes_fts (note_id, title, body, items, labels) VALUES (?, ?, ?, ?, ?)')
      .run(noteId, note.title, note.body, items, this.labelsOf(noteId).join('\n'))
  }

  // -- Row helpers --------------------------------------------------------------

  /** Re-stamps one row with new field values; `prev` is the base it is built on (`baseOf`). */
  private edit(
    table: 'notes' | 'note_items' | 'note_labels' | 'attachments',
    id: string,
    current: Sync,
    fields: Record<string, Value>,
  ): void {
    const stamp = this.core.stamp()
    const base = baseOf(stamp.origin, current, current.updated_at)
    const names = Object.keys(fields)
    this.db
      .prepare(
        `UPDATE ${table} SET ${names.map((name) => `${name} = ?`).join(', ')},
           updated_at = ?, origin = ?, prev = ?, prev_origin = ?, seq = ? WHERE id = ?`,
      )
      .run(
        ...names.map((name) => fields[name] as Value),
        stamp.updated_at,
        stamp.origin,
        base.prev,
        base.prev_origin,
        stamp.seq,
        id,
      )
  }

  private insert(table: string, fields: Record<string, Value>): void {
    const stamp = this.core.stamp()
    const all: Record<string, Value> = {
      ...fields,
      updated_at: stamp.updated_at,
      origin: stamp.origin,
      prev: null,
      deleted: 0,
      seq: stamp.seq,
    }
    const names = Object.keys(all)
    this.db
      .prepare(
        `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      )
      .run(...names.map((name) => all[name] as Value))
  }

  // -- Notes --------------------------------------------------------------------

  /** One note; a tombstone reads as missing unless `includeDeleted`. */
  getNote(id: string, includeDeleted = false): NoteRow | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as unknown as
      | NoteRow
      | undefined
    return row && (includeDeleted || !row.deleted) ? row : null
  }

  /** The live note with this stable `source`, or null. */
  findBySource(source: string, includeDeleted = false): NoteRow | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE source = ?').get(source) as unknown as
      | NoteRow
      | undefined
    return row && (includeDeleted || !row.deleted) ? row : null
  }

  create(input: NewNote): NoteRow {
    return this.core.transaction(() => this.createNow(input))
  }

  private createNow(input: NewNote): NoteRow {
    const id = newId()
    const now = this.core.now()
    this.insert('notes', {
      id,
      kind: input.kind ?? 'note',
      title: input.title ?? '',
      body: input.body ?? '',
      pinned: bit(input.pinned ?? false),
      archived: bit(input.archived ?? false),
      scope: input.scope ?? null,
      project: input.project ?? null,
      source: input.source ?? null,
      created_at: input.createdAt ?? now,
      edited_at: input.editedAt ?? input.createdAt ?? now,
      remind_at: input.remindAt ?? null,
      reminded_at: null,
    })
    for (const item of input.items ?? [])
      this.addItemNow(id, { text: item.text, checked: item.checked, hint: item.hint })
    if (input.labels?.length) this.setLabelsNow(id, input.labels)
    this.reindex(id)
    return this.getNote(id) as NoteRow
  }

  /**
   * Edits title, body, pinned, archived or kind. Changing the title or body
   * keeps the old text as a revision (see `recordRevision`). Null: no such note.
   */
  update(id: string, patch: NotePatch): NoteRow | null {
    return this.core.transaction(() => {
      const current = this.getNote(id)
      if (!current) return null
      const fields: Record<string, Value> = {}
      if (patch.kind !== undefined && patch.kind !== current.kind) fields.kind = patch.kind
      if (patch.pinned !== undefined && bit(patch.pinned) !== current.pinned)
        fields.pinned = bit(patch.pinned)
      if (patch.archived !== undefined && bit(patch.archived) !== current.archived)
        fields.archived = bit(patch.archived)
      let edited = false
      for (const field of REVISED_FIELDS) {
        const next = patch[field]
        if (next === undefined || next === current[field]) continue
        this.recordRevision('notes', id, field, current[field], patch.keepRevision)
        fields[field] = next
        edited = true
      }
      if (patch.scope !== undefined && patch.scope !== current.scope) fields.scope = patch.scope
      if (patch.project !== undefined && patch.project !== current.project)
        fields.project = patch.project
      if (patch.remindAt !== undefined && patch.remindAt !== current.remind_at) {
        fields.remind_at = patch.remindAt
        fields.reminded_at = null
      }
      if (edited) fields.edited_at = patch.editedAt ?? this.core.now()
      if (Object.keys(fields).length === 0) return current
      this.edit('notes', id, current, fields)
      this.reindex(id)
      return this.getNote(id)
    })
  }

  // -- Reminders ----------------------------------------------------------------

  /** Live notes whose reminder time has come and has not been sent, soonest first. */
  dueReminders(now: number): NoteRow[] {
    return this.db
      .prepare(
        `SELECT * FROM notes WHERE deleted = 0 AND remind_at IS NOT NULL AND remind_at <= ?
           AND reminded_at IS NULL ORDER BY remind_at, id`,
      )
      .all(now) as unknown as NoteRow[]
  }

  /**
   * Marks the reminder sent, if it is still due and unsent (the row is read again inside the
   * transaction, so a second caller, or a reminder the owner just moved, gets null). The mark
   * syncs, which is how the other host knows not to send it.
   */
  claimReminder(id: string, now: number): NoteRow | null {
    return this.core.transaction(() => {
      const current = this.getNote(id)
      if (!current || current.remind_at === null || current.remind_at > now) return null
      if (current.reminded_at !== null) return null
      this.edit('notes', id, current, { reminded_at: now })
      return this.getNote(id)
    })
  }

  /** Takes the sent mark off (the notice could not be queued), so the next pass tries again. */
  releaseReminder(id: string, remindAt: number): void {
    this.core.transaction(() => {
      const current = this.getNote(id)
      if (current && current.remind_at === remindAt && current.reminded_at !== null)
        this.edit('notes', id, current, { reminded_at: null })
    })
  }

  /** Tombstones the note. Its items and files stay (hidden with it). */
  remove(id: string): boolean {
    return this.core.transaction(() => {
      const current = this.getNote(id)
      if (!current) return false
      this.edit('notes', id, current, { deleted: 1 })
      this.reindex(id)
      return true
    })
  }

  // -- Revisions ----------------------------------------------------------------

  /**
   * Keeps `oldText` as an 'edit' revision of a field, unless the field already
   * has one newer than the window, so continuous typing leaves one row per few
   * minutes, not one per save; `always` keeps it regardless. Insert-only. Call
   * inside a transaction.
   */
  private recordRevision(
    table: string,
    rowId: string,
    field: string,
    oldText: string,
    always = false,
  ): void {
    if (oldText === '') return
    const last = this.db
      .prepare(
        `SELECT max(saved_at) AS at FROM note_revisions
           WHERE table_name = ? AND row_id = ? AND field = ? AND reason = 'edit'`,
      )
      .get(table, rowId, field) as Row
    const now = this.core.now()
    if (!always && last.at !== null && now - Number(last.at) < this.windowMs) return
    this.insert('note_revisions', {
      id: newId(),
      table_name: table,
      row_id: rowId,
      field,
      text: oldText,
      saved_at: now,
      reason: 'edit',
    })
  }

  /**
   * Sync lost an edit to a newer one: keep its text. The id is derived from
   * the losing version, so both hosts make the same row and a replay adds none.
   */
  addConflictRevision(revision: {
    id: string
    table: string
    rowId: string
    field: string
    text: string
  }): void {
    this.core.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM note_revisions WHERE id = ?').get(revision.id)) return
      this.insert('note_revisions', {
        id: revision.id,
        table_name: revision.table,
        row_id: revision.rowId,
        field: revision.field,
        text: revision.text,
        saved_at: this.core.now(),
        reason: 'conflict',
      })
    })
  }

  /** Earlier texts of a note, newest first. */
  revisions(noteId: string, field?: RevisedField, limit = 50): RevisionRow[] {
    const where = ["table_name = 'notes'", 'row_id = ?', 'deleted = 0']
    const args: Value[] = [noteId]
    if (field) {
      where.push('field = ?')
      args.push(field)
    }
    return this.db
      .prepare(
        `SELECT * FROM note_revisions WHERE ${where.join(' AND ')}
           ORDER BY saved_at DESC, seq DESC LIMIT ?`,
      )
      .all(...args, limit) as unknown as RevisionRow[]
  }

  // -- Items --------------------------------------------------------------------

  items(noteId: string): NoteItemRow[] {
    return this.db
      .prepare('SELECT * FROM note_items WHERE note_id = ? AND deleted = 0 ORDER BY position, id')
      .all(noteId) as unknown as NoteItemRow[]
  }

  getItem(noteId: string, itemId: string): NoteItemRow | null {
    const row = this.db
      .prepare('SELECT * FROM note_items WHERE id = ? AND note_id = ? AND deleted = 0')
      .get(itemId, noteId) as unknown as NoteItemRow | undefined
    return row ?? null
  }

  private nextPosition(table: 'note_items' | 'attachments', noteId: string): number {
    const row = this.db
      .prepare(`SELECT max(position) AS p FROM ${table} WHERE note_id = ? AND deleted = 0`)
      .get(noteId) as Row
    return row.p === null ? 1 : Number(row.p) + 1
  }

  /** Adds an item (at `position`, else the end). Null: no such note. */
  addItem(
    noteId: string,
    item: { text: string; checked?: boolean; position?: number; hint?: string | null },
  ): NoteItemRow | null {
    return this.core.transaction(() => {
      if (!this.getNote(noteId)) return null
      const row = this.addItemNow(noteId, item)
      this.reindex(noteId)
      return row
    })
  }

  private addItemNow(
    noteId: string,
    item: { id?: string; text: string; checked?: boolean; position?: number; hint?: string | null },
  ): NoteItemRow {
    const id = item.id ?? newId()
    this.insert('note_items', {
      id,
      note_id: noteId,
      text: item.text,
      checked: bit(item.checked ?? false),
      position: item.position ?? this.nextPosition('note_items', noteId),
      hint: item.hint ?? null,
    })
    return this.db
      .prepare('SELECT * FROM note_items WHERE id = ?')
      .get(id) as unknown as NoteItemRow
  }

  /** Edits an item's text, checked state or position. Null: no such item. */
  updateItem(noteId: string, itemId: string, patch: ItemPatch): NoteItemRow | null {
    return this.core.transaction(() => {
      const current = this.getItem(noteId, itemId)
      if (!current) return null
      const fields: Record<string, Value> = {}
      if (patch.text !== undefined && patch.text !== current.text) fields.text = patch.text
      if (patch.checked !== undefined && bit(patch.checked) !== current.checked)
        fields.checked = bit(patch.checked)
      if (patch.position !== undefined && patch.position !== current.position)
        fields.position = patch.position
      if (Object.keys(fields).length === 0) return current
      this.edit('note_items', itemId, current, fields)
      this.reindex(noteId)
      return this.getItem(noteId, itemId)
    })
  }

  removeItem(noteId: string, itemId: string): boolean {
    return this.core.transaction(() => {
      const current = this.getItem(noteId, itemId)
      if (!current) return false
      this.edit('note_items', itemId, current, { deleted: 1 })
      this.reindex(noteId)
      return true
    })
  }

  // -- Labels -------------------------------------------------------------------

  labelsOf(noteId: string): string[] {
    return (
      this.db
        .prepare('SELECT label FROM note_labels WHERE note_id = ? AND deleted = 0 ORDER BY label')
        .all(noteId) as Row[]
    ).map((row) => String(row.label))
  }

  /** Makes the note's labels exactly `labels` (case-insensitive repeats dropped). Null: no such note. */
  setLabels(noteId: string, labels: string[]): string[] | null {
    return this.core.transaction(() => {
      if (!this.getNote(noteId)) return null
      this.setLabelsNow(noteId, labels)
      this.reindex(noteId)
      return this.labelsOf(noteId)
    })
  }

  private setLabelsNow(noteId: string, labels: string[]): void {
    const wanted = new Map<string, string>()
    for (const label of labels)
      if (!wanted.has(label.toLowerCase())) wanted.set(label.toLowerCase(), label)
    const existing = this.db
      .prepare('SELECT * FROM note_labels WHERE note_id = ?')
      .all(noteId) as unknown as NoteLabelRow[]
    const seen = new Set<string>()
    for (const row of existing) {
      const key = row.label.toLowerCase()
      const keep = wanted.get(key) === row.label
      if (keep) seen.add(key)
      if (keep && row.deleted) this.edit('note_labels', row.id, row, { deleted: 0 })
      else if (!keep && !row.deleted) this.edit('note_labels', row.id, row, { deleted: 1 })
    }
    for (const [key, label] of wanted) {
      if (seen.has(key)) continue
      const id = `${noteId}:${label}`
      if (!existing.some((row) => row.id === id))
        this.insert('note_labels', { id, note_id: noteId, label })
    }
  }

  // -- Attachments --------------------------------------------------------------

  attachments(noteId: string): AttachmentRow[] {
    return this.db
      .prepare('SELECT * FROM attachments WHERE note_id = ? AND deleted = 0 ORDER BY position, id')
      .all(noteId) as unknown as AttachmentRow[]
  }

  getAttachment(noteId: string, id: string): AttachmentRow | null {
    const row = this.db
      .prepare('SELECT * FROM attachments WHERE id = ? AND note_id = ? AND deleted = 0')
      .get(id, noteId) as unknown as AttachmentRow | undefined
    return row ?? null
  }

  /** Attaches a capture's file to a note (again: the same attachment). Null: no such note. */
  attach(
    noteId: string,
    file: { captureId: string; hash: string; name: string; mime: string; size: number },
  ): AttachmentRow | null {
    return this.core.transaction(() => {
      if (!this.getNote(noteId)) return null
      return this.attachNow(noteId, file)
    })
  }

  /**
   * Attaches a file that did not come from a capture (an import). `key` makes
   * the attachment id, so the same file again (or a rerun) is the same row.
   */
  attachFile(
    noteId: string,
    file: { key: string; hash: string; name: string; mime: string; size: number },
  ): AttachmentRow | null {
    return this.core.transaction(() => {
      if (!this.getNote(noteId)) return null
      return this.attachNow(noteId, { ...file, captureId: null })
    })
  }

  private attachNow(
    noteId: string,
    file: {
      captureId: string | null
      key?: string
      hash: string
      name: string
      mime: string
      size: number
    },
  ): AttachmentRow {
    const id = `${noteId}:${file.key ?? file.captureId}`
    const existing = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as unknown as
      | AttachmentRow
      | undefined
    if (existing) return existing // a removed attachment stays removed
    this.insert('attachments', {
      id,
      note_id: noteId,
      capture_id: file.captureId,
      hash: file.hash,
      name: file.name,
      mime: file.mime,
      size: file.size,
      position: this.nextPosition('attachments', noteId),
    })
    return this.db
      .prepare('SELECT * FROM attachments WHERE id = ?')
      .get(id) as unknown as AttachmentRow
  }

  removeAttachment(noteId: string, id: string): boolean {
    return this.core.transaction(() => {
      const current = this.getAttachment(noteId, id)
      if (!current) return false
      this.edit('attachments', id, current, { deleted: 1 })
      return true
    })
  }

  // -- Reading ------------------------------------------------------------------

  detail(id: string): NoteDetail | null {
    const note = this.getNote(id)
    if (!note) return null
    return {
      note,
      items: this.items(id),
      labels: this.labelsOf(id),
      attachments: this.attachments(id),
    }
  }

  /**
   * Pinned first, then the latest change; tombstones and (by default) archived
   * notes are left out. `total` counts every match, not just this page.
   */
  list(query: NoteQuery = {}): { notes: NoteSummary[]; total: number } {
    const where = ['n.deleted = 0']
    const args: Value[] = []
    const archived = query.archived ?? (query.reminders ? 'all' : false)
    if (archived !== 'all') {
      where.push('n.archived = ?')
      args.push(bit(archived === true))
    }
    if (query.reminders) where.push('n.remind_at IS NOT NULL')
    if (query.kind) {
      where.push('n.kind = ?')
      args.push(query.kind)
    }
    if (query.pinned !== undefined) {
      where.push('n.pinned = ?')
      args.push(bit(query.pinned))
    }
    if (query.project !== undefined) {
      where.push('n.project = ?')
      args.push(query.project)
    }
    if (query.label) {
      where.push(
        `EXISTS (SELECT 1 FROM note_labels l WHERE l.note_id = n.id AND l.deleted = 0
                   AND l.label = ? COLLATE NOCASE)`,
      )
      args.push(query.label)
    }
    const words = (query.q ?? '').trim().split(/\s+/).filter(Boolean)
    if (words.length) this.searchClause(words, where, args)

    const total = Number(
      (
        this.db
          .prepare(`SELECT count(*) AS n FROM notes n WHERE ${where.join(' AND ')}`)
          .get(...args) as Row
      ).n,
    )
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500)
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0)
    const rows = this.db
      .prepare(
        `SELECT n.*,
           (SELECT count(*) FROM note_items i WHERE i.note_id = n.id AND i.deleted = 0 AND i.checked = 0) AS unchecked,
           (SELECT count(*) FROM note_items i WHERE i.note_id = n.id AND i.deleted = 0 AND i.checked = 1) AS checked_count,
           (SELECT count(*) FROM attachments a WHERE a.note_id = n.id AND a.deleted = 0) AS attachment_count,
           max(n.edited_at,
               coalesce((SELECT max(i.updated_at) FROM note_items i WHERE i.note_id = n.id), 0)) AS activity_at
         FROM notes n WHERE ${where.join(' AND ')}
         ORDER BY ${
           query.reminders ? 'n.remind_at ASC, n.id' : 'n.pinned DESC, activity_at DESC, n.id DESC'
} LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as unknown as (NoteRow & {
      unchecked: number
      checked_count: number
      attachment_count: number
      activity_at: number
    })[]
    const notes = rows.map((row) => ({
      ...row,
      labels: this.labelsOf(row.id),
      preview: this.db
        .prepare(
          `SELECT * FROM note_items WHERE note_id = ? AND deleted = 0 AND checked = 0
             ORDER BY position, id LIMIT ?`,
        )
        .all(row.id, PREVIEW_ITEMS) as unknown as NoteItemRow[],
    }))
    return { notes, total }
  }

  /** Each label in use on live notes with how many notes carry it (one casing per label). */
  labelCounts(
    archived: boolean | 'all' = false,
    project?: string,
  ): { label: string; count: number }[] {
    const args: Value[] = archived === 'all' ? [] : [bit(archived)]
    if (project !== undefined) args.push(project)
    const rows = this.db
      .prepare(
        `SELECT min(l.label) AS label, count(DISTINCT l.note_id) AS count
           FROM note_labels l JOIN notes n ON n.id = l.note_id
          WHERE l.deleted = 0 AND n.deleted = 0 ${archived === 'all' ? '' : 'AND n.archived = ?'}
            ${project === undefined ? '' : 'AND n.project = ?'}
          GROUP BY lower(l.label) ORDER BY lower(l.label)`,
      )
      .all(...args) as Row[]
    return rows.map((row) => ({ label: String(row.label), count: Number(row.count) }))
  }

  /** Every word must match the title, body, an item or a label (a word start in FTS, any part in LIKE). */
  private searchClause(words: string[], where: string[], args: Value[]): void {
    const tokens = words.flatMap((word) => word.match(/[\p{L}\p{N}]+/gu) ?? [])
    if (this.fts && tokens.length > 0) {
      where.push('n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?)')
      args.push(tokens.map((token) => `"${token}"*`).join(' '))
      return
    }
    for (const word of words) {
      const pattern = likePattern(word)
      where.push(
        `(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM note_items i WHERE i.note_id = n.id AND i.deleted = 0 AND i.text LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM note_labels l WHERE l.note_id = n.id AND l.deleted = 0 AND l.label LIKE ? ESCAPE '\\'))`,
      )
      args.push(pattern, pattern, pattern, pattern)
    }
  }

  // -- What the capture router files here ---------------------------------------

  /**
   * The Groceries list, made on first use. A tombstoned one is set aside (its
   * `source` renamed) so a fresh list starts empty and the unique source is free.
   */
  groceries(): NoteRow {
    return this.core.transaction(() => {
      const found = this.findBySource(GROCERIES_SOURCE, true)
      if (found && !found.deleted) return found
      if (found)
        this.edit('notes', found.id, found, { source: `${GROCERIES_SOURCE}:removed:${found.id}` })
      // Sync can leave a live list under `aico:groceries~<id>` (the other door made
      // one too and the owner deleted the winner): that list is the Groceries list.
      const duplicate = this.db
        .prepare('SELECT id FROM notes WHERE deleted = 0 AND source LIKE ? ORDER BY id LIMIT 1')
        .get(`${GROCERIES_SOURCE}~%`) as Row | undefined
      const adopted = duplicate ? this.getNote(String(duplicate.id)) : null
      if (adopted) {
        this.edit('notes', adopted.id, adopted, { source: GROCERIES_SOURCE })
        return this.getNote(adopted.id) as NoteRow
      }
      return this.createNow({ kind: 'list', title: 'Groceries', source: GROCERIES_SOURCE })
    })
  }

  /**
   * Appends the items a capture was read as to the Groceries list, unchecked,
   * and attaches its photo. Item ids come from the capture id, so doing it
   * again (a retry, a re-read) adds nothing; an item the owner deleted stays gone.
   */
  fileGroceries(
    file: { captureId: string; hash: string; name: string; mime: string; size: number },
    items: { text: string; hint?: string | null }[],
  ): { noteId: string; added: number } {
    return this.core.transaction(() => {
      const list = this.groceries()
      let added = 0
      items.forEach((item, index) => {
        const id = `${file.captureId}-${index}`
        if (this.db.prepare('SELECT 1 FROM note_items WHERE id = ?').get(id)) return
        this.addItemNow(list.id, { id, text: item.text, hint: item.hint })
        added += 1
      })
      this.attachNow(list.id, file)
      this.reindex(list.id)
      return { noteId: list.id, added }
    })
  }

  /**
   * One note for a capture (source `capture:<id>`), with the file attached.
   * Again for the same capture: the same note, even if the owner deleted it.
   */
  fileNote(
    file: { captureId: string; hash: string; name: string; mime: string; size: number },
    content: { title: string; body: string; project?: string | null },
  ): string {
    return this.core.transaction(() => {
      const source = `capture:${file.captureId}`
      const existing = this.findBySource(source, true)
      if (existing) return existing.id
      const note = this.createNow({
        kind: 'note',
        title: content.title,
        body: content.body,
        project: content.project ?? null,
        source,
      })
      this.attachNow(note.id, file)
      return note.id
    })
  }

  /** True when a note holds this capture's file (the owner added it from a note). */
  hasCaptureAttachment(captureId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM attachments WHERE capture_id = ? AND deleted = 0 LIMIT 1')
        .get(captureId) !== undefined
    )
  }

  /** How many attachments (tombstones too) still point at this blob. */
  countHashRefs(hash: string): number {
    return Number(
      (this.db.prepare('SELECT count(*) AS n FROM attachments WHERE hash = ?').get(hash) as Row).n,
    )
  }
}
