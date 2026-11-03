import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { putOriginal, putVariant } from './blobs'
import { NotesStore } from './notes-db'
import {
  buildStaging,
  decideRun,
  type ExportConfig,
  hasDriveLogin,
  notePath,
  runExport,
  slugOf,
} from './notes-export'

const WALL = Date.UTC(2026, 10, 2, 12, 0, 0)

/** An rclone stand-in that records its arguments and answers with `answer`. */
function fakeRclone(answer = { code: 0, stderr: '' }) {
  const calls: string[][] = []
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args)
      return answer
    },
  }
}

describe('notes export', () => {
  let dir: string
  let store: NotesStore
  let blobs: string
  let config: ExportConfig
  let wall: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-export-'))
    blobs = join(dir, 'blobs')
    wall = WALL
    store = new NotesStore(join(dir, 'notes.db'), { hostName: 'here', now: () => wall })
    config = {
      stagingDir: join(dir, 'export'),
      rcloneConfig: join(dir, 'drive.conf'),
      rclonePath: 'rclone',
      remote: 'aico-notes-drive',
      folder: 'SummitFlow-Notes',
      deferTo: null,
    }
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const tree = (root: string, prefix = ''): string[] =>
    readdirSync(root, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? tree(join(root, entry.name), `${prefix}${entry.name}/`)
          : [`${prefix}${entry.name}`],
      )
      .sort()

  /** A capture with a stored file, as the upload route leaves it. */
  async function capture(n: number, bytes: string, name = 'receipt.jpg', mime = 'image/jpeg') {
    const hash = await putOriginal(blobs, Buffer.from(bytes))
    const row = store.insertCapture({
      clientId: `client-${n}0000`,
      kind: 'image',
      name,
      mime,
      size: bytes.length,
      hash,
      caption: n === 1 ? 'odometer at the garage' : '',
    }).capture
    return { row, hash }
  }

  it('builds notes/<year>/<slug>-<id6>.md with front matter, items, labels and attachment links', async () => {
    const { row, hash } = await capture(1, 'jpeg-bytes')
    const note = store.notes.create({
      kind: 'list',
      title: 'Groceries: week 45!',
      body: 'Before Friday.',
      pinned: true,
      labels: ['home', 'Food'],
      items: [
        { text: 'milk' },
        { text: 'eggs', checked: true },
        { text: 'sea salt', hint: 'struck' },
      ],
    })
    store.notes.attach(note.id, {
      captureId: row.id,
      hash,
      name: 'list [1].jpg',
      mime: 'image/jpeg',
      size: 10,
    })

    const summary = await buildStaging(join(dir, 'notes.db'), blobs, config.stagingDir)

    const path = `notes/2026/groceries-week-45-${note.id.slice(0, 6)}.md`
    expect(tree(config.stagingDir)).toEqual(['captures.md', `photos/${hash}.jpg`, path].sort())
    expect(summary).toEqual({ notes: 1, photos: 1, captures: 1, missingFiles: 0 })
    expect(readFileSync(join(config.stagingDir, path), 'utf8')).toBe(
      [
        '---',
        `id: "${note.id}"`,
        'title: "Groceries: week 45!"',
        'kind: list',
        'pinned: true',
        'archived: false',
        'labels: ["Food", "home"]',
        'created: 2026-11-02T12:00:00.000Z',
        'edited: 2026-11-02T12:00:00.000Z',
        '---',
        '',
        '# Groceries: week 45!',
        '',
        'Before Friday.',
        '',
        '- [ ] milk',
        '- [x] eggs',
        '- [ ] sea salt (crossed out on the photo)',
        '',
        '## Attachments',
        '',
        `- ![list 1.jpg](../../photos/${hash}.jpg)`,
        '',
      ].join('\n'),
    )
    expect(readFileSync(join(config.stagingDir, 'photos', `${hash}.jpg`), 'utf8')).toBe(
      'jpeg-bytes',
    )
  })

  it('lists captures newest first with their caption, reading and the note they were filed in', async () => {
    const first = await capture(1, 'one')
    const second = await capture(2, 'two', 'page.png', 'image/png')
    wall += 1000
    const note = store.notes.create({ title: 'Garage' })
    const raw = new DatabaseSync(join(dir, 'notes.db'))
    raw
      .prepare("UPDATE captures SET owner = 'notes', owner_ref = ?, status = 'filed' WHERE id = ?")
      .run(note.id, first.row.id)
    raw.close()
    store.notes.attach(note.id, {
      captureId: first.row.id,
      hash: first.hash,
      name: 'receipt.jpg',
      mime: 'image/jpeg',
      size: 3,
    })

    await buildStaging(join(dir, 'notes.db'), blobs, config.stagingDir)
    const text = readFileSync(join(config.stagingDir, 'captures.md'), 'utf8')
    expect(text.startsWith('# Captures\n')).toBe(true)
    expect(text).toContain(`- File: ![receipt.jpg](photos/${first.hash}.jpg)`)
    expect(text).toContain('- Caption: odometer at the garage')
    expect(text).toContain(`- File: ![page.png](photos/${second.hash}.png)`)
    expect(text).toContain(`- Filed in: [Garage](notes/2026/garage-${note.id.slice(0, 6)}.md)`)
    expect(text).toContain('2026-11-02 12:00 UTC')
  })

  it('stages a HEIC photo as its JPEG preview, and names a file this host does not have yet', async () => {
    const heic = await putOriginal(blobs, Buffer.from('heic-bytes'))
    await putVariant(blobs, heic, 'preview', Buffer.from('preview-bytes'))
    const note = store.notes.create({ title: 'Trip' })
    store.notes.attach(note.id, {
      captureId: 'cap000000001',
      hash: heic,
      name: 'IMG.heic',
      mime: 'image/heic',
      size: 9,
    })
    store.notes.attach(note.id, {
      captureId: 'cap000000002',
      hash: 'e'.repeat(64),
      name: 'late.pdf',
      mime: 'application/pdf',
      size: 9,
    })

    const summary = await buildStaging(join(dir, 'notes.db'), blobs, config.stagingDir)
    expect(summary).toMatchObject({ photos: 1, missingFiles: 1 })
    expect(readFileSync(join(config.stagingDir, 'photos', `${heic}.jpg`), 'utf8')).toBe(
      'preview-bytes',
    )
    const text = readFileSync(
      join(config.stagingDir, notePath({ id: note.id, title: 'Trip', createdAt: WALL })),
      'utf8',
    )
    expect(text).toContain(`![IMG.heic](../../photos/${heic}.jpg)`)
    expect(text).toContain('- late.pdf (file not on this host yet)')
  })

  it('leaves deleted notes out, drops staged files that no longer belong, and is stable on a rerun', async () => {
    const keep = store.notes.create({ title: 'Keep' })
    const gone = store.notes.create({ title: 'Gone' })
    await buildStaging(join(dir, 'notes.db'), blobs, config.stagingDir)
    writeFileSync(join(config.stagingDir, 'stray.txt'), 'old')
    store.notes.remove(gone.id)
    wall += 5000
    store.notes.update(keep.id, { body: 'edited' })

    await buildStaging(join(dir, 'notes.db'), blobs, config.stagingDir)
    expect(tree(config.stagingDir)).toEqual([
      'captures.md',
      `notes/2026/keep-${keep.id.slice(0, 6)}.md`,
    ])
    const file = join(config.stagingDir, `notes/2026/keep-${keep.id.slice(0, 6)}.md`)
    // The file's time is its newest change, not the time of the run.
    expect(statSync(file).mtimeMs).toBe(wall)
    const before = readFileSync(file, 'utf8')
    await buildStaging(join(dir, 'notes.db'), blobs, config.stagingDir)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(statSync(file).mtimeMs).toBe(wall)
  })

  it('slugs and paths', () => {
    expect(slugOf('  Crème brûlée — 2x!  ')).toBe('crème-brûlée-2x')
    expect(slugOf('')).toBe('untitled')
    expect(slugOf('x'.repeat(80))).toHaveLength(50)
    expect(
      notePath({ id: 'ab12cd34ef56', title: 'Hi', createdAt: Date.UTC(2025, 11, 31, 23, 59) }),
    ).toBe('notes/2025/hi-ab12cd.md')
  })

  describe('who runs it', () => {
    it('exports every night where nothing is deferred', () => {
      expect(decideRun(null, [])).toMatchObject({ run: true })
    })
    it('skips while the link to the deferred peer is up', () => {
      const decision = decideRun('gem', [{ name: 'gem', state: 'ok' }])
      expect(decision).toEqual({ run: false, reason: 'gem is linked and does the nightly export' })
    })
    it.each(['down', 'error', 'paused', 'waiting'])('runs when the link is %s', (state) => {
      expect(decideRun('gem', [{ name: 'gem', state }])).toEqual({
        run: true,
        reason: `the link to gem is ${state}`,
      })
    })
    it('runs when the peer is unknown or the link state cannot be read', () => {
      expect(decideRun('gem', [])).toMatchObject({ run: true })
      expect(decideRun('gem', null)).toMatchObject({ run: true })
    })
  })

  describe('the Drive copy', () => {
    const deps = (
      rclone: (args: string[]) => Promise<{ code: number; stderr: string }>,
      extra = {},
    ) => ({
      config,
      notesDb: join(dir, 'notes.db'),
      blobsDir: blobs,
      peers: () => [] as { name: string; state: string }[],
      rclone,
      ...extra,
    })
    const login = () =>
      writeFileSync(
        config.rcloneConfig,
        '[aico-notes-drive]\ntype = drive\nscope = drive.file\ntoken = {"x":1}\n',
      )

    it('with no Drive login builds the staging folder, says so plainly and runs nothing', async () => {
      store.notes.create({ title: 'Hello' })
      const rclone = fakeRclone()
      const result = await runExport(deps(rclone.run))
      expect(result.status).toBe('no-login')
      expect(result.message).toContain('no Drive login')
      expect(result.message).toContain('scripts/authorize-notes-drive.sh')
      expect(result.notes).toBe(1)
      expect(tree(config.stagingDir)).toHaveLength(2)
      expect(rclone.calls).toEqual([])
    })

    it('copies with --update into the folder, never sync or delete, and uses only the dedicated config', async () => {
      store.notes.create({ title: 'Hello' })
      login()
      const rclone = fakeRclone()
      const result = await runExport(deps(rclone.run))
      expect(result.status).toBe('uploaded')
      expect(rclone.calls).toEqual([
        [
          'copy',
          '--update',
          '--config',
          config.rcloneConfig,
          config.stagingDir,
          'aico-notes-drive:SummitFlow-Notes',
        ],
      ])
    })

    it('reports an rclone failure with its message and does not retry', async () => {
      login()
      const rclone = fakeRclone({ code: 7, stderr: 'line one\nCouldn’t reach Drive' })
      const result = await runExport(deps(rclone.run))
      expect(result).toMatchObject({ status: 'failed' })
      expect(result.message).toContain('exit 7')
      expect(result.message).toContain('Couldn’t reach Drive')
      expect(rclone.calls).toHaveLength(1)
    })

    it('skips (and builds nothing) while the deferred peer is linked, unless forced', async () => {
      config.deferTo = 'gem'
      login()
      const rclone = fakeRclone()
      const linked = { peers: () => [{ name: 'gem', state: 'ok' }] }
      const skipped = await runExport(deps(rclone.run, linked))
      expect(skipped.status).toBe('skipped')
      expect(rclone.calls).toEqual([])
      expect(() => readdirSync(config.stagingDir)).toThrow()
      expect((await runExport(deps(rclone.run, { ...linked, force: true }))).status).toBe(
        'uploaded',
      )
      expect(rclone.calls).toHaveLength(1)
    })

    it('runs when the link to the deferred peer is down', async () => {
      config.deferTo = 'gem'
      login()
      const result = await runExport(
        deps(async () => ({ code: 0, stderr: '' }), {
          peers: () => [{ name: 'gem', state: 'down' }],
        }),
      )
      expect(result).toMatchObject({ status: 'uploaded' })
      expect(result.message).toContain('the link to gem is down')
    })

    it('finds a login only as a token under the remote’s own section', async () => {
      expect(await hasDriveLogin(config)).toBe(false) // no file
      writeFileSync(config.rcloneConfig, '[aico-notes-drive]\ntype = drive\nclient_id = abc\n')
      expect(await hasDriveLogin(config)).toBe(false) // consent not finished
      writeFileSync(
        config.rcloneConfig,
        '[other]\ntoken = {"x":1}\n[aico-notes-drive]\ntype = drive\n',
      )
      expect(await hasDriveLogin(config)).toBe(false) // someone else's token
      login()
      expect(await hasDriveLogin(config)).toBe(true)
    })
  })
})
