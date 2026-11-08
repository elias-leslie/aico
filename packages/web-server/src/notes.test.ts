import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildTable } from '@aico/notes/capture-types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CaptureRouter } from './capture-router'
import { registerNoteRoutes } from './notes'
import { NotesStore, SCHEMA_VERSION } from './notes-db'
import { NotesOwner } from './owners/notes'
import { serveRoutes } from './testing'
import { QUIET } from './testing-notices'

const HASH = 'b'.repeat(64)
const MINUTE = 60_000

describe('notes', () => {
  let dir: string
  let wall: number
  let store: NotesStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-notes-data-'))
    wall = 1_700_000_000_000
    store = open()
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const open = (options: { path?: string; fts?: boolean } = {}) =>
    new NotesStore(options.path ?? ':memory:', {
      hostName: 'here',
      now: () => wall,
      revisionWindowMs: 5 * MINUTE,
      fts: options.fts,
    })

  /** A read capture the way the extract worker leaves it. */
  function readCapture(n: number, type: string, extract: unknown, text = 'text') {
    const row = store.insertCapture({
      clientId: `client-${n}0000`,
      kind: 'image',
      name: 'list.jpg',
      mime: 'image/jpeg',
      size: 10,
      hash: HASH,
    }).capture
    store.claimForExtraction()
    return store.finishExtraction(
      row.id,
      { type, text, json: JSON.stringify(extract), route: 'agy' },
      router().plan(type),
    ) as NonNullable<ReturnType<NotesStore['finishExtraction']>>
  }

  const router = () =>
    new CaptureRouter({
      store,
      blobsDir: join(dir, 'blobs'),
      table: buildTable(null),
      adapters: new Map([['notes', new NotesOwner(store)]]),
      notices: QUIET,
      log: () => {},
    })

  it('migrates an existing schema 3 file, keeping its captures', () => {
    const path = join(dir, 'notes.db')
    const first = open({ path })
    first.insertCapture({
      clientId: 'client-00001',
      kind: 'image',
      name: 'a.jpg',
      mime: 'image/jpeg',
      size: 1,
      hash: HASH,
    })
    first.close()
    const raw = new DatabaseSync(path)
    raw.exec(
      `DROP TABLE notes_fts; DROP TABLE notes; DROP TABLE note_items; DROP TABLE note_labels;
       DROP TABLE attachments; DROP TABLE note_revisions; ALTER TABLE captures DROP COLUMN prev_origin;
       ALTER TABLE captures DROP COLUMN project; UPDATE meta SET value = '3' WHERE key = 'schema_version'`,
    )
    raw.close()
    store = open({ path })
    expect(store.meta('schema_version')).toBe(String(SCHEMA_VERSION))
    expect(store.listCaptures().total).toBe(1)
    const note = store.notes.create({ title: 'Hello', labels: ['a'], items: [{ text: 'milk' }] })
    expect(store.notes.detail(note.id)).toMatchObject({ labels: ['a'], items: [{ text: 'milk' }] })
  })

  it('keeps one revision per field per window of continuous editing', () => {
    const note = store.notes.create({ title: 'v0', body: 'draft 0' })
    const edit = (body: string) => store.notes.update(note.id, { body })
    edit('draft 1') // keeps "draft 0"
    wall += MINUTE
    edit('draft 2') // inside the window: nothing kept
    wall += 3 * MINUTE
    edit('draft 3')
    expect(store.notes.revisions(note.id, 'body').map((r) => r.text)).toEqual(['draft 0'])
    wall += 2 * MINUTE // 6 minutes after the first revision
    edit('draft 4')
    store.notes.update(note.id, { title: 'v1' }) // a different field has its own window
    expect(store.notes.revisions(note.id).map((r) => `${r.field}:${r.text}:${r.reason}`)).toEqual([
      'title:v0:edit',
      'body:draft 3:edit',
      'body:draft 0:edit',
    ])
    wall += MINUTE
    store.notes.update(note.id, { body: 'draft 0', keepRevision: true }) // a restore keeps what it replaces
    expect(store.notes.revisions(note.id, 'body')[0]?.text).toBe('draft 4')
    expect(store.notes.update(note.id, { body: 'draft 0' })?.seq).toBe(
      store.notes.getNote(note.id)?.seq,
    ) // an unchanged text writes nothing
  })

  it('files grocery captures once: struck items unchecked with a hint, retries add nothing', async () => {
    const reading = {
      items: [
        { item: 'apples', quantity: '3 bags', struck: false, as_written: 'apples 3 bags' },
        { item: 'sea salt', quantity: null, struck: true, as_written: 'sea salt' },
      ],
    }
    const capture = readCapture(1, 'grocery_list', reading)
    expect(capture.route_note).toBeNull() // the notes owner is live, so no "coming soon"
    await router().afterReady(capture)

    const filed = store.getCapture(capture.id)
    const groceries = store.notes.groceries()
    expect(filed).toMatchObject({ status: 'filed', route_state: 'filed', owner_ref: groceries.id })
    expect(filed?.hash).toBe(HASH) // Aico keeps the photo
    const detail = store.notes.detail(groceries.id)
    expect(detail?.items.map((i) => [i.text, i.checked, i.hint])).toEqual([
      ['apples (3 bags)', 0, null],
      ['sea salt', 0, 'struck'],
    ])
    expect(detail?.attachments.map((a) => a.capture_id)).toEqual([capture.id])

    // A retry (the hand-off ran again before the capture was marked filed) and the
    // owner having deleted an item: nothing is added back.
    const first = detail?.items[0]
    store.notes.removeItem(groceries.id, first?.id as string)
    const file = {
      captureId: capture.id,
      hash: HASH,
      name: 'list.jpg',
      mime: 'image/jpeg',
      size: 10,
    }
    await new NotesOwner(store).send({ capture: filed, kind: 'grocery_list' } as never)
    expect(
      store.notes.fileGroceries(file, [{ text: 'apples (3 bags)' }, { text: 'sea salt' }]).added,
    ).toBe(0)
    expect(store.notes.items(groceries.id).map((i) => i.text)).toEqual(['sea salt'])
    expect(store.notes.attachments(groceries.id)).toHaveLength(1)

    // A second capture appends after the first.
    await router().afterReady(readCapture(2, 'grocery_list', { items: [{ item: 'eggs' }] }))
    expect(store.notes.items(groceries.id).map((i) => i.text)).toEqual(['sea salt', 'eggs'])
  })

  it('turns note, recipe and document captures into one note each', async () => {
    const capture = readCapture(3, 'recipe', { title: 'Fried rice' }, 'Cook the rice.')
    await router().afterReady(capture)
    await router().afterReady(capture) // again: still one note
    const filed = store.getCapture(capture.id)
    const note = store.notes.getNote(filed?.owner_ref as string)
    expect(note).toMatchObject({ kind: 'note', title: 'Fried rice', body: 'Cook the rice.' })
    expect(store.notes.list({ kind: 'note' }).total).toBe(1)
    expect(store.notes.attachments(note?.id as string)).toHaveLength(1)
    expect(store.countHashRefs(HASH)).toBe(2) // the capture and the attachment
  })

  for (const fts of [true, false])
    it(`searches titles, text, items and labels (${fts ? 'FTS5 when present' : 'LIKE'})`, () => {
      const searching = open({ fts })
      searching.notes.create({ title: 'Pancakes', body: 'flour and milk' })
      searching.notes.create({
        title: 'Trip',
        labels: ['Vacation'],
        items: [{ text: 'passports' }],
      })
      const find = (q: string) => searching.notes.list({ q }).notes.map((n) => n.title)
      expect(find('milk')).toEqual(['Pancakes'])
      expect(find('pass')).toEqual(['Trip'])
      expect(find('vacation')).toEqual(['Trip'])
      expect(find('flour milk')).toEqual(['Pancakes'])
      expect(find('flour passports')).toEqual([])
      const done = searching.notes.getNote(
        searching.notes.list({ q: 'trip' }).notes[0]?.id as string,
      )
      searching.notes.remove(done?.id as string)
      expect(find('trip')).toEqual([]) // a tombstone is not found
      searching.close()
    })

  it('leaves tombstones out of lists and counts only live, unchecked and checked items', () => {
    const list = store.notes.create({
      kind: 'list',
      title: 'Todo',
      items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
    })
    const [a, b, c] = store.notes.items(list.id)
    store.notes.updateItem(list.id, a?.id as string, { checked: true })
    store.notes.removeItem(list.id, c?.id as string)
    const gone = store.notes.create({ title: 'Gone' })
    store.notes.remove(gone.id)
    store.notes.update(store.notes.create({ title: 'Old' }).id, { archived: true })

    const { notes, total } = store.notes.list()
    expect(total).toBe(1)
    expect(notes[0]).toMatchObject({ title: 'Todo', unchecked: 1, checked_count: 1 })
    expect(notes[0]?.preview.map((i) => i.id)).toEqual([b?.id])
    expect(store.notes.getNote(gone.id)).toBeNull()
    expect(store.notes.list({ archived: true }).notes.map((n) => n.title)).toEqual(['Old'])
    expect(store.notes.list({ archived: 'all' }).total).toBe(2)
  })

  it('serves the notes API: create, edit, check, label, search, delete', async () => {
    const api = await serveRoutes((r) =>
      registerNoteRoutes(r, { store, blobsDir: join(dir, 'blobs') }),
    )
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${api.base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      // biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely
      return { status: response.status, body: (await response.json()) as Record<string, any> }
    }
    try {
      // A session deletes the note it made, not another session's, the owner's or a reworded one.
      const mine = await call('POST', '/api/notes', { title: 'Mine', madeBy: '12345678' })
      expect(mine.body.source).toMatch(/^session:12345678:/)
      const second = await call('POST', '/api/notes', { title: 'Mine too', madeBy: '12345678' })
      const owners = await call('POST', '/api/notes', { title: 'Owner made' })
      expect((await call('POST', '/api/notes', { madeBy: 'nope' })).status).toBe(422)
      const asSession = (id: string, session: string) =>
        call('DELETE', `/api/notes/${id}?madeBy=${session}`)
      expect((await asSession(mine.body.id, 'abcdef01')).status).toBe(403)
      expect((await asSession(owners.body.id, '12345678')).status).toBe(403)
      expect((await asSession(mine.body.id, '12345678')).body.deleted).toBe(true)
      expect((await call('GET', `/api/notes/${mine.body.id}`)).status).toBe(404)
      await call('POST', `/api/notes/${second.body.id}/items`, { text: 'an item is no rewording' })
      wall += MINUTE
      await call('PATCH', `/api/notes/${second.body.id}`, { body: 'the owner wrote this' })
      const reworded = await asSession(second.body.id, '12345678')
      expect(reworded.status).toBe(403)
      expect(reworded.body.detail).toMatch(/has edited/)
      expect((await call('DELETE', `/api/notes/${owners.body.id}`)).body.deleted).toBe(true)
      expect((await call('DELETE', `/api/notes/${second.body.id}`)).body.deleted).toBe(true)

      const made = await call('POST', '/api/notes', {
        kind: 'list',
        title: 'Trip',
        items: ['maps'],
        labels: ['Fun'],
      })
      expect(made.status).toBe(201)
      const id = made.body.id as string
      const item = await call('POST', `/api/notes/${id}/items`, { text: 'tickets', position: 0.5 })
      expect(item.body).toMatchObject({ text: 'tickets', checked: false, position: 0.5 })
      const checked = await call('PATCH', `/api/notes/${id}/items/${item.body.id}`, {
        checked: true,
      })
      expect(checked.body.checked).toBe(true)
      expect(
        (await call('PUT', `/api/notes/${id}/labels`, { labels: ['Fun', 'Soon'] })).body.labels,
      ).toEqual(['Fun', 'Soon'])
      const list = await call('GET', '/api/notes?q=tick&label=soon&kind=list')
      expect(list.body.total).toBe(1)
      expect(list.body.notes[0]).toMatchObject({ unchecked: 1, checked: 1 })
      const detail = await call('GET', `/api/notes/${id}`)
      expect(detail.body.items.map((i: { text: string }) => i.text)).toEqual(['tickets', 'maps'])
      expect(
        (await call('PATCH', `/api/notes/${id}`, { title: 'Trip 2', color: 'red' })).status,
      ).toBe(422)
      expect((await call('PATCH', `/api/notes/${id}`, { title: 'Trip 2' })).body.title).toBe(
        'Trip 2',
      )
      expect((await call('GET', `/api/notes/${id}/revisions`)).body.revisions[0]).toMatchObject({
        field: 'title',
        text: 'Trip',
      })
      expect((await call('DELETE', `/api/notes/${id}`)).body).toEqual({ deleted: true, id })
      expect(await call('GET', `/api/notes/${id}`)).toMatchObject({
        status: 404,
        body: { detail: 'That note is gone' },
      })
      expect((await call('GET', '/api/notes/groceries')).body).toMatchObject({
        kind: 'list',
        title: 'Groceries',
      })
      expect((await call('GET', '/api/notes?kind=bogus')).status).toBe(422)
    } finally {
      await api.close()
    }
  })

  it('serves reminders and the label list', async () => {
    const api = await serveRoutes((r) =>
      registerNoteRoutes(r, { store, blobsDir: join(dir, 'blobs') }),
    )
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${api.base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      // biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely
      return { status: response.status, body: (await response.json()) as Record<string, any> }
    }
    try {
      const soon = wall + 2 * MINUTE
      const later = wall + 60 * MINUTE
      const a = await call('POST', '/api/notes', {
        title: 'Later',
        remindAt: later,
        labels: ['Car'],
      })
      expect(a.body).toMatchObject({ remindAt: later, remindedAt: null })
      const b = await call('POST', '/api/notes', { title: 'Soon', labels: ['car', 'Home'] })
      const c = await call('POST', '/api/notes', { title: 'No reminder' })
      expect(c.body.remindAt).toBeNull()
      expect(
        (await call('PATCH', `/api/notes/${b.body.id}`, { remindAt: soon })).body.remindAt,
      ).toBe(soon)
      // The due list: only notes with a reminder, soonest first.
      const due = await call('GET', '/api/notes?reminders=true')
      expect(due.body.notes.map((n: { title: string }) => n.title)).toEqual(['Soon', 'Later'])
      expect(due.body.total).toBe(2)
      // An archived note with a reminder still shows in it; the plain list hides it.
      await call('PATCH', `/api/notes/${a.body.id}`, { archived: true })
      expect((await call('GET', '/api/notes?reminders=true')).body.total).toBe(2)
      expect((await call('GET', '/api/notes')).body.total).toBe(2)
      // Clearing, and bad times.
      expect(
        (await call('PATCH', `/api/notes/${b.body.id}`, { remindAt: null })).body.remindAt,
      ).toBeNull()
      expect((await call('GET', '/api/notes?reminders=true')).body.total).toBe(1)
      for (const bad of ['tomorrow', 1.5, 5, 1e15])
        expect((await call('PATCH', `/api/notes/${b.body.id}`, { remindAt: bad })).status).toBe(422)
      // One entry per label whatever its casing, counted over live notes.
      expect((await call('GET', '/api/notes/labels')).body.labels).toEqual([
        { label: 'car', count: 1 },
        { label: 'Home', count: 1 },
      ])
      expect((await call('GET', '/api/notes/labels?archived=true')).body.labels).toEqual([
        { label: 'Car', count: 1 },
      ])
      expect((await call('GET', '/api/notes/labels?archived=all')).body.labels).toEqual([
        { label: 'Car', count: 2 },
        { label: 'Home', count: 1 },
      ])
      await call('DELETE', `/api/notes/${b.body.id}`)
      expect((await call('GET', '/api/notes/labels')).body.labels).toEqual([])
      expect((await call('GET', '/api/notes/labels?archived=x')).status).toBe(422)
    } finally {
      await api.close()
    }
  })

  it('gives notes a project: create, filter, move, clear, and keep the rest global', async () => {
    const api = await serveRoutes((r) =>
      registerNoteRoutes(r, { store, blobsDir: join(dir, 'blobs') }),
    )
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${api.base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      // biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely
      return { status: response.status, body: (await response.json()) as Record<string, any> }
    }
    const titles = async (query = '') =>
      ((await call('GET', `/api/notes${query}`)).body.notes as { title: string }[])
        .map((n) => n.title)
        .sort()
    try {
      const global = await call('POST', '/api/notes', { title: 'Global' })
      expect(global.body.project).toBeNull()
      const mine = await call('POST', '/api/notes', {
        title: 'Mine',
        project: 'portfolio-ai',
        labels: ['plan'],
      })
      expect(mine.status).toBe(201)
      expect(mine.body.project).toBe('portfolio-ai')
      await call('POST', '/api/notes', { title: 'Other', project: 'aico', labels: ['idea'] })

      // The All scope has no project filter; a project scope shows only that project.
      expect(await titles()).toEqual(['Global', 'Mine', 'Other'])
      expect(await titles('?project=portfolio-ai')).toEqual(['Mine'])
      expect((await call('GET', '/api/notes?project=nobody')).body.total).toBe(0)
      // Labels follow the scope.
      const labels = async (query: string) =>
        ((await call('GET', `/api/notes/labels${query}`)).body.labels as { label: string }[]).map(
          (l) => l.label,
        )
      expect(await labels('')).toEqual(['idea', 'plan'])
      expect(await labels('?project=aico')).toEqual(['idea'])

      // Move it to another project, then to none.
      const moved = await call('PATCH', `/api/notes/${mine.body.id}`, { project: 'aico' })
      expect(moved.body.project).toBe('aico')
      expect(await titles('?project=aico')).toEqual(['Mine', 'Other'])
      const cleared = await call('PATCH', `/api/notes/${mine.body.id}`, { project: null })
      expect(cleared.body.project).toBeNull()
      expect(await titles('?project=aico')).toEqual(['Other'])
      expect(await titles()).toEqual(['Global', 'Mine', 'Other'])
      // A save that leaves the project out keeps it.
      await call('PATCH', `/api/notes/${mine.body.id}`, { project: 'aico' })
      expect(
        (await call('PATCH', `/api/notes/${mine.body.id}`, { title: 'Mine 2' })).body,
      ).toMatchObject({ project: 'aico', title: 'Mine 2' })

      // Not a project id.
      expect((await call('POST', '/api/notes', { project: '../etc' })).status).toBe(422)
      expect((await call('PATCH', `/api/notes/${mine.body.id}`, { project: 7 })).status).toBe(422)
      expect((await call('GET', '/api/notes?project=a b')).status).toBe(422)
    } finally {
      await api.close()
    }
  })

  it('files a capture as a note in the project it was taken in', () => {
    const row = store.insertCapture({
      clientId: 'client-90000',
      kind: 'image',
      name: 'page.jpg',
      mime: 'image/jpeg',
      size: 10,
      hash: HASH,
      project: 'aico',
    }).capture
    const noteId = store.notes.fileNote(
      { captureId: row.id, hash: HASH, name: 'page.jpg', mime: 'image/jpeg', size: 10 },
      { title: 'Page', body: 'text', project: row.project },
    )
    expect(store.notes.getNote(noteId)?.project).toBe('aico')
    expect(store.notes.groceries().project).toBeNull()
  })

  it('hides secret-looking text in list previews, not in the note itself', async () => {
    const api = await serveRoutes((r) =>
      registerNoteRoutes(r, { store, blobsDir: join(dir, 'blobs') }),
    )
    // Fake, built in pieces; long filler first so the token straddles the cut.
    const token = `${'7012345678'}:${'AAFakeFakeFake_0123456789abcdefXYZ'}w`
    const body = `${'x '.repeat(95)}bot ${token} then password: fake-pass`
    const note = store.notes.create({ title: `key ${token}`, body, items: [{ text: token }] })
    try {
      // biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely
      const list: any = await (await fetch(`${api.base}/api/notes`)).json()
      const row = list.notes.find((n: { id: string }) => n.id === note.id)
      const shown = JSON.stringify(row)
      expect(shown).not.toContain(token.slice(0, 20))
      expect(shown).not.toContain(token.slice(-20))
      expect(row.title).toBe('key •••• (hidden: looks like a token)')
      expect(row.snippet).toMatch(/bot ••••/)
      expect(row.preview[0].text).toBe('•••• (hidden: looks like a token)')
      // biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely
      const detail: any = await (await fetch(`${api.base}/api/notes/${note.id}`)).json()
      expect(detail.title).toBe(`key ${token}`)
      expect(detail.body).toBe(body)
      expect(detail.items[0].text).toBe(token)
    } finally {
      await api.close()
    }
  })
})
