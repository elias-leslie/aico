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
       UPDATE meta SET value = '3' WHERE key = 'schema_version'`,
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
})
