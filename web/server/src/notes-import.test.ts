import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blobPath } from './blobs'
import {
  importAll,
  keepReport,
  mapSummitflow,
  planKeep,
  readKeepFolder,
  type SummitflowRow,
  verifyKeep,
} from './notes-import'
import { type NotesCliIo, runNotesCommand } from './notes-import-cli'
import { dump, Link, openHost, pull } from './sync/harness'

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value')
  return value
}

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex')
const usec = (iso: string) => String(Date.parse(iso) * 1000)

let top: string
let keep: string
let blobs: string
beforeEach(() => {
  top = mkdtempSync(join(tmpdir(), 'aico-import-'))
  keep = join(top, 'Takeout', 'Keep')
  blobs = join(top, 'blobs')
  mkdirSync(keep, { recursive: true })
  const note = (file: string, json: Record<string, unknown>) =>
    writeFileSync(
      join(keep, file),
      JSON.stringify({
        color: 'DEFAULT',
        isTrashed: false,
        isPinned: false,
        isArchived: false,
        ...json,
      }),
    )
  note('Pasta recipe.json', {
    title: 'Pasta recipe',
    textContent: 'Boil water.\nSalt it.',
    labels: [{ name: 'Food' }, { name: 'Dinner' }],
    isPinned: true,
    color: 'YELLOW',
    sharees: [{ email: 'x@example.com' }],
    annotations: [
      { title: 'Source', url: 'https://example.com/pasta', source: 'WEBLINK', description: '' },
    ],
    createdTimestampUsec: usec('2025-01-01T10:00:00Z'),
    userEditedTimestampUsec: usec('2025-02-01T10:00:00Z'),
  })
  note('Car maintenance.json', {
    title: 'Car maintenance',
    listContent: [
      { text: 'Oil change', isChecked: true, textHtml: 'Oil change' },
      { text: 'Tires', isChecked: false },
      { text: '', isChecked: false },
    ],
    createdTimestampUsec: usec('2025-01-02T10:00:00Z'),
    userEditedTimestampUsec: usec('2025-01-03T10:00:00Z'),
  })
  note('Old.json', {
    title: 'Old stuff',
    textContent: 'archived',
    isArchived: true,
    createdTimestampUsec: usec('2024-01-01T10:00:00Z'),
    userEditedTimestampUsec: usec('2024-01-01T10:00:00Z'),
  })
  note('Gone.json', {
    title: 'Thrown away',
    textContent: 'bin',
    isTrashed: true,
    createdTimestampUsec: usec('2024-02-01T10:00:00Z'),
    userEditedTimestampUsec: usec('2024-02-01T10:00:00Z'),
  })
  // Takeout says .jpeg in the JSON and writes .jpg on disk.
  note('Photo note.json', {
    title: 'Photo note',
    textContent: 'see photo',
    attachments: [{ filePath: 'abc123.jpeg', mimetype: 'image/jpeg' }],
    createdTimestampUsec: usec('2025-03-01T10:00:00Z'),
    userEditedTimestampUsec: usec('2025-03-01T10:00:00Z'),
  })
  writeFileSync(join(keep, 'abc123.jpg'), PNG)
  writeFileSync(join(keep, 'Photo note.html'), '<html></html>')
})
afterEach(() => rmSync(top, { recursive: true, force: true }))

const store = () => openHost('ws')
const plan = (dir = keep, includeTrashed = false) => planKeep(readKeepFolder(dir), includeTrashed)
const notesOf = (e: ReturnType<typeof plan>) => e.entries.map((x) => x.note)

describe('reading a Keep folder', () => {
  it('maps notes, lists, labels, links, flags and times', () => {
    const p = plan()
    expect(p.entries.map((e) => e.note.title).sort()).toEqual([
      'Car maintenance',
      'Old stuff',
      'Pasta recipe',
      'Photo note',
    ])
    expect(p.skipped.map((e) => e.file)).toEqual(['Gone.json'])
    const pasta = must(notesOf(p).find((n) => n.title === 'Pasta recipe'))
    expect(pasta).toMatchObject({
      kind: 'note',
      pinned: true,
      labels: ['Food', 'Dinner'],
      source: `keep:${usec('2025-01-01T10:00:00Z')}`,
    })
    expect(pasta.body).toBe('Boil water.\nSalt it.\n\nLinks:\n- Source: https://example.com/pasta')
    expect(pasta.createdAt).toBe(Date.parse('2025-01-01T10:00:00Z'))
    expect(pasta.editedAt).toBe(Date.parse('2025-02-01T10:00:00Z'))
    const car = must(notesOf(p).find((n) => n.title === 'Car maintenance'))
    expect(car.kind).toBe('list')
    expect(car.items).toEqual([
      { text: 'Oil change', checked: true },
      { text: 'Tires', checked: false },
    ])
    expect(must(notesOf(p).find((n) => n.title === 'Old stuff')).archived).toBe(true)
    expect(p.drops).toEqual({
      'colour dropped': 1,
      'sharees dropped': 1,
      'empty list items dropped': 1,
    })
  })

  it('finds an attachment by name stem when the JSON says .jpeg and the file is .jpg', () => {
    const entry = must(plan().entries.find((e) => e.file === 'Photo note.json'))
    expect(entry.attachments[0]).toMatchObject({ filePath: 'abc123.jpeg', byStem: true })
    expect(entry.note.files).toHaveLength(1)
    expect(entry.note.files[0].name).toBe('abc123.jpg')
  })

  it('opens the extracted folder, not only Takeout/Keep, and skips unreadable JSON by name', () => {
    writeFileSync(join(keep, 'broken.json'), '{not json')
    const folder = readKeepFolder(top)
    expect(folder.dir).toBe(keep)
    expect(plan(top).unreadable.map((e) => e.file)).toEqual(['broken.json'])
  })

  it('brings trashed notes in as archived and labelled when asked', () => {
    const gone = must(notesOf(plan(keep, true)).find((n) => n.title === 'Thrown away'))
    expect(gone).toMatchObject({ archived: true, labels: ['trashed'] })
  })
})

describe('importing Keep', () => {
  it('a dry run writes nothing', async () => {
    const host = store()
    const p = plan()
    const { counts } = await importAll(host.notes.notes, blobs, notesOf(p), true)
    expect(counts).toMatchObject({ created: 4, updated: 0, unchanged: 0 })
    expect(host.notes.notes.list({ archived: 'all' }).total).toBe(0)
    expect(existsSync(blobs)).toBe(false)
  })

  it('creates notes with their times, items, labels and attachment, then a rerun changes nothing', async () => {
    const host = store()
    const first = await importAll(host.notes.notes, blobs, notesOf(plan()), false)
    expect(first.counts).toMatchObject({ created: 4, updated: 0, unchanged: 0 })
    const store_ = host.notes.notes
    const pasta = must(store_.findBySource(`keep:${usec('2025-01-01T10:00:00Z')}`))
    expect(pasta).toMatchObject({
      pinned: 1,
      created_at: Date.parse('2025-01-01T10:00:00Z'),
      edited_at: Date.parse('2025-02-01T10:00:00Z'),
      origin: 'ws',
    })
    expect(pasta.seq).toBeGreaterThan(0)
    expect(store_.labelsOf(pasta.id).sort()).toEqual(['Dinner', 'Food'])
    const car = must(store_.findBySource(`keep:${usec('2025-01-02T10:00:00Z')}`))
    expect(store_.items(car.id).map((i) => [i.text, i.checked, i.position])).toEqual([
      ['Oil change', 1, 1],
      ['Tires', 0, 2],
    ])
    const photo = must(store_.findBySource(`keep:${usec('2025-03-01T10:00:00Z')}`))
    const [file] = store_.attachments(photo.id)
    expect(file).toMatchObject({
      name: 'abc123.jpg',
      mime: 'image/jpeg',
      size: PNG.length,
      capture_id: null,
    })
    expect(existsSync(blobPath(blobs, file.hash))).toBe(true)

    const again = await importAll(store_, blobs, notesOf(plan()), false)
    expect(again.counts).toMatchObject({ created: 0, updated: 0, unchanged: 4 })
    expect(store_.list({ archived: 'all' }).total).toBe(4)
  })

  it('a rerun after a change in Keep updates the note in place', async () => {
    const host = store()
    await importAll(host.notes.notes, blobs, notesOf(plan()), false)
    const file = join(keep, 'Car maintenance.json')
    writeFileSync(
      file,
      JSON.stringify({
        title: 'Car maintenance',
        listContent: [
          { text: 'Oil change', isChecked: true },
          { text: 'Brakes', isChecked: false },
          { text: 'Wipers' },
        ],
        createdTimestampUsec: usec('2025-01-02T10:00:00Z'),
        userEditedTimestampUsec: usec('2025-04-03T10:00:00Z'),
      }),
    )
    const again = await importAll(host.notes.notes, blobs, notesOf(plan()), false)
    expect(again.counts).toMatchObject({ created: 0, updated: 1, unchanged: 3 })
    const car = must(host.notes.notes.findBySource(`keep:${usec('2025-01-02T10:00:00Z')}`))
    expect(host.notes.notes.items(car.id).map((i) => i.text)).toEqual([
      'Oil change',
      'Brakes',
      'Wipers',
    ])
    expect(host.notes.notes.list({ archived: 'all' }).total).toBe(4)
  })

  it('leaves a note the owner deleted in Aico deleted', async () => {
    const host = store()
    await importAll(host.notes.notes, blobs, notesOf(plan()), false)
    const car = must(host.notes.notes.findBySource(`keep:${usec('2025-01-02T10:00:00Z')}`))
    host.notes.notes.remove(car.id)
    const again = await importAll(host.notes.notes, blobs, notesOf(plan()), false)
    expect(again.counts).toMatchObject({ created: 0, deletedInAico: 1, unchanged: 3 })
  })

  it('imported rows replicate to the other host', async () => {
    const a = store()
    const b = openHost('gem')
    await importAll(a.notes.notes, blobs, notesOf(plan()), false)
    await pull(b, a, new Link())
    expect(dump(b.handles.notes)).toEqual(dump(a.handles.notes))
    expect(b.notes.notes.list({ archived: 'all' }).total).toBe(4)
  })
})

describe('the Keep report', () => {
  it('puts recipes and car notes first, then the rest, skips and drops', async () => {
    writeFileSync(
      join(keep, 'Odd.json'),
      JSON.stringify({
        title: 'Odd',
        textContent: 'ingredients: flour',
        createdTimestampUsec: usec('2025-05-01T10:00:00Z'),
        userEditedTimestampUsec: usec('2025-05-01T10:00:00Z'),
      }),
    )
    const p = plan()
    const text = keepReport(p, {
      dryRun: true,
      counts: { total: 5, created: 5, updated: 0, unchanged: 0, deletedInAico: 0 },
      outcomes: new Map(),
    })
    const at = (s: string) => text.indexOf(s)
    expect(at('### Recipes')).toBeGreaterThan(0)
    expect(at('Pasta recipe')).toBeLessThan(at('## Other notes'))
    expect(at('Car maintenance')).toBeLessThan(at('## Other notes'))
    expect(at('Photo note')).toBeGreaterThan(at('## Other notes'))
    expect(text).toContain('Skipped: in the Keep trash (1)')
    expect(text).toContain('colour dropped: 1')
    expect(text).toContain('Nothing was written')
    expect(text).toContain('Worth a look: recipe or car words in the text only')
    expect(text).toContain('- Odd: recipe')
    expect(text).not.toContain('| Would')
  })
})

describe('verify-keep', () => {
  it('is clean after an import, and lists every note before one', async () => {
    const host = store()
    const folder = readKeepFolder(keep)
    expect(verifyKeep(host.notes.notes, blobs, folder).problems.map((x) => x.kind)).toContain(
      'note not in Aico',
    )
    await importAll(host.notes.notes, blobs, notesOf(plan()), false)
    const result = verifyKeep(host.notes.notes, blobs, readKeepFolder(keep))
    expect(result.problems).toEqual([])
    expect(result.report).toContain('complete, nothing unmatched')
  })

  it('catches an attachment file that is referenced but missing, and a file nothing names', async () => {
    const host = store()
    await importAll(host.notes.notes, blobs, notesOf(plan()), false)
    unlinkSync(join(keep, 'abc123.jpg'))
    writeFileSync(join(keep, 'stray.png'), PNG)
    const kinds = verifyKeep(host.notes.notes, blobs, readKeepFolder(keep)).problems.map(
      (x) => x.kind,
    )
    expect(kinds).toContain('attachment missing from the folder')
    expect(kinds).toContain('extra file in the folder, no note names it')
  })

  it('catches a stored attachment whose blob is gone or does not re-hash', async () => {
    const host = store()
    await importAll(host.notes.notes, blobs, notesOf(plan()), false)
    const photo = must(host.notes.notes.findBySource(`keep:${usec('2025-03-01T10:00:00Z')}`))
    const [attachment] = host.notes.notes.attachments(photo.id)
    writeFileSync(blobPath(blobs, attachment.hash), 'changed')
    expect(
      verifyKeep(host.notes.notes, blobs, readKeepFolder(keep)).problems.map((x) => x.kind),
    ).toContain('attachment blob does not re-hash to its name')
    unlinkSync(blobPath(blobs, attachment.hash))
    expect(
      verifyKeep(host.notes.notes, blobs, readKeepFolder(keep)).problems.map((x) => x.kind),
    ).toContain('attachment blob missing')
  })

  it('catches an attachment on the note that the export does not have', async () => {
    const host = store()
    await importAll(host.notes.notes, blobs, notesOf(plan()), false)
    const photo = must(host.notes.notes.findBySource(`keep:${usec('2025-03-01T10:00:00Z')}`))
    host.notes.notes.attachFile(photo.id, {
      key: 'file-extra',
      hash: 'b'.repeat(64),
      name: 'extra.png',
      mime: 'image/png',
      size: 1,
    })
    expect(
      verifyKeep(host.notes.notes, blobs, readKeepFolder(keep)).problems.map((x) => x.kind),
    ).toContain('extra attachment on the note')
  })
})

const row = (fields: Partial<SummitflowRow>): SummitflowRow => ({
  id: 'note-1',
  project_scope: 'summitflow',
  type: 'note',
  title: 'First',
  content: 'text',
  tags: ['ai'],
  pinned: false,
  metadata: {},
  created_at: '2026-03-24T20:30:01.895732+00:00',
  updated_at: '2026-03-25T20:30:01.895732+00:00',
  ...fields,
})

describe('importing SummitFlow notes', () => {
  it('maps type, scope, tags, pinned and times', () => {
    const { notes, drops } = mapSummitflow([
      row({}),
      row({
        id: 'note-2',
        type: 'prompt',
        pinned: true,
        project_scope: null,
        tags: null,
        metadata: { a: 1 },
      }),
    ])
    expect(notes[0]).toMatchObject({
      source: 'summitflow:note-1',
      kind: 'note',
      scope: 'summitflow',
      labels: ['ai', 'project:summitflow'],
      createdAt: Date.parse('2026-03-24T20:30:01.895Z'),
    })
    expect(notes[1]).toMatchObject({ kind: 'prompt', pinned: true, scope: null, labels: [] })
    expect(drops).toEqual({ 'metadata dropped': 1 })
  })

  it('imports, then the rerun updates instead of duplicating', async () => {
    const host = store()
    const first = mapSummitflow([
      row({}),
      row({ id: 'note-2', type: 'prompt', title: 'Second' }),
    ]).notes
    expect((await importAll(host.notes.notes, blobs, first, false)).counts).toMatchObject({
      created: 2,
      updated: 0,
    })
    const second = mapSummitflow([
      row({ content: 'changed', tags: ['ai', 'x'] }),
      row({ id: 'note-2', type: 'prompt', title: 'Second' }),
    ]).notes
    expect((await importAll(host.notes.notes, blobs, second, false)).counts).toMatchObject({
      created: 0,
      updated: 1,
      unchanged: 1,
    })
    const note = must(host.notes.notes.findBySource('summitflow:note-1'))
    expect(note.body).toBe('changed')
    expect(note.edited_at).toBe(Date.parse('2026-03-25T20:30:01.895Z'))
    expect(host.notes.notes.labelsOf(note.id).sort()).toEqual(['ai', 'project:summitflow', 'x'])
    expect(host.notes.notes.list({ archived: 'all' }).total).toBe(2)
    expect(must(host.notes.notes.findBySource('summitflow:note-2')).kind).toBe('prompt')
  })
})

describe('tnotes', () => {
  function run(host: ReturnType<typeof store>, argv: string[], rows: SummitflowRow[] = []) {
    const io = { out: '', err: '' }
    const cliIo: NotesCliIo = {
      out: (t) => (io.out += t),
      err: (t) => (io.err += t),
      env: {},
      repoRoot: top,
    }
    return runNotesCommand(
      cliIo,
      { notes: host.notes, blobsDir: blobs, summitflowRows: () => rows },
      argv,
    ).then((code) => ({ code, ...io }))
  }

  it('import-summitflow --dry-run reports counts and writes nothing; the real run then the rerun', async () => {
    const host = store()
    const rows = [row({}), row({ id: 'note-2', title: 'Second' })]
    let result = await run(host, ['import-summitflow', '--dry-run'], rows)
    expect(result.out).toContain('2 read, 2 to create')
    expect(host.notes.notes.list({ archived: 'all' }).total).toBe(0)
    result = await run(host, ['import-summitflow'], rows)
    expect(result.out).toContain('2 created')
    result = await run(host, ['import-summitflow'], rows)
    expect(result.out).toContain('0 created, 0 updated, 2 unchanged')
  })

  it('import-keep and verify-keep: report, exit codes and usage errors', async () => {
    const host = store()
    expect((await run(host, ['verify-keep', keep])).code).toBe(1)
    const dry = await run(host, ['import-keep', keep, '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('Google Keep import dry run')
    expect(host.notes.notes.list({ archived: 'all' }).total).toBe(0)
    expect((await run(host, ['import-keep', keep])).code).toBe(0)
    const verified = await run(host, ['verify-keep', keep])
    expect(verified.code).toBe(0)
    expect(verified.out).toContain('complete, nothing unmatched')
    expect((await run(host, ['import-keep'])).code).toBe(2)
    expect((await run(host, ['nope'])).code).toBe(2)
    expect((await run(host, ['import-keep', join(top, 'blobs')])).code).toBe(1)
  })

  it('never writes into the Keep folder', async () => {
    const before = readdirSync(keep).sort()
    await run(store(), ['import-keep', keep])
    expect(readdirSync(keep).sort()).toEqual(before)
  })
})
