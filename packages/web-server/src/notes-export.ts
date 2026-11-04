// The nightly readable copy of the notes. Each host builds a staging folder (regenerable, under the data dir)
// from notes.db and the blob store, then `rclone copy --update`s it to a SummitFlow-Notes folder on Drive with
// its own dedicated rclone config. Copy only: nothing is ever synced or deleted on Drive, so a note deleted (or
// renamed) here leaves its old file there until the owner cleans the folder.
//
//   notes/<year>/<title-slug>-<id6>.md   front matter, text, `- [ ]` items, attachment links
//   photos/<hash>.<ext>                  every attached photo or file, and every capture's
//   captures.md                          the capture list with what was read from each
//
// Every file's modification time is the time of its newest change (never the time of the run) and nothing in a
// file depends on the host, so the two hosts build identical staging folders and `--update` leaves a file the
// other host already sent alone.

import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { blobPath, hasBlob } from '@aico/notes/blobs'
import { extensionForMime, needsPreview } from '@aico/notes/capture-files'
import { RAW, type Router, sendJson } from './http'
import type { SyncLoop } from './sync/loop'

export interface ExportConfig {
  /** Where the staging folder is built (under the data dir). */
  stagingDir: string
  /** The dedicated rclone config; written by scripts/authorize-notes-drive.sh, never the backup's. */
  rcloneConfig: string
  rclonePath: string
  /** The remote's name in that config. */
  remote: string
  /** The Drive folder, created by the first copy. */
  folder: string
  /** A peer (hosts.json name) that does this export while the link to it is up; null: always export. */
  deferTo: string | null
}

export interface StagingSummary {
  notes: number
  photos: number
  captures: number
  /** Attachments whose file this host does not have yet (the note links nothing for them). */
  missingFiles: number
}

export type ExportStatus = 'uploaded' | 'skipped' | 'no-login' | 'failed'

export interface ExportResult extends Partial<StagingSummary> {
  status: ExportStatus
  /** One plain sentence for the owner, the journal and the API caller. */
  message: string
  stagingDir?: string
}

export interface PeerLink {
  name: string
  state: string
}

export interface RcloneRun {
  code: number
  stderr: string
}

// -- Who runs it ----------------------------------------------------------------

/** Gem exports every night; a host with `deferTo` exports only while its link to that peer is not up. */
export function decideRun(
  deferTo: string | null,
  peers: readonly PeerLink[] | null,
): { run: boolean; reason: string } {
  if (!deferTo) return { run: true, reason: 'this host exports every night' }
  if (peers === null)
    return { run: true, reason: `could not read the link to ${deferTo}, so exporting to be safe` }
  const peer = peers.find((candidate) => candidate.name === deferTo)
  if (peer?.state === 'ok')
    return { run: false, reason: `${deferTo} is linked and does the nightly export` }
  return {
    run: true,
    reason: peer ? `the link to ${deferTo} is ${peer.state}` : `${deferTo} is not a linked host`,
  }
}

/** Whether the config holds a token for the remote (read as text; the token is never printed). */
export async function hasDriveLogin(config: ExportConfig): Promise<boolean> {
  let text: string
  try {
    text = await readFile(config.rcloneConfig, 'utf8')
  } catch {
    return false
  }
  let section = ''
  for (const line of text.split('\n')) {
    const header = /^\s*\[(.+)]\s*$/.exec(line)
    if (header) section = header[1] ?? ''
    else if (section === config.remote && /^\s*token\s*=\s*\S/.test(line)) return true
  }
  return false
}

// -- Reading the store ----------------------------------------------------------

type Row = Record<string, string | number | null>

interface NoteRecord {
  id: string
  kind: string
  title: string
  body: string
  pinned: boolean
  archived: boolean
  scope: string | null
  source: string | null
  createdAt: number
  editedAt: number
  /** The newest change to the note, its items, labels or attachments (tombstones included). */
  changedAt: number
  labels: string[]
  items: { text: string; checked: boolean; hint: string | null }[]
  attachments: { name: string; mime: string; hash: string }[]
}

interface CaptureRecord {
  id: string
  name: string
  mime: string
  hash: string | null
  caption: string
  status: string
  type: string | null
  text: string | null
  createdAt: number
  owner: string | null
  ownerRef: string | null
  routeState: string | null
}

interface Snapshot {
  notes: NoteRecord[]
  captures: CaptureRecord[]
  capturesChangedAt: number
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' ? value : 0)

/** Everything that is exported, read in one pass with the database opened read-only. */
export function readSnapshot(notesDb: string): Snapshot {
  const db = new DatabaseSync(notesDb, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 10000')
    const all = (sql: string): Row[] => db.prepare(sql).all() as unknown as Row[]
    const groupBy = (rows: Row[], group: (row: Row) => string): Map<string, Row[]> => {
      const map = new Map<string, Row[]>()
      for (const row of rows) map.set(group(row), [...(map.get(group(row)) ?? []), row])
      return map
    }
    const items = groupBy(
      all('SELECT * FROM note_items WHERE deleted = 0 ORDER BY note_id, position, id'),
      (row) => str(row.note_id),
    )
    const labels = groupBy(
      all('SELECT * FROM note_labels WHERE deleted = 0 ORDER BY label COLLATE NOCASE, id'),
      (row) => str(row.note_id),
    )
    const attachments = groupBy(
      all('SELECT * FROM attachments WHERE deleted = 0 ORDER BY note_id, position, id'),
      (row) => str(row.note_id),
    )
    const changed = new Map<string, number>()
    for (const table of ['note_items', 'note_labels', 'attachments'])
      for (const row of all(`SELECT note_id, max(updated_at) AS at FROM ${table} GROUP BY note_id`))
        changed.set(str(row.note_id), Math.max(changed.get(str(row.note_id)) ?? 0, num(row.at)))
    const notes = all('SELECT * FROM notes WHERE deleted = 0 ORDER BY created_at, id').map(
      (row): NoteRecord => ({
        id: str(row.id),
        kind: str(row.kind),
        title: str(row.title),
        body: str(row.body),
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        scope: typeof row.scope === 'string' ? row.scope : null,
        source: typeof row.source === 'string' ? row.source : null,
        createdAt: num(row.created_at),
        editedAt: num(row.edited_at),
        changedAt: Math.max(num(row.updated_at), num(row.edited_at), changed.get(str(row.id)) ?? 0),
        labels: (labels.get(str(row.id)) ?? []).map((label) => str(label.label)),
        items: (items.get(str(row.id)) ?? []).map((item) => ({
          text: str(item.text),
          checked: item.checked === 1,
          hint: typeof item.hint === 'string' ? item.hint : null,
        })),
        attachments: (attachments.get(str(row.id)) ?? []).map((file) => ({
          name: str(file.name),
          mime: str(file.mime),
          hash: str(file.hash),
        })),
      }),
    )
    const captureRows = all(
      'SELECT * FROM captures WHERE deleted = 0 ORDER BY created_at DESC, id DESC',
    )
    const capturesChangedAt = num(all('SELECT max(updated_at) AS at FROM captures')[0]?.at)
    return {
      notes,
      capturesChangedAt,
      captures: captureRows.map(
        (row): CaptureRecord => ({
          id: str(row.id),
          name: str(row.name),
          mime: str(row.mime),
          hash: typeof row.hash === 'string' ? row.hash : null,
          caption: str(row.caption),
          status: str(row.status),
          type: typeof row.type === 'string' ? row.type : null,
          text: typeof row.text === 'string' ? row.text : null,
          createdAt: num(row.created_at),
          owner: typeof row.owner === 'string' ? row.owner : null,
          ownerRef: typeof row.owner_ref === 'string' ? row.owner_ref : null,
          routeState: typeof row.route_state === 'string' ? row.route_state : null,
        }),
      ),
    }
  } finally {
    db.close()
  }
}

// -- The markdown ---------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString()
const quote = (value: string): string => JSON.stringify(value)

/** `groceries-list` for "Groceries list!": letters and digits only, lower case, at most 50 characters. */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '')
  return slug || 'untitled'
}

/** `notes/2026/groceries-list-3fa9c1.md`: the year note was created (UTC, so both hosts agree). */
export function notePath(note: Pick<NoteRecord, 'id' | 'title' | 'createdAt'>): string {
  const id6 = note.id.replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'note'
  return `notes/${new Date(note.createdAt).getUTCFullYear()}/${slugOf(note.title)}-${id6}.md`
}

/** The staged name of a stored file, `<hash>.<ext>`, and the blob it comes from. A HEIC picture is staged as its JPEG preview when there is one. */
function stagedFile(
  blobs: string,
  hash: string,
  mime: string,
  name: string,
): { staged: string; source: string } | null {
  if (!hasBlob(blobs, hash)) return null
  if (needsPreview(mime) && hasBlob(blobs, hash, 'preview'))
    return { staged: `${hash}.jpg`, source: blobPath(blobs, hash, 'preview') }
  const named = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase()
  return {
    staged: `${hash}.${extensionForMime(mime) ?? named ?? 'bin'}`,
    source: blobPath(blobs, hash),
  }
}

const linkText = (name: string): string => name.replace(/[[\]]/g, '') || 'file'

export function renderNote(
  note: NoteRecord,
  files: (hash: string, mime: string, name: string) => string | null,
  prefix = '../../',
): string {
  const lines = [
    '---',
    `id: ${quote(note.id)}`,
    `title: ${quote(note.title)}`,
    `kind: ${note.kind}`,
    `pinned: ${note.pinned}`,
    `archived: ${note.archived}`,
    `labels: [${note.labels.map(quote).join(', ')}]`,
    ...(note.scope ? [`scope: ${quote(note.scope)}`] : []),
    ...(note.source ? [`source: ${quote(note.source)}`] : []),
    `created: ${iso(note.createdAt)}`,
    `edited: ${iso(note.editedAt)}`,
    '---',
    '',
    `# ${note.title || 'Untitled'}`,
  ]
  if (note.body.trim()) lines.push('', note.body.replace(/\s+$/, ''))
  if (note.items.length) {
    lines.push('')
    for (const item of note.items)
      lines.push(
        `- [${item.checked ? 'x' : ' '}] ${item.text.replace(/\n/g, ' ')}${item.hint === 'struck' ? ' (crossed out on the photo)' : ''}`,
      )
  }
  if (note.attachments.length) {
    lines.push('', '## Attachments', '')
    for (const file of note.attachments) {
      const staged = files(file.hash, file.mime, file.name)
      const text = linkText(file.name)
      if (!staged) lines.push(`- ${text} (file not on this host yet)`)
      else
        lines.push(
          `- ${file.mime.startsWith('image/') ? '!' : ''}[${text}](${prefix}photos/${staged})`,
        )
    }
  }
  return `${lines.join('\n')}\n`
}

export function renderCaptures(
  captures: readonly CaptureRecord[],
  files: (hash: string, mime: string, name: string) => string | null,
  noteLink: (id: string) => { title: string; path: string } | null,
): string {
  const lines = ['# Captures', '']
  if (captures.length === 0) lines.push('No captures.')
  for (const capture of captures) {
    const at = iso(capture.createdAt).replace('T', ' ').slice(0, 16)
    lines.push(`## ${at} UTC · ${capture.type ?? 'unread'} · ${capture.status}`, '')
    const staged = capture.hash ? files(capture.hash, capture.mime, capture.name) : null
    const text = linkText(capture.name)
    lines.push(
      staged
        ? `- File: ${capture.mime.startsWith('image/') ? '!' : ''}[${text}](photos/${staged})`
        : `- File: ${text} (not kept on this host)`,
    )
    if (capture.caption.trim())
      lines.push(`- Caption: ${capture.caption.trim().replace(/\n/g, ' ')}`)
    const filed = capture.owner === 'notes' && capture.ownerRef ? noteLink(capture.ownerRef) : null
    if (filed) lines.push(`- Filed in: [${linkText(filed.title || 'Untitled')}](${filed.path})`)
    else if (capture.owner)
      lines.push(
        `- Sent to: ${capture.owner}${capture.routeState ? ` (${capture.routeState})` : ''}`,
      )
    if (capture.text?.trim())
      lines.push(
        '',
        ...capture.text
          .trim()
          .split('\n')
          .map((line) => `> ${line}`),
      )
    lines.push('')
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

// -- The staging folder -----------------------------------------------------------

async function writeIfChanged(path: string, content: string, mtime: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const same = await readFile(path, 'utf8').then(
    (existing) => existing === content,
    () => false,
  )
  if (!same) await writeFile(path, content)
  const when = new Date(mtime)
  await utimes(path, when, when)
}

/** Copy (a cheap clone where the filesystem has them) a blob to its staged name, once. */
async function stagePhoto(source: string, target: string, mtime: number): Promise<void> {
  const size = await stat(source).then((info) => info.size)
  const have = await stat(target).then(
    (info) => info.size,
    () => -1,
  )
  if (have !== size) {
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.tmp`
    await copyFile(source, temp, fsConstants.COPYFILE_FICLONE)
    await rename(temp, target)
  }
  const when = new Date(mtime)
  await utimes(target, when, when)
}

/** Remove what a run did not produce (staging only; Drive is never touched). */
async function prune(root: string, keep: ReadonlySet<string>): Promise<void> {
  const walk = async (dir: string): Promise<boolean> => {
    let empty = true
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (await walk(path)) await rmdir(path).catch(() => {})
        else empty = false
      } else if (keep.has(relative(root, path))) empty = false
      else await unlink(path).catch(() => {})
    }
    return empty
  }
  await walk(root)
}

/** Build the staging folder from `notes.db` and the blob store. */
export async function buildStaging(
  notesDb: string,
  blobsDir: string,
  stagingDir: string,
): Promise<StagingSummary> {
  const snapshot = readSnapshot(notesDb)
  const keep = new Set<string>()
  const photoTimes = new Map<string, { source: string; at: number }>()
  let missingFiles = 0

  /** The staged name for a file this host has, noting it for copying; null when the bytes are not here. */
  const files = (hash: string, mime: string, name: string, at = 0): string | null => {
    const found = stagedFile(blobsDir, hash, mime, name)
    if (!found) {
      missingFiles += 1
      return null
    }
    const known = photoTimes.get(found.staged)
    if (!known) photoTimes.set(found.staged, { source: found.source, at })
    else known.at = Math.max(known.at, at)
    return found.staged
  }

  const paths = new Map<string, string>()
  const used = new Set<string>()
  for (const note of snapshot.notes) {
    let path = notePath(note)
    if (used.has(path)) path = path.replace(/\.md$/, `-${note.id}.md`)
    used.add(path)
    paths.set(note.id, path)
  }

  for (const note of snapshot.notes) {
    const path = paths.get(note.id) as string
    const text = renderNote(note, (hash, mime, name) => files(hash, mime, name, note.createdAt))
    await writeIfChanged(join(stagingDir, path), text, note.changedAt)
    keep.add(path)
  }
  const captureText = renderCaptures(
    snapshot.captures,
    (hash, mime, name) => files(hash, mime, name, snapshot.capturesChangedAt),
    (id) => {
      const note = snapshot.notes.find((candidate) => candidate.id === id)
      return note ? { title: note.title, path: paths.get(id) as string } : null
    },
  )
  await writeIfChanged(join(stagingDir, 'captures.md'), captureText, snapshot.capturesChangedAt)
  keep.add('captures.md')
  for (const [staged, { source, at }] of photoTimes) {
    await stagePhoto(source, join(stagingDir, 'photos', staged), at)
    keep.add(`photos/${staged}`)
  }
  await prune(stagingDir, keep)
  return {
    notes: snapshot.notes.length,
    photos: photoTimes.size,
    captures: snapshot.captures.length,
    missingFiles,
  }
}

// -- One run ----------------------------------------------------------------------

export interface ExportDeps {
  config: ExportConfig
  notesDb: string
  blobsDir: string
  /** The sync state of each linked host; null when it cannot be read. */
  peers: () => PeerLink[] | null
  /** Runs rclone with these arguments (injected so tests never start it). */
  rclone: (args: string[]) => Promise<RcloneRun>
  /** Skip the run-or-skip rule (a hand run). */
  force?: boolean
}

/** Build the staging folder, then copy it to Drive, or say plainly why not. */
export async function runExport(deps: ExportDeps): Promise<ExportResult> {
  const { config } = deps
  const decision = decideRun(config.deferTo, deps.peers())
  if (!decision.run && !deps.force)
    return { status: 'skipped', message: `Not exporting tonight: ${decision.reason}.` }
  const summary = await buildStaging(deps.notesDb, deps.blobsDir, config.stagingDir)
  const counts = `${summary.notes} notes, ${summary.photos} photos, ${summary.captures} captures`
  const base = { ...summary, stagingDir: config.stagingDir }
  if (!(await hasDriveLogin(config)))
    return {
      status: 'no-login',
      ...base,
      message: `Built the staging folder (${counts}) at ${config.stagingDir}, but nothing was sent to Drive: this host has no Drive login for the export yet. Run scripts/authorize-notes-drive.sh in a private terminal on this host, then run the export again.`,
    }
  const result = await deps.rclone([
    'copy',
    '--update',
    '--config',
    config.rcloneConfig,
    config.stagingDir,
    `${config.remote}:${config.folder}`,
  ])
  if (result.code !== 0)
    return {
      status: 'failed',
      ...base,
      message: `The Drive copy failed (rclone exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ') || 'no message'}`,
    }
  return {
    status: 'uploaded',
    ...base,
    message: `Copied ${counts} to ${config.folder} on Drive (${decision.reason}).`,
  }
}

// -- Wiring -----------------------------------------------------------------------

/** rclone as a child process, with no RCLONE_* settings from the environment so only the dedicated config applies. */
export function rcloneRunner(path: string): (args: string[]) => Promise<RcloneRun> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('RCLONE_')),
  )
  return (args) =>
    new Promise((resolve) => {
      execFile(path, args, { env, maxBuffer: 16 << 20 }, (error, _stdout, stderr) => {
        if (!error) return resolve({ code: 0, stderr })
        const code = (error as NodeJS.ErrnoException).code
        resolve({
          code: typeof code === 'number' ? code : 1,
          stderr: typeof code === 'number' ? stderr : error.message,
        })
      })
    })
}

const STATUS_CODES: Record<ExportStatus, number> = {
  uploaded: 200,
  skipped: 200,
  'no-login': 503,
  failed: 502,
}

/**
 * `POST /api/export/notes` (`{force?: true}`): the nightly run, started by aico-jobs (job notes-export, whose
 * Status row shows the answer). Answers 200 for a copy or a skip, 503 when this host has no Drive login yet, 502
 * when rclone failed or the export stopped; `message` and `detail` say why.
 */
export function registerExportRoutes(
  router: Router,
  config: { export: ExportConfig; dataDir: string },
  loop: Pick<SyncLoop, 'status'>,
): void {
  let running = false
  const rclone = rcloneRunner(config.export.rclonePath)
  router.on('POST', '/api/export/notes', async (ctx) => {
    if (running) {
      sendJson(ctx.res, 409, { detail: 'An export is already running' })
      return RAW
    }
    const body = (await ctx.body()) as { force?: unknown } | undefined
    running = true
    try {
      const result = await runExport({
        config: config.export,
        notesDb: join(config.dataDir, 'notes.db'),
        blobsDir: join(config.dataDir, 'blobs'),
        peers: () => loop.status().map(({ name, state }) => ({ name, state })),
        rclone,
        force: body?.force === true,
      }).catch((error: unknown): ExportResult => {
        console.error('[aico-web] notes export stopped:', error)
        return { status: 'failed', message: `The export stopped: ${(error as Error).message}` }
      })
      console.log(`[aico-web] notes export: ${result.status}: ${result.message}`)
      const status = STATUS_CODES[result.status]
      sendJson(ctx.res, status, status === 200 ? result : { ...result, detail: result.message })
      return RAW
    } finally {
      running = false
    }
  })
}
