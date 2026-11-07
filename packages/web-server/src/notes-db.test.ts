import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type NewCapture, NotesStore, SCHEMA_VERSION } from './notes-db'

const HASH = 'a'.repeat(64)

function capture(clientId: string, fields: Partial<NewCapture> = {}): NewCapture {
  return {
    clientId,
    kind: 'image',
    name: `${clientId}.jpg`,
    mime: 'image/jpeg',
    size: 10,
    hash: HASH,
    ...fields,
  }
}

describe('NotesStore', () => {
  let dir: string
  let wall: number
  const now = () => wall

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-notes-'))
    wall = 1_700_000_000_000
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const open = (path = ':memory:') => new NotesStore(path, { hostName: 'gem', now })

  it('creates a private database with its meta rows', () => {
    const path = join(dir, 'state', 'notes.db')
    const store = open(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700)
    expect(store.meta('schema_version')).toBe(String(SCHEMA_VERSION))
    expect(store.meta('db_id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(store.meta('host_name')).toBe('gem')
    expect(store.meta('seq')).toBe('0')
    store.close()
  })

  it('keeps its db_id and data across a reopen, and gives a fresh file a new db_id', () => {
    const path = join(dir, 'notes.db')
    const first = open(path)
    const id = first.meta('db_id')
    const { capture: row } = first.insertCapture(capture('c1c1c1c1'))
    first.close()
    const again = open(path)
    expect(again.meta('db_id')).toBe(id)
    expect(again.getCapture(row.id)?.client_id).toBe('c1c1c1c1')
    again.close()
    const other = open(join(dir, 'other.db'))
    expect(other.meta('db_id')).not.toBe(id)
    other.close()
  })

  it('refuses a file from a newer Aico, and releases it', () => {
    const path = join(dir, 'notes.db')
    open(path).close()
    const raw = new DatabaseSync(path)
    raw.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`)
    raw.close()
    expect(() => open(path)).toThrow(/newer than this Aico/)
  })

  it('migrates a version 1 file by adding the extract and route columns', () => {
    const path = join(dir, 'notes.db')
    const first = open(path)
    first.insertCapture(capture('aaaaaaaa'))
    first.close()
    const raw = new DatabaseSync(path)
    raw.exec(
      `DROP TABLE notes_fts; DROP TABLE notes; DROP TABLE note_items; DROP TABLE note_labels;
       DROP TABLE attachments; DROP TABLE note_revisions;
       DROP INDEX captures_route; ALTER TABLE captures DROP COLUMN project;
       ALTER TABLE captures DROP COLUMN prev_origin;
       ALTER TABLE captures DROP COLUMN owner;
       ALTER TABLE captures DROP COLUMN owner_ref; ALTER TABLE captures DROP COLUMN route_state;
       ALTER TABLE captures DROP COLUMN route_note;
       ALTER TABLE captures DROP COLUMN extract_json; ALTER TABLE captures DROP COLUMN extract_route;
       ALTER TABLE captures DROP COLUMN extract_error; UPDATE meta SET value = '1' WHERE key = 'schema_version'`,
    )
    raw.close()
    const store = open(path)
    expect(store.meta('schema_version')).toBe(String(SCHEMA_VERSION))
    expect(store.claimForExtraction()).toMatchObject({
      status: 'extracting',
      extract_json: null,
      route_state: null,
    })
    store.close()
  })

  it('migrates a schema 4 file by adding prev_origin, keeping every row', () => {
    const path = join(dir, 'notes.db')
    const first = open(path)
    const { capture: kept } = first.insertCapture(capture('dddddddd'))
    const note = first.notes.create({ title: 'Kept', items: [{ text: 'milk' }] })
    first.close()
    const raw = new DatabaseSync(path)
    raw.exec(
      `${['captures', 'notes', 'note_items', 'note_labels', 'attachments', 'note_revisions']
        .map((table) => `ALTER TABLE ${table} DROP COLUMN prev_origin;`)
        .join(' ')} DROP INDEX notes_project; ALTER TABLE notes DROP COLUMN project;
       ALTER TABLE captures DROP COLUMN project; DROP INDEX notes_remind; ALTER TABLE notes DROP COLUMN remind_at; ALTER TABLE notes DROP COLUMN reminded_at; UPDATE meta SET value = '4' WHERE key = 'schema_version'`,
    )
    raw.close()
    const store = open(path)
    expect(store.meta('schema_version')).toBe(String(SCHEMA_VERSION))
    expect(store.getCapture(kept.id)).toMatchObject({ client_id: 'dddddddd', prev_origin: null })
    expect(store.notes.getNote(note.id)?.title).toBe('Kept')
    expect(store.notes.items(note.id).map((i) => i.text)).toEqual(['milk'])
    store.close()
  })

  it('migrates a schema 5 file by adding the reminder columns, keeping every note', () => {
    const path = join(dir, 'notes.db')
    const first = open(path)
    const note = first.notes.create({ title: 'Kept', remindAt: wall })
    first.close()
    const raw = new DatabaseSync(path)
    raw.exec(
      `DROP INDEX notes_project; ALTER TABLE notes DROP COLUMN project;
       ALTER TABLE captures DROP COLUMN project; DROP INDEX notes_remind;
       ALTER TABLE notes DROP COLUMN remind_at;
       ALTER TABLE notes DROP COLUMN reminded_at; UPDATE meta SET value = '5' WHERE key = 'schema_version'`,
    )
    raw.close()
    const store = open(path)
    expect(store.meta('schema_version')).toBe(String(SCHEMA_VERSION))
    expect(store.notes.getNote(note.id)).toMatchObject({
      title: 'Kept',
      remind_at: null,
      reminded_at: null,
    })
    store.notes.update(note.id, { remindAt: wall })
    expect(store.notes.getNote(note.id)?.remind_at).toBe(wall)
    store.close()
  })

  it('migrates a schema 6 file by adding the project columns: old notes stay global', () => {
    const path = join(dir, 'notes.db')
    const first = open(path)
    const note = first.notes.create({ title: 'Old', project: 'aico' })
    const { capture: kept } = first.insertCapture(capture('eeeeeeee', { project: 'aico' }))
    first.close()
    const raw = new DatabaseSync(path)
    raw.exec(
      `DROP INDEX notes_project; ALTER TABLE notes DROP COLUMN project;
       ALTER TABLE captures DROP COLUMN project; UPDATE meta SET value = '6' WHERE key = 'schema_version'`,
    )
    raw.close()
    const store = open(path)
    expect(store.meta('schema_version')).toBe(String(SCHEMA_VERSION))
    expect(store.notes.getNote(note.id)).toMatchObject({ title: 'Old', project: null })
    expect(store.getCapture(kept.id)).toMatchObject({ client_id: 'eeeeeeee', project: null })
    expect(store.notes.list({ project: 'aico' }).total).toBe(0)
    expect(store.notes.list().total).toBe(1)
    const index = new DatabaseSync(path)
    expect(
      index.prepare("SELECT name FROM sqlite_master WHERE name = 'notes_project'").get(),
    ).toBeDefined()
    index.close()
    store.close()
  })

  it('returns the same row for a repeated client_id', () => {
    const store = open()
    const first = store.insertCapture(capture('aaaaaaaa'))
    const second = store.insertCapture(capture('aaaaaaaa', { name: 'other.jpg' }))
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.capture.id).toBe(first.capture.id)
    expect(second.capture.name).toBe('aaaaaaaa.jpg')
    expect(store.listCaptures().total).toBe(1)
    expect(store.meta('seq')).toBe('1')
  })

  it('stamps every write with a new seq, clock value and origin', () => {
    const store = open()
    const { capture: added } = store.insertCapture(capture('bbbbbbbb'))
    expect(added).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      origin: 'gem',
      prev: null,
      deleted: 0,
      seq: 1,
      status: 'new',
      caption: '',
      created_at: wall,
    })
    const edited = store.updateCaption(added.id, 'hello')
    // An edit of its own host's version has no other host to build on.
    expect(edited).toMatchObject({ caption: 'hello', seq: 2, prev: null, prev_origin: null })
    expect(edited?.updated_at).toBeGreaterThan(added.updated_at)
    const gone = store.tombstoneCapture(added.id)
    expect(gone).toBe(true)
    const row = store.getCapture(added.id, true)
    expect(row).toMatchObject({ deleted: 1, seq: 3, prev: null })
    expect(store.meta('seq')).toBe('3')
    expect(store.meta('hlc_last')).toBe(String(row?.updated_at))
  })

  it('never repeats or reverses updated_at, even with a stalled or backwards clock', () => {
    const store = open()
    const stamps: number[] = []
    const { capture: row } = store.insertCapture(capture('cccccccc'))
    stamps.push(row.updated_at)
    for (let index = 0; index < 4; index += 1) {
      if (index === 2) wall -= 60_000 // clock steps back
      stamps.push(store.updateCaption(row.id, `v${index}`)?.updated_at as number)
    }
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
    expect(new Set(stamps).size).toBe(stamps.length)
  })

  it('keeps clock order across a reopen even when the wall clock is behind', () => {
    const path = join(dir, 'notes.db')
    const first = open(path)
    const { capture: row } = first.insertCapture(capture('dddddddd'))
    first.close()
    wall -= 3_600_000
    const again = open(path)
    expect(again.updateCaption(row.id, 'later')?.updated_at).toBeGreaterThan(row.updated_at)
    again.close()
  })

  it('moves its clock past a peer stamp it observes', () => {
    const store = open()
    store.observe(wall + 10_000_000)
    const { capture: row } = store.insertCapture(capture('eeeeeeee'))
    expect(row.updated_at).toBe(wall + 10_000_001)
  })

  it('hides a tombstone from reads and lists', () => {
    const store = open()
    const { capture: row } = store.insertCapture(capture('ffffffff'))
    store.insertCapture(capture('gggggggg'))
    store.tombstoneCapture(row.id)
    expect(store.getCapture(row.id)).toBeNull()
    expect(store.getCapture(row.id, true)?.deleted).toBe(1)
    expect(store.listCaptures().total).toBe(1)
    expect(store.updateCaption(row.id, 'x')).toBeNull()
    expect(store.tombstoneCapture(row.id)).toBe(false)
    // The retry still finds it, so it is not stored again.
    expect(store.insertCapture(capture('ffffffff')).created).toBe(false)
  })

  it('lists newest first with paging, filters and a total', () => {
    const store = open()
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      wall += 1000
      ids.push(
        store.insertCapture(
          capture(`client0${index}`, { askId: index < 2 ? 'a1b2c3d4e5f6' : null }),
        ).capture.id,
      )
    }
    wall += 0 // same created_at ms for the next two: ordering falls back to id
    store.insertCapture(capture('client05'))
    store.insertCapture(capture('client06'))
    const page1 = store.listCaptures({ limit: 3 })
    expect(page1.total).toBe(7)
    expect(page1.captures).toHaveLength(3)
    const page2 = store.listCaptures({ limit: 3, before: page1.captures[2]?.id })
    const page3 = store.listCaptures({ limit: 3, before: page2.captures[2]?.id })
    const all = [...page1.captures, ...page2.captures, ...page3.captures].map((row) => row.id)
    expect(new Set(all).size).toBe(7)
    expect(page3.captures).toHaveLength(1)
    expect(store.listCaptures({ ask: 'a1b2c3d4e5f6' }).captures.map((row) => row.id)).toEqual([
      ids[1],
      ids[0],
    ])
    expect(store.capturesForAsk('a1b2c3d4e5f6').map((row) => row.id)).toEqual([ids[0], ids[1]])
    expect(store.listCaptures({ status: 'ready' })).toEqual({ captures: [], total: 0 })
    expect(store.listCaptures({ before: 'ffffffffffff' }).captures).toEqual([])
    expect(store.listCaptures({ before: String(wall - 2500) }).captures.length).toBe(2)
  })

  it('counts live captures in a group', () => {
    const store = open()
    const a = store.insertCapture(capture('hhhhhhhh', { groupId: 'group-one' }))
    store.insertCapture(capture('iiiiiiii', { groupId: 'group-one' }))
    store.insertCapture(capture('jjjjjjjj', { groupId: 'group-two' }))
    expect(store.countInGroup('group-one')).toBe(2)
    store.tombstoneCapture(a.capture.id)
    expect(store.countInGroup('group-one')).toBe(1)
  })
})
