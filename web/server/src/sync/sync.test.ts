import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPage,
  changesSince,
  missingBlobs,
  pullSet,
  purgeTombstones,
  readPeer,
  resetDbId,
  SyncError,
} from './engine'
import {
  backup,
  dump,
  FakeClock,
  type Host,
  Link,
  openHost,
  pull,
  START,
  settle,
  transport,
} from './harness'

const DAY = 86_400_000
const MINUTE = 60_000

let hosts: Host[]
let dir: string
const host = (name: string, options?: Parameters<typeof openHost>[1]) => {
  const opened = openHost(name, options)
  hosts.push(opened)
  return opened
}

beforeEach(() => {
  hosts = []
  dir = mkdtempSync(join(tmpdir(), 'aico-sync-'))
})
afterEach(() => {
  for (const h of hosts) {
    h.notes.close()
    h.web.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

const itemTexts = (h: Host, noteId: string) =>
  h.notes.notes
    .items(noteId)
    .map((i) => i.text)
    .sort()
const conflicts = (h: Host) =>
  h.handles.notes.db
    .prepare(
      "SELECT table_name, field, text FROM note_revisions WHERE reason = 'conflict' ORDER BY text",
    )
    .all() as { table_name: string; field: string; text: string }[]

describe('two doors, one list', () => {
  it('survives a split brain: every add kept, newest title wins, nothing lost', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    const note = a.notes.notes.create({ kind: 'list', title: 'Trip', items: [] })
    const del = a.notes.notes.addItem(note.id, { text: 'sunscreen' })
    const plain = a.notes.notes.addItem(note.id, { text: 'old thing' })
    a.notes.notes.addItem(note.id, { text: 'passport' })
    await settle(a, b, link)
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))

    link.down()
    a.clock.advance(MINUTE)
    a.notes.notes.addItem(note.id, { text: 'a1' })
    a.notes.notes.addItem(note.id, { text: 'a2' })
    a.notes.notes.update(note.id, { title: 'Trip (A)' })
    a.notes.notes.removeItem(note.id, del?.id as string)
    b.clock.advance(2 * MINUTE)
    b.notes.notes.addItem(note.id, { text: 'b1' })
    b.notes.notes.addItem(note.id, { text: 'b2' })
    b.notes.notes.update(note.id, { title: 'Trip (B)' })
    b.notes.notes.updateItem(note.id, del?.id as string, { text: 'sunscreen SPF50' })
    b.notes.notes.removeItem(note.id, plain?.id as string)
    // Down means down: nothing moved.
    expect((await pull(a, b, link)).notes.status).toBe('unreachable')
    expect(itemTexts(a, note.id)).not.toContain('b1')

    link.up()
    await settle(a, b, link)
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
    for (const h of [a, b]) {
      expect(itemTexts(h, note.id)).toEqual(
        ['a1', 'a2', 'b1', 'b2', 'passport', 'sunscreen SPF50'].sort(),
      )
      expect(h.notes.notes.getNote(note.id)?.title).toBe('Trip (B)')
      expect(conflicts(h)).toEqual([
        { table_name: 'notes', field: 'title', text: 'Trip (A)' },
        { table_name: 'note_items', field: 'text', text: 'sunscreen' },
      ])
    }
  })

  it('a clock 10 minutes behind or ahead cannot make a later edit lose', async () => {
    const a = host('workstation')
    const b = host('gem', { clock: new FakeClock() })
    const link = new Link()
    const note = a.notes.notes.create({ kind: 'list', title: 'Skew', items: [{ text: 'x' }] })
    const item = a.notes.notes.items(note.id)[0]?.id as string
    await settle(a, b, link)

    b.clock.advance(-10 * MINUTE) // B lags
    a.clock.advance(MINUTE)
    a.notes.notes.updateItem(note.id, item, { text: 'from A' })
    await pull(b, a, link)
    b.notes.notes.updateItem(note.id, item, { text: 'from B, slow clock' })
    await settle(a, b, link)
    expect(a.notes.notes.items(note.id)[0]?.text).toBe('from B, slow clock')
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))

    b.clock.advance(20 * MINUTE) // now B runs 10 minutes ahead of A
    b.notes.notes.updateItem(note.id, item, { text: 'from B, fast clock' })
    await pull(a, b, link)
    a.notes.notes.updateItem(note.id, item, { text: 'from A, after B' })
    await settle(a, b, link)
    expect(b.notes.notes.items(note.id)[0]?.text).toBe('from A, after B')
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
  })

  it('refuses a batch more than a day ahead, and does not take its clock', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    b.clock.advance(2 * DAY)
    b.notes.notes.create({ title: 'from the future' })
    const result = (await pull(a, b, link)).notes
    expect(result.status).toBe('clock_ahead')
    expect(a.notes.notes.list().total).toBe(0)
    expect(readPeer(a.handles.notes, 'gem')?.status).toBe('clock_ahead')
    a.notes.notes.create({ title: 'mine' })
    expect(a.notes.notes.list({ q: 'mine' }).notes[0]?.updated_at).toBeLessThan(START + DAY)
  })

  it('a long run of edits between pulls is one history, not a conflict', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    const note = a.notes.notes.create({ title: 'v0', body: 'start' })
    await settle(a, b, link)
    for (const title of ['v1', 'v2', 'v3']) {
      a.clock.advance(MINUTE)
      a.notes.notes.update(note.id, { title })
    }
    await settle(a, b, link)
    expect(b.notes.notes.getNote(note.id)?.title).toBe('v3')
    expect(conflicts(b)).toEqual([])
    // B builds on it and A takes that too.
    b.clock.advance(MINUTE)
    b.notes.notes.update(note.id, { body: 'edited on B' })
    await settle(a, b, link)
    expect(a.notes.notes.getNote(note.id)?.body).toBe('edited on B')
    expect(conflicts(a)).toEqual([])
  })

  it('a delete beats an older edit, and the edit is kept', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    const note = a.notes.notes.create({ title: 'Doomed', body: 'important text' })
    await settle(a, b, link)
    link.down()
    b.clock.advance(MINUTE)
    b.notes.notes.update(note.id, { body: 'edited on B' })
    a.clock.advance(2 * MINUTE)
    a.notes.notes.remove(note.id)
    link.up()
    await settle(a, b, link)
    for (const h of [a, b]) {
      expect(h.notes.notes.getNote(note.id)).toBeNull()
      expect(conflicts(h)).toContainEqual({
        table_name: 'notes',
        field: 'body',
        text: 'edited on B',
      })
    }
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
  })

  it('search finds a note that arrived by sync', async () => {
    const a = host('workstation')
    const b = host('gem')
    a.notes.notes.create({ title: 'Soup', items: [{ text: 'leeks' }] })
    await settle(a, b, new Link())
    expect(b.notes.notes.list({ q: 'leeks' }).total).toBe(1)
  })

  it('two Groceries lists made apart settle on one name, the same on both', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    const first = a.notes.notes.create({
      kind: 'list',
      title: 'Groceries',
      source: 'aico:groceries',
    })
    const second = b.notes.notes.create({
      kind: 'list',
      title: 'Groceries',
      source: 'aico:groceries',
    })
    await settle(a, b, link)
    const [keeper, other] = [first.id, second.id].sort()
    for (const h of [a, b]) {
      expect(h.notes.notes.findBySource('aico:groceries')?.id).toBe(keeper)
      expect(h.notes.notes.getNote(other as string)?.source).toBe(`aico:groceries~${other}`)
    }
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
  })

  it('one upload retried against both doors is one capture row per id, none rejected', async () => {
    const a = host('workstation')
    const b = host('gem')
    const upload = {
      clientId: 'c1c1c1c1',
      kind: 'image',
      name: 'p.jpg',
      mime: 'image/jpeg',
      size: 1,
      hash: 'a'.repeat(64),
    } as const
    const first = a.notes.insertCapture(upload).capture
    const second = b.notes.insertCapture(upload).capture
    await settle(a, b, new Link())
    expect(first.id).not.toBe(second.id)
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
    expect(a.notes.findByClientId('c1c1c1c1')?.id).toBe([first.id, second.id].sort()[0])
  })
})

describe('applying pages', () => {
  it('applying a page twice, or after half of it, changes nothing more', async () => {
    const a = host('workstation')
    const b = host('gem')
    const note = a.notes.notes.create({
      kind: 'list',
      title: 'T',
      items: [{ text: 'one' }, { text: 'two' }],
    })
    a.notes.notes.update(note.id, { title: 'T2' })
    const page = changesSince(a.handles.notes, 0, 100)

    const half = host('half')
    applyPage(half.handles.notes, page.rows.slice(0, 2))
    applyPage(half.handles.notes, page.rows)
    const first = applyPage(b.handles.notes, page.rows)
    const seq = b.notes.meta('seq')
    const again = applyPage(b.handles.notes, page.rows)
    expect(first.applied).toBe(page.rows.length)
    expect(again).toMatchObject({ applied: 0, skipped: page.rows.length })
    expect(b.notes.meta('seq')).toBe(seq)
    expect(dump(b.handles.notes)).toEqual(dump(a.handles.notes))
    expect(dump(half.handles.notes)).toEqual(dump(a.handles.notes))
  })

  it('a page that fails part way applies none of it and leaves the cursor', async () => {
    const a = host('workstation')
    const b = host('gem')
    a.notes.notes.create({ title: 'good' })
    const page = changesSince(a.handles.notes, 0, 100)
    const broken = [
      ...page.rows,
      {
        table: 'note_items',
        row: { id: 'x', updated_at: START, origin: 'workstation', note_id: 'n' },
      },
    ]
    expect(() =>
      applyPage(b.handles.notes, broken, { cursor: { host: 'workstation', db_id: 'd', next: 9 } }),
    ).toThrow()
    expect(b.notes.notes.list().total).toBe(0)
    expect(readPeer(b.handles.notes, 'workstation')).toBeNull()
    expect(() => applyPage(b.handles.notes, [{ table: 'nope', row: { id: '1' } }])).toThrow(
      SyncError,
    )
  })

  it('a page dropped mid-way applies nothing and the next pull picks it up', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    for (const text of ['a', 'b', 'c']) a.notes.notes.create({ title: text })
    link.dropNextPage(2)
    const failed = (await pull(b, a, link)).notes
    expect(failed.status).toBe('unreachable')
    expect(b.notes.notes.list().total).toBe(0)
    expect(readPeer(b.handles.notes, 'workstation')?.cursor ?? 0).toBe(0)
    const ok = (await pull(b, a, link, { limit: 2 })).notes
    expect(ok).toMatchObject({ status: 'ok', applied: 3, pages: 2 })
    expect(b.notes.notes.list().total).toBe(3)
  })
})

describe('restore', () => {
  it('a host restored from an older file takes a new id; the peer starts over and nothing regresses', async () => {
    const a = host('workstation', { notesPath: join(dir, 'a-notes.db') })
    const b = host('gem')
    const link = new Link()
    const note = a.notes.notes.create({ title: 'Plan', body: 'v1' })
    await settle(a, b, link)
    const snapshot = join(dir, 'backup.db')
    backup(a.handles.notes, snapshot)
    const oldId = a.notes.meta('db_id')

    a.clock.advance(MINUTE)
    a.notes.notes.update(note.id, { body: 'v2, after the backup' })
    const lost = a.notes.notes.create({ title: 'made after the backup' })
    await settle(a, b, link)
    const before = dump(b.handles.notes)

    // The disk comes back from the backup: the same db_id, fewer changes.
    a.notes.close()
    a.web.close()
    hosts = hosts.filter((h) => h !== a)
    copyFileSync(snapshot, join(dir, 'a-notes.db'))
    const restored = openHost('workstation', { clock: a.clock, notesPath: join(dir, 'a-notes.db') })
    hosts.push(restored)
    expect(restored.notes.notes.getNote(lost.id)).toBeNull()
    expect(restored.notes.meta('db_id')).toBe(oldId)

    // B's cursor on A is past A's seq: A notices, takes a new id, B starts from 0.
    await pull(b, restored, link)
    expect(restored.notes.meta('db_id')).not.toBe(oldId)
    expect(readPeer(b.handles.notes, 'workstation')?.db_id).toBe(restored.notes.meta('db_id'))
    await settle(restored, b, link)
    expect(dump(b.handles.notes)).toEqual(before)
    expect(dump(restored.handles.notes)).toEqual(before)
    expect(restored.notes.notes.getNote(note.id)?.body).toBe('v2, after the backup')
    expect(restored.notes.notes.getNote(lost.id)?.title).toBe('made after the backup')
    expect(conflicts(restored)).toEqual([])
  })

  it('an explicit new id (a restore script) does the same', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    a.notes.notes.create({ title: 'one' })
    await settle(a, b, link)
    const served = a.notes.meta('served:gem')
    expect(served).not.toBeNull()
    const oldId = a.notes.meta('db_id')
    resetDbId(a.handles.notes)
    expect(a.notes.meta('db_id')).not.toBe(oldId)
    expect(a.notes.meta('served:gem')).toBeNull()
    const result = (await pull(b, a, link)).notes
    expect(result).toMatchObject({ status: 'ok' })
    expect(readPeer(b.handles.notes, 'workstation')?.db_id).toBe(a.notes.meta('db_id'))
    expect(b.notes.notes.list().total).toBe(1)
  })
})

describe('tombstones', () => {
  it('are kept until the retention has passed and every peer has pulled them', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    const note = a.notes.notes.create({ title: 'to delete' })
    await settle(a, b, link)
    link.down()
    a.notes.notes.remove(note.id)
    const options = { retentionMs: 180 * DAY, peers: ['gem'] }

    a.clock.advance(179 * DAY) // gem has been away less than the retention: nothing goes
    expect(purgeTombstones(a.handles.notes, options)).toBe(0)
    a.clock.advance(5 * DAY) // past the retention, but gem has not pulled the delete
    expect(purgeTombstones(a.handles.notes, options)).toBe(0)
    expect(a.notes.notes.getNote(note.id, true)?.deleted).toBe(1)

    link.up()
    await settle(a, b, link)
    expect(b.notes.notes.getNote(note.id)).toBeNull() // not resurrected
    // Peers never heard from keep it too; so does a retention not yet reached.
    expect(
      purgeTombstones(a.handles.notes, { retentionMs: 180 * DAY, peers: ['gem', 'third'] }),
    ).toBe(0)
    expect(purgeTombstones(a.handles.notes, { retentionMs: 365 * DAY, peers: ['gem'] })).toBe(0)
    expect(purgeTombstones(a.handles.notes, options)).toBe(1)
    expect(a.notes.notes.getNote(note.id, true)).toBeNull()
    await settle(a, b, link)
    expect(b.notes.notes.getNote(note.id)).toBeNull()
  })
})

describe('view state', () => {
  it('tabs, links, settings and seen times follow the owner; a deleted tab is deleted everywhere', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    const pane = a.web.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'claude' })
    a.web.link('s1s1s1s1', pane.id, 'shell')
    a.web.upsertProjectSettings('aico', { enabled: true, activeMode: 'codex' })
    a.web.markSeen(['s1s1s1s1'], 100)
    b.web.markSeen(['s1s1s1s1'], 200)
    await settle(a, b, link)
    expect(b.web.listPanes().map((p) => p.name)).toEqual(['Aico'])
    expect(b.web.getLink('s1s1s1s1')?.pane_id).toBe(pane.id)
    expect(b.web.allProjectSettings().get('aico')).toMatchObject({
      enabled: true,
      active_mode: 'codex',
    })
    expect(a.web.seenAt().get('s1s1s1s1')).toBe(200) // the larger of the two
    expect(b.web.seenAt().get('s1s1s1s1')).toBe(200)
    b.web.markSeen(['s1s1s1s1'], 50)
    await settle(a, b, link)
    expect(a.web.seenAt().get('s1s1s1s1')).toBe(200)

    b.clock.advance(MINUTE)
    b.web.updatePane(pane.id, { name: 'Renamed on gem' })
    await settle(a, b, link)
    expect(a.web.getPane(pane.id)?.name).toBe('Renamed on gem')

    a.clock.advance(MINUTE)
    expect(a.web.deletePane(pane.id)).toBe(true)
    a.web.pruneProjectSettings(new Set(['other']))
    await settle(a, b, link)
    expect(b.web.getPane(pane.id)).toBeNull()
    expect(b.web.listLinks()).toEqual([])
    expect(b.web.allProjectSettings().size).toBe(0)
    expect(dump(a.handles.web)).toEqual(dump(b.handles.web))
    // The tombstones are rows, so a late peer still hears of them.
    expect(
      changesSince(a.handles.web, 0, 100).rows.some(
        (r) => r.table === 'panes' && r.row.deleted === 1,
      ),
    ).toBe(true)
  })
})

describe('a different build', () => {
  it('pauses sync on a schema mismatch and local use goes on', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    b.notes.notes.create({ title: 'from the new build' })
    const real = transport(a, b, link)
    const newer = {
      ...real,
      hello: async () => {
        const hello = await real.hello()
        for (const set of Object.values(hello.sets)) set.schema_version += 1
        return hello
      },
    }
    const result = await pullSet(a.handles.notes, newer)
    expect(result.status).toBe('schema_mismatch')
    expect(a.notes.notes.list().total).toBe(0)
    expect(readPeer(a.handles.notes, 'gem')?.status).toBe('schema_mismatch')
    a.notes.notes.create({ title: 'still works' })
    expect(a.notes.notes.list().total).toBe(1)
    // Back on the same build, it resumes.
    expect((await pull(a, b, link)).notes.status).toBe('ok')
    expect(a.notes.notes.list().total).toBe(2)
  })

  it('reports the clock difference to the peer', async () => {
    const a = host('workstation')
    const b = host('gem')
    b.clock.advance(7_000)
    const result = (await pull(a, b, new Link())).notes
    expect(result.skewMs).toBe(7_000)
    expect(readPeer(a.handles.notes, 'gem')?.skew_ms).toBe(7_000)
  })
})

describe('photos', () => {
  it('lists the blobs live rows need and this host lacks', async () => {
    const a = host('workstation')
    const b = host('gem')
    const note = a.notes.notes.create({ title: 'Receipt' })
    const h1 = '1'.repeat(64)
    const h2 = '2'.repeat(64)
    const h3 = '3'.repeat(64)
    const h4 = '4'.repeat(64)
    for (const hash of [h1, h2, h3])
      a.notes.insertCapture({
        clientId: `c-${hash[0]}`,
        kind: 'image',
        name: 'x.jpg',
        mime: 'image/jpeg',
        size: 1,
        hash,
      })
    const gone = a.notes.listCaptures().captures.find((c) => c.hash === h3)
    a.notes.tombstoneCapture(gone?.id as string)
    a.notes.notes.attach(note.id, {
      captureId: 'cafe00000000',
      hash: h4,
      name: 'y.jpg',
      mime: 'image/jpeg',
      size: 1,
    })
    await settle(a, b, new Link())
    const have = new Set([h1])
    expect(missingBlobs(b.handles.notes, (hash) => have.has(hash))).toEqual([h2, h4])
    expect(missingBlobs(a.handles.notes, () => true)).toEqual([])
  })
})
