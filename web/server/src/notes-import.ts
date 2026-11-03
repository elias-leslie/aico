// Import into Notes (Milestone 8): SummitFlow's notes table and a Google Keep
// Takeout folder. Both become the same shape (`ImportNote`) and go in through
// the notes layer (`NoteStore`), so every row carries the sync stamps and
// replicates like a note made in the app. A stable `source` per note
// (`summitflow:<id>`, `keep:<created usec>`) makes a rerun update in place.
//
// Takeout data is untrusted: only JSON is parsed and files are only read as
// bytes (hashed and stored); nothing in it is ever executed.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { blobPath, hasBlob, putOriginal, sha256 } from './blobs'
import type { NoteKind, NoteRow, NoteStore } from './notes-data'

// -- The shape both sources map to ------------------------------------------------

export interface ImportFile {
  /** Where the bytes are on disk. */
  path: string
  name: string
  mime: string
}

export interface ImportNote {
  source: string
  kind: NoteKind
  title: string
  body: string
  pinned: boolean
  archived: boolean
  scope: string | null
  labels: string[]
  items: { text: string; checked: boolean }[]
  /** ms */
  createdAt: number
  editedAt: number
  files: ImportFile[]
}

/** What an import dropped or could not carry over, by reason (counted, never silent). */
export type Drops = Record<string, number>

const bump = (drops: Drops, reason: string, by = 1) => {
  if (by > 0) drops[reason] = (drops[reason] ?? 0) + by
}

// -- Applying one note --------------------------------------------------------------

export type Outcome = 'created' | 'updated' | 'unchanged' | 'deleted-in-aico'

interface Stored {
  hash: string
  size: number
  file: ImportFile
}

const sameSet = (a: string[], b: string[]) => {
  const left = new Set(a.map((x) => x.toLowerCase()))
  const right = new Set(b.map((x) => x.toLowerCase()))
  return left.size === right.size && [...left].every((x) => right.has(x))
}

/** The attachment id key for a file: its content, so a rerun is the same row. */
export const fileKey = (hash: string) => `file-${hash.slice(0, 16)}`

/**
 * Creates the note, or updates the one with this `source` when something
 * differs. With `dryRun` it only reports what would happen. A note the owner
 * deleted in Aico stays deleted. Blobs are written before the rows that name them.
 */
export async function applyNote(
  notes: NoteStore,
  blobsDir: string,
  note: ImportNote,
  dryRun: boolean,
): Promise<Outcome> {
  const existing = notes.findBySource(note.source, true)
  if (existing?.deleted) return 'deleted-in-aico'

  const stored: Stored[] = []
  for (const file of note.files) {
    const bytes = readFileSync(file.path)
    const hash = dryRun ? sha256(bytes) : await putOriginal(blobsDir, bytes)
    stored.push({ hash, size: bytes.length, file })
  }

  if (!existing) {
    if (dryRun) return 'created'
    const row = notes.create({
      kind: note.kind,
      title: note.title,
      body: note.body,
      pinned: note.pinned,
      archived: note.archived,
      scope: note.scope,
      source: note.source,
      labels: note.labels,
      items: note.items,
      createdAt: note.createdAt,
      editedAt: note.editedAt,
    })
    attachAll(notes, row.id, stored)
    return 'created'
  }

  const items = notes.items(existing.id)
  const itemsSame =
    items.length === note.items.length &&
    items.every(
      (row, index) =>
        row.text === note.items[index].text && Boolean(row.checked) === note.items[index].checked,
    )
  const have = new Set(notes.attachments(existing.id).map((row) => row.id))
  const filesSame = stored.every((s) => have.has(`${existing.id}:${fileKey(s.hash)}`))
  const fieldsSame =
    existing.kind === note.kind &&
    existing.title === note.title &&
    existing.body === note.body &&
    Boolean(existing.pinned) === note.pinned &&
    Boolean(existing.archived) === note.archived &&
    existing.scope === note.scope
  const labelsSame = sameSet(notes.labelsOf(existing.id), note.labels)
  if (fieldsSame && itemsSame && filesSame && labelsSame) return 'unchanged'
  if (dryRun) return 'updated'

  notes.update(existing.id, {
    kind: note.kind,
    title: note.title,
    body: note.body,
    pinned: note.pinned,
    archived: note.archived,
    scope: note.scope,
    editedAt: note.editedAt,
  })
  if (!labelsSame) notes.setLabels(existing.id, note.labels)
  if (!itemsSame) replaceItems(notes, existing, note.items)
  attachAll(notes, existing.id, stored)
  return 'updated'
}

function attachAll(notes: NoteStore, noteId: string, stored: Stored[]): void {
  for (const s of stored)
    notes.attachFile(noteId, {
      key: fileKey(s.hash),
      hash: s.hash,
      name: s.file.name,
      mime: s.file.mime,
      size: s.size,
    })
}

/** Makes the live items equal `wanted`, in order, changing only rows that differ. */
function replaceItems(notes: NoteStore, note: NoteRow, wanted: ImportNote['items']): void {
  const items = notes.items(note.id)
  wanted.forEach((item, index) => {
    const row = items[index]
    const position = index + 1
    if (row) notes.updateItem(note.id, row.id, { text: item.text, checked: item.checked, position })
    else notes.addItem(note.id, { text: item.text, checked: item.checked, position })
  })
  for (const row of items.slice(wanted.length)) notes.removeItem(note.id, row.id)
}

// -- SummitFlow ---------------------------------------------------------------------

/** The columns of SummitFlow's `notes` table that matter. */
export interface SummitflowRow {
  id: string
  project_scope: string | null
  type: string
  title: string | null
  content: string | null
  tags: string[] | null
  pinned: boolean | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/** `type=prompt` stays a prompt; every other type is a plain note (counted in `drops`). */
export function mapSummitflow(rows: SummitflowRow[]): { notes: ImportNote[]; drops: Drops } {
  const drops: Drops = {}
  const notes = rows.map((row): ImportNote => {
    if (row.type !== 'prompt' && row.type !== 'note')
      bump(drops, `type "${row.type}" imported as a note`)
    if (row.metadata && Object.keys(row.metadata).length > 0) bump(drops, 'metadata dropped')
    const scope = row.project_scope?.trim() || null
    const labels = [...(row.tags ?? []), ...(scope ? [`project:${scope}`] : [])]
    const created = Date.parse(row.created_at)
    const edited = Date.parse(row.updated_at)
    return {
      source: `summitflow:${row.id}`,
      kind: row.type === 'prompt' ? 'prompt' : 'note',
      title: row.title ?? '',
      body: row.content ?? '',
      pinned: Boolean(row.pinned),
      archived: false,
      scope,
      labels,
      items: [],
      createdAt: created,
      editedAt: Number.isFinite(edited) ? edited : created,
      files: [],
    }
  })
  return { notes, drops }
}

export interface ImportCounts {
  total: number
  created: number
  updated: number
  unchanged: number
  deletedInAico: number
}

export async function importAll(
  notes: NoteStore,
  blobsDir: string,
  list: ImportNote[],
  dryRun: boolean,
): Promise<{ counts: ImportCounts; outcomes: Map<string, Outcome> }> {
  const counts: ImportCounts = {
    total: list.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    deletedInAico: 0,
  }
  const outcomes = new Map<string, Outcome>()
  for (const note of list) {
    const outcome = await applyNote(notes, blobsDir, note, dryRun)
    outcomes.set(note.source, outcome)
    if (outcome === 'deleted-in-aico') counts.deletedInAico += 1
    else counts[outcome] += 1
  }
  return { counts, outcomes }
}

// -- Keep Takeout -------------------------------------------------------------------

interface KeepJson {
  title?: unknown
  textContent?: unknown
  listContent?: unknown
  labels?: unknown
  annotations?: unknown
  attachments?: unknown
  sharees?: unknown
  color?: unknown
  isPinned?: unknown
  isArchived?: unknown
  isTrashed?: unknown
  createdTimestampUsec?: unknown
  userEditedTimestampUsec?: unknown
}

export interface KeepAttachmentRef {
  /** The path the JSON names. */
  filePath: string
  mimetype: string
  /** The file found for it (null: none in the folder). */
  found: string | null
  /** True when only the stem matched (Takeout writes `.jpeg` in the JSON and `.jpg` on disk). */
  byStem: boolean
}

export interface KeepNoteEntry {
  /** The JSON file's name in the folder. */
  file: string
  status: 'note' | 'trashed'
  note: ImportNote
  attachments: KeepAttachmentRef[]
  /** Counts of what this note drops, by reason. */
  drops: Drops
}

export interface KeepUnreadableEntry {
  file: string
  status: 'unreadable'
  /** Why it is unreadable. */
  error: string
  attachments: KeepAttachmentRef[]
  drops: Drops
}

export type KeepEntry = KeepNoteEntry | KeepUnreadableEntry

export interface KeepFolder {
  /** The folder holding the note JSON files. */
  dir: string
  entries: KeepEntry[]
  /** Files in the folder that are not note JSON or the HTML twin of one. */
  otherFiles: string[]
  /** HTML files with no JSON of the same name. */
  orphanHtml: string[]
  /** Keep ids that two notes would share (the later one gets a suffix). */
  duplicateIds: string[]
}

/** Takeout/Keep inside the folder the owner extracted, or the folder itself. */
export function findKeepDir(dir: string): string {
  for (const candidate of [dir, join(dir, 'Keep'), join(dir, 'Takeout', 'Keep')]) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      if (readdirSync(candidate).some((name) => name.toLowerCase().endsWith('.json')))
        return candidate
    }
  }
  throw new Error(`No Keep notes (.json files) found in ${dir} or its Takeout/Keep folder`)
}

const stemOf = (name: string) => name.slice(0, name.length - extname(name).length)
const asString = (value: unknown) => (typeof value === 'string' ? value : '')
const usecToMs = (value: unknown) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number / 1000) : 0
}

export function readKeepFolder(input: string): KeepFolder {
  const dir = findKeepDir(input)
  const names = readdirSync(dir).sort()
  const jsonNames = names.filter((name) => name.toLowerCase().endsWith('.json'))
  const jsonStems = new Set(jsonNames.map(stemOf))
  const htmlNames = names.filter((name) => name.toLowerCase().endsWith('.html'))
  const otherFiles = names.filter((name) => {
    const lower = name.toLowerCase()
    return (
      !lower.endsWith('.json') && !lower.endsWith('.html') && statSync(join(dir, name)).isFile()
    )
  })
  const byStem = new Map<string, string[]>()
  for (const name of otherFiles)
    byStem.set(stemOf(name), [...(byStem.get(stemOf(name)) ?? []), name])

  const used = new Set<string>()
  const duplicateIds: string[] = []
  const entries = jsonNames.map((file): KeepEntry => {
    let json: KeepJson
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not a note object')
      json = parsed as KeepJson
    } catch (error) {
      return {
        file,
        status: 'unreadable',
        error: (error as Error).message,
        attachments: [],
        drops: {},
      }
    }
    const drops: Drops = {}
    const attachments = refsOf(json, dir, otherFiles, byStem)
    const parsed = keepNote(json, file, attachments, drops, used, duplicateIds)
    return {
      file,
      status: json.isTrashed === true ? 'trashed' : 'note',
      note: parsed,
      attachments,
      drops,
    }
  })
  return {
    dir,
    entries,
    otherFiles,
    orphanHtml: htmlNames.filter((name) => !jsonStems.has(stemOf(name))),
    duplicateIds,
  }
}

function refsOf(
  json: KeepJson,
  dir: string,
  files: string[],
  byStem: Map<string, string[]>,
): KeepAttachmentRef[] {
  if (!Array.isArray(json.attachments)) return []
  return json.attachments.map((item): KeepAttachmentRef => {
    const ref = (item ?? {}) as Record<string, unknown>
    const filePath = asString(ref.filePath)
    const name = basename(filePath)
    const mimetype = asString(ref.mimetype)
    if (name && files.includes(name))
      return { filePath, mimetype, found: join(dir, name), byStem: false }
    const matches = name ? (byStem.get(stemOf(name)) ?? []) : []
    if (matches.length === 1)
      return { filePath, mimetype, found: join(dir, matches[0]), byStem: true }
    return { filePath, mimetype, found: null, byStem: false }
  })
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.3gp': 'audio/3gpp',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
}

function keepNote(
  json: KeepJson,
  file: string,
  refs: KeepAttachmentRef[],
  drops: Drops,
  used: Set<string>,
  duplicateIds: string[],
): ImportNote {
  const created = usecToMs(json.createdTimestampUsec)
  const edited = usecToMs(json.userEditedTimestampUsec) || created
  let id = String(json.createdTimestampUsec ?? stemOf(file))
  if (used.has(id)) {
    duplicateIds.push(id)
    id = `${id}-${stemOf(file)}`
  }
  used.add(id)

  const rawItems = Array.isArray(json.listContent) ? json.listContent : null
  const items: ImportNote['items'] = []
  for (const raw of rawItems ?? []) {
    const item = (raw ?? {}) as Record<string, unknown>
    const text = asString(item.text)
    if (text.trim() === '') bump(drops, 'empty list items dropped')
    else items.push({ text, checked: item.isChecked === true })
  }

  let body = asString(json.textContent)
  const links = Array.isArray(json.annotations)
    ? json.annotations.flatMap((raw) => {
        const note = (raw ?? {}) as Record<string, unknown>
        const url = asString(note.url)
        if (!url) return []
        const title = asString(note.title)
        return [title ? `- ${title}: ${url}` : `- ${url}`]
      })
    : []
  if (links.length > 0) body = `${body}${body ? '\n\n' : ''}Links:\n${links.join('\n')}`

  if (asString(json.color) && json.color !== 'DEFAULT') bump(drops, 'colour dropped')
  if (Array.isArray(json.sharees) && json.sharees.length > 0) bump(drops, 'sharees dropped')

  const labels = Array.isArray(json.labels)
    ? json.labels.flatMap((raw) => {
        const name = asString(((raw ?? {}) as Record<string, unknown>).name).trim()
        return name ? [name] : []
      })
    : []
  const trashed = json.isTrashed === true
  if (trashed) labels.push('trashed')

  return {
    source: `keep:${id}`,
    kind: rawItems ? 'list' : 'note',
    title: asString(json.title),
    body,
    pinned: json.isPinned === true,
    archived: json.isArchived === true || trashed,
    scope: null,
    labels,
    items,
    createdAt: created || Date.now(),
    editedAt: edited || created || Date.now(),
    files: refs.flatMap((ref) =>
      ref.found
        ? [
            {
              path: ref.found,
              name: basename(ref.found),
              mime:
                ref.mimetype ||
                MIME_BY_EXT[extname(ref.found).toLowerCase()] ||
                'application/octet-stream',
            },
          ]
        : [],
    ),
  }
}

// -- Keep: recipes and car notes first ------------------------------------------------

/** What to put at the top of the Keep report: topic id to the words that mark it (title or label). */
export const PRIORITY_TOPICS: Record<string, RegExp> = {
  recipe: /recipe|cookbook|cooking|baking/i,
  car: /\b(car|cars|vehicle|vehicles|truck|auto|oil change|odometer|mileage|tires?)\b/i,
}

export function topicsOf(note: ImportNote): string[] {
  const title = note.title || note.body.split('\n', 1)[0]
  return Object.entries(PRIORITY_TOPICS)
    .filter(
      ([, pattern]) => pattern.test(title) || note.labels.some((label) => pattern.test(label)),
    )
    .map(([topic]) => topic)
}

// -- Keep: the report -------------------------------------------------------------------

export interface KeepPlan {
  folder: KeepFolder
  /** Entries that will be imported (trashed ones only with `includeTrashed`). */
  entries: KeepNoteEntry[]
  skipped: KeepNoteEntry[]
  unreadable: KeepUnreadableEntry[]
  drops: Drops
}

export function planKeep(folder: KeepFolder, includeTrashed: boolean): KeepPlan {
  const readable = folder.entries.filter(
    (entry): entry is KeepNoteEntry => entry.status !== 'unreadable',
  )
  const entries = readable.filter((entry) => entry.status === 'note' || includeTrashed)
  const drops: Drops = {}
  for (const entry of entries)
    for (const [reason, n] of Object.entries(entry.drops)) bump(drops, reason, n)
  return {
    folder,
    entries,
    skipped: readable.filter((entry) => entry.status === 'trashed' && !includeTrashed),
    unreadable: folder.entries.filter(
      (entry): entry is KeepUnreadableEntry => entry.status === 'unreadable',
    ),
    drops,
  }
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
const shown = (note: ImportNote) =>
  cell(note.title || `(untitled) ${note.body.split('\n', 1)[0].slice(0, 50)}`)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function noteTable(entries: KeepNoteEntry[], outcomes?: Map<string, Outcome>): string[] {
  const rows = [
    `| Title | Kind | Labels | Items | Files | Flags | ${outcomes ? 'Result' : 'Would'} |`,
    '| --- | --- | --- | ---: | ---: | --- | --- |',
  ]
  for (const entry of entries) {
    const note = entry.note
    const flags = [
      note.pinned ? 'pinned' : '',
      note.archived && entry.status === 'note' ? 'archived' : '',
      entry.status === 'trashed' ? 'was in trash' : '',
    ].filter(Boolean)
    const missing = entry.attachments.filter((ref) => !ref.found).length
    const outcome = outcomes?.get(note.source) ?? '-'
    rows.push(
      `| ${shown(note)} | ${note.kind === 'list' ? 'list' : 'note'} | ${cell(note.labels.join(', ')) || '-'} | ${note.items.length || '-'} | ${note.files.length || '-'}${missing ? ` (${missing} missing)` : ''} | ${flags.join(', ') || '-'} | ${outcome} |`,
    )
  }
  return rows
}

/** The Markdown report for an import run or dry run. */
export function keepReport(
  plan: KeepPlan,
  options: { dryRun: boolean; counts: ImportCounts; outcomes: Map<string, Outcome> },
): string {
  const { folder } = plan
  const lines: string[] = []
  const verb = options.dryRun ? 'Would' : 'Did'
  lines.push(`# Google Keep import ${options.dryRun ? 'dry run' : 'report'}`, '')
  lines.push(`Folder: ${folder.dir}`, '')
  if (options.dryRun) lines.push('Nothing was written. This is what the import would do.', '')

  const lists = plan.entries.filter((e) => e.note?.kind === 'list').length
  const attachmentFiles = plan.entries.reduce((n, e) => n + e.note.files.length, 0)
  const missingFiles = plan.entries.reduce(
    (n, e) => n + e.attachments.filter((a) => !a.found).length,
    0,
  )
  const topical = plan.entries.filter((e) => topicsOf(e.note).length > 0)
  const { counts } = options

  lines.push('## Summary', '')
  lines.push(`- Note files in the export: ${folder.entries.length}`)
  lines.push(
    `- Imported${options.dryRun ? ' (would be)' : ''}: ${plan.entries.length} (${plan.entries.length - lists} notes, ${plural(lists, 'list')})`,
  )
  lines.push(
    `- ${verb} create: ${counts.created}, update: ${counts.updated}, already there and unchanged: ${counts.unchanged}${counts.deletedInAico ? `, deleted in Aico and left deleted: ${counts.deletedInAico}` : ''}`,
  )
  lines.push(`- Skipped, in the Keep trash: ${plan.skipped.length}`)
  lines.push(`- Unreadable: ${plan.unreadable.length}`)
  lines.push(`- Recipe or car notes (by title or label): ${topical.length}`)
  lines.push(
    `- Attachment files found: ${attachmentFiles}, referenced but missing: ${missingFiles}, in the folder but not referenced: ${unreferenced(folder).length}`,
  )
  lines.push(
    `- Dropped: ${
      Object.keys(plan.drops).length === 0
        ? 'nothing counted'
        : Object.entries(plan.drops)
            .map(([r, n]) => `${r} (${n})`)
            .join(', ')
    }`,
  )
  lines.push('')

  lines.push('## Recipes and car notes', '')
  if (topical.length === 0) lines.push('None matched.', '')
  else {
    for (const topic of Object.keys(PRIORITY_TOPICS)) {
      const group = topical.filter((e) => topicsOf(e.note).includes(topic))
      if (group.length === 0) continue
      lines.push(
        `### ${topic === 'recipe' ? 'Recipes' : 'Car'}`,
        '',
        ...noteTable(group, options.dryRun ? undefined : options.outcomes),
        '',
      )
    }
  }

  const rest = plan.entries.filter((e) => topicsOf(e.note).length === 0)
  lines.push(`## Other notes (${rest.length})`, '')
  if (rest.length === 0) lines.push('None.', '')
  else lines.push(...noteTable(rest, options.dryRun ? undefined : options.outcomes), '')

  lines.push(`## Skipped: in the Keep trash (${plan.skipped.length})`, '')
  if (plan.skipped.length === 0) lines.push('None.', '')
  else {
    lines.push(
      'These are left out. `--include-trashed` brings them in as archived notes labelled "trashed".',
      '',
    )
    for (const entry of plan.skipped) lines.push(`- ${shown(entry.note)} (${entry.file})`)
    lines.push('')
  }

  lines.push(`## Unreadable (${plan.unreadable.length})`, '')
  if (plan.unreadable.length === 0) lines.push('None.', '')
  else {
    for (const entry of plan.unreadable) lines.push(`- ${entry.file}: ${entry.error}`)
    lines.push('')
  }

  lines.push('## Dropped or changed', '')
  const dropRows = Object.entries(plan.drops)
  if (dropRows.length === 0) lines.push('Nothing counted.')
  else for (const [reason, n] of dropRows) lines.push(`- ${reason}: ${n}`)
  lines.push(
    '- The HTML twin of each note is not read; the JSON carries the same text.',
    '- Links Keep stored beside a note are appended to its text under "Links:".',
  )
  if (folder.duplicateIds.length > 0)
    lines.push(`- Notes sharing a Keep id (kept apart by file name): ${folder.duplicateIds.length}`)
  if (folder.orphanHtml.length > 0) {
    lines.push('', `HTML files with no JSON (${folder.orphanHtml.length}), not imported:`)
    for (const name of folder.orphanHtml) lines.push(`- ${name}`)
  }
  const stem = plan.entries.flatMap((e) => e.attachments.filter((a) => a.byStem))
  if (stem.length > 0)
    lines.push(
      '',
      `Attachments found by file-name stem (the .jpeg/.jpg Takeout quirk): ${stem.length}`,
    )
  lines.push('')
  return lines.join('\n')
}

// -- Keep: verify -------------------------------------------------------------------

/** Files in the folder that no note's JSON names. */
export function unreferenced(folder: KeepFolder): string[] {
  const referenced = new Set(
    folder.entries.flatMap((e) =>
      e.attachments.flatMap((a) => (a.found ? [basename(a.found)] : [])),
    ),
  )
  return folder.otherFiles.filter((name) => !referenced.has(name))
}

export interface VerifyResult {
  /** Problems by kind; empty when the import is complete. */
  problems: { kind: string; detail: string }[]
  notes: number
  inAico: number
  attachmentsChecked: number
  report: string
}

/**
 * The completeness check. Every JSON is a note or a named skip; every
 * attachment file in the folder is stored and re-hashes to its blob; every
 * attachment a note names exists. Anything unmatched is listed.
 */
export function verifyKeep(
  notes: NoteStore,
  blobsDir: string,
  folder: KeepFolder,
  includeTrashed = false,
): VerifyResult {
  const problems: VerifyResult['problems'] = []
  const problem = (kind: string, detail: string) => problems.push({ kind, detail })
  const skips: string[] = []
  const plan = planKeep(folder, includeTrashed)
  for (const entry of plan.unreadable) problem('unreadable JSON', `${entry.file}: ${entry.error}`)
  for (const entry of plan.skipped) skips.push(`${entry.file} (in the Keep trash)`)
  for (const name of folder.orphanHtml) problem('HTML without JSON', name)
  for (const name of unreferenced(folder))
    problem('extra file in the folder, no note names it', name)

  let inAico = 0
  let checked = 0
  const wantedSources = new Set<string>()
  for (const entry of plan.entries) {
    const note = entry.note
    wantedSources.add(note.source)
    for (const ref of entry.attachments)
      if (!ref.found)
        problem('attachment missing from the folder', `${entry.file}: ${ref.filePath}`)
    const row = notes.findBySource(note.source)
    if (!row) {
      problem('note not in Aico', `${entry.file} (${note.source})`)
      continue
    }
    inAico += 1
    const where = `${entry.file} (${note.source})`
    if (row.title !== note.title) problem('title differs', where)
    if (row.body !== note.body) problem('text differs', where)
    if (row.kind !== note.kind) problem('kind differs', where)
    const items = notes.items(row.id)
    if (items.length !== note.items.length)
      problem(
        'item count differs',
        `${where}: ${items.length} in Aico, ${note.items.length} in Keep`,
      )
    if (!sameSet(notes.labelsOf(row.id), note.labels)) problem('labels differ', where)
    const attached = notes.attachments(row.id)
    const expected = new Map<string, { path: string; name: string }>()
    for (const file of note.files) {
      const hash = sha256(readFileSync(file.path))
      expected.set(`${row.id}:${fileKey(hash)}`, { path: file.path, name: file.name })
    }
    for (const [id, file] of expected)
      if (!attached.some((a) => a.id === id))
        problem('attachment not stored on the note', `${where}: ${file.name}`)
    for (const attachment of attached) {
      checked += 1
      if (!expected.has(attachment.id)) {
        problem('extra attachment on the note', `${where}: ${attachment.name}`)
        continue
      }
      if (!hasBlob(blobsDir, attachment.hash)) {
        problem('attachment blob missing', `${where}: ${attachment.name}`)
        continue
      }
      const actual = sha256(readFileSync(blobPath(blobsDir, attachment.hash)))
      if (actual !== attachment.hash)
        problem('attachment blob does not re-hash to its name', `${where}: ${attachment.name}`)
    }
  }
  // Notes in Aico from Keep that this folder no longer has.
  for (const row of notes.list({ archived: 'all', limit: 500 }).notes)
    if (row.source?.startsWith('keep:') && !wantedSources.has(row.source))
      problem('note in Aico not in this folder', row.source)

  const lines = ['# Keep import verification', '', `Folder: ${folder.dir}`, '']
  lines.push(
    `- Note files: ${folder.entries.length}; to import: ${plan.entries.length}; named skips: ${skips.length}`,
    `- In Aico: ${inAico} of ${plan.entries.length}`,
    `- Attachments checked against their blobs: ${checked}`,
    `- Result: ${problems.length === 0 ? 'complete, nothing unmatched' : `${plural(problems.length, 'problem')}`}`,
    '',
  )
  if (skips.length > 0) lines.push('## Named skips', '', ...skips.map((s) => `- ${s}`), '')
  if (problems.length > 0) {
    lines.push('## Unmatched', '')
    const kinds = [...new Set(problems.map((p) => p.kind))]
    for (const kind of kinds) {
      const group = problems.filter((p) => p.kind === kind)
      lines.push(`### ${kind} (${group.length})`, '', ...group.map((p) => `- ${p.detail}`), '')
    }
  }
  return {
    problems,
    notes: plan.entries.length,
    inAico,
    attachmentsChecked: checked,
    report: lines.join('\n'),
  }
}
