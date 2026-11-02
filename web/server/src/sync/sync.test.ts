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

// -- Fixes from the fresh-context review of Milestone 5a ------------------------------

const live = (h: Host, title: string) => h.notes.notes.list().notes.filter((n) => n.title === title)

describe('restore, however far the restored host got', () => {
  // The peer's cursor on the restored host can end up below, at or above its new `seq`
  // (its own edits and what it pulls from the peer both raise it): all must be noticed.
  it.each([1, 5, 9])(
    'a host restored and then changed %i times is noticed; the peer starts over and gets its edits',
    async (edits) => {
      const a = host('workstation', { notesPath: join(dir, 'a-notes.db') })
      const b = host('gem')
      const link = new Link()
      const note = a.notes.notes.create({ title: 'N', body: 'v1' })
      await settle(a, b, link)
      backup(a.handles.notes, join(dir, 'backup.db'))
      const oldId = a.notes.meta('db_id')
      for (let i = 0; i < 5; i += 1) {
        a.clock.advance(1000)
        a.notes.notes.create({ title: `a${i}` })
        b.clock.advance(1000)
        b.notes.notes.create({ title: `b${i}` })
      }
      await settle(a, b, link)

      a.notes.close()
      a.web.close()
      hosts = hosts.filter((h) => h !== a)
      copyFileSync(join(dir, 'backup.db'), join(dir, 'a-notes.db'))
      const restored = host('workstation', { clock: a.clock, notesPath: join(dir, 'a-notes.db') })
      restored.clock.advance(MINUTE)
      restored.notes.notes.update(note.id, { body: 'edited after restore' })
      for (let i = 1; i < edits; i += 1) restored.notes.notes.create({ title: `r${i}` })
      await pull(restored, b, link) // the restored host's own loop ticks first
      await settle(restored, b, link)

      expect(restored.notes.meta('db_id')).not.toBe(oldId)
      for (const h of [restored, b]) {
        expect(h.notes.notes.getNote(note.id)?.body).toBe('edited after restore')
        expect(h.notes.notes.list().total).toBe(1 + 10 + (edits - 1))
      }
      expect(dump(restored.handles.notes)).toEqual(dump(b.handles.notes))
    },
  )
})

describe('a loser renamed for a unique value is a stamped edit', () => {
  /** Hosts each make a Groceries list; tried again until host A's id is the lower (A holds the keeper). */
  const groceriesWhereAHoldsKeeper = () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const a = host('workstation')
      const b = host('gem')
      const first = a.notes.notes.groceries()
      const second = b.notes.notes.groceries()
      if (first.id < second.id) return { a, b, first, second }
    }
    throw new Error('ids never sorted')
  }

  it('hosts settle the same after the keeper is deleted on the host that received the loser', async () => {
    const { a, b, first, second } = groceriesWhereAHoldsKeeper()
    const link = new Link()
    await pull(a, b, link) // A renames gem's list (the loser) without anything having been sent
    a.clock.advance(MINUTE)
    a.notes.notes.remove(first.id)
    await settle(a, b, link)
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
    expect(a.notes.notes.getNote(second.id)?.source).toBe(b.notes.notes.getNote(second.id)?.source)

    // The next grocery list is the surviving one on both hosts, not a third list.
    const file = {
      captureId: 'cap1',
      hash: 'f'.repeat(64),
      name: 'l.jpg',
      mime: 'image/jpeg',
      size: 1,
    }
    a.notes.notes.fileGroceries(file, [{ text: 'milk' }])
    b.clock.advance(MINUTE)
    b.notes.notes.fileGroceries({ ...file, captureId: 'cap2' }, [{ text: 'eggs' }])
    await settle(a, b, link)
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
    for (const h of [a, b]) {
      expect(live(h, 'Groceries').map((n) => n.id)).toEqual([second.id])
      expect(h.notes.notes.groceries().id).toBe(second.id)
      expect(itemTexts(h, second.id)).toEqual(['eggs', 'milk'])
    }
  })

  it('a capture renamed on the receiving host is the same row on both', async () => {
    let a: Host
    let b: Host
    let x: { id: string }
    let y: { id: string }
    const upload = {
      clientId: 'c1c1c1c1',
      kind: 'image',
      name: 'p.jpg',
      mime: 'image/jpeg',
      size: 1,
      hash: 'a'.repeat(64),
    } as const
    for (let attempt = 0; ; attempt += 1) {
      a = host('workstation')
      b = host('gem')
      x = a.notes.insertCapture(upload).capture
      y = b.notes.insertCapture(upload).capture
      if (x.id < y.id) break
      if (attempt > 60) throw new Error('ids never sorted')
    }
    const link = new Link()
    await pull(a, b, link)
    a.clock.advance(MINUTE)
    a.notes.tombstoneCapture(x.id)
    await settle(a, b, link)
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
    expect(a.notes.findByClientId('c1c1c1c1')?.id).toBe(b.notes.findByClientId('c1c1c1c1')?.id)
  })
})

describe('an upload retried against both doors is read once', () => {
  it('the duplicate is a tombstone: one live capture, and only its door claims it', async () => {
    const a = host('workstation')
    const b = host('gem')
    const upload = {
      clientId: 'c2c2c2c2',
      kind: 'image',
      name: 'p.jpg',
      mime: 'image/jpeg',
      size: 1,
      hash: 'b'.repeat(64),
    } as const
    const x = a.notes.insertCapture(upload).capture
    const y = b.notes.insertCapture(upload).capture
    await settle(a, b, new Link())
    const keeper = x.id < y.id ? x : y
    for (const h of [a, b]) {
      expect(h.notes.listCaptures().captures.map((c) => c.id)).toEqual([keeper.id])
      expect(h.notes.findByClientId('c2c2c2c2')?.id).toBe(keeper.id)
    }
    const claimed = [a, b].map((h) => h.notes.claimForExtraction()?.id ?? null)
    expect(claimed.filter((id) => id !== null)).toEqual([keeper.id])
    await settle(a, b, new Link())
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
  })
})

describe('a run of edits made apart is not a conflict', () => {
  it('the host that created the row pulls two edits of the other and keeps no revision', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    const note = b.notes.notes.create({ title: 'Plan', body: 'from gem' })
    await settle(a, b, link)
    for (const body of ['ws edit 1', 'ws edit 2', 'ws edit 3']) {
      a.clock.advance(MINUTE)
      a.notes.notes.update(note.id, { body })
    }
    await settle(a, b, link)
    expect(b.notes.notes.getNote(note.id)?.body).toBe('ws edit 3')
    expect(conflicts(b)).toEqual([])
    expect(conflicts(a)).toEqual([])
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
    // Going back the other way, from the middle of a chain, is the same.
    b.clock.advance(MINUTE)
    b.notes.notes.update(note.id, { body: 'gem again' })
    a.clock.advance(MINUTE)
    a.notes.notes.update(note.id, { title: 'Plan B' })
    await settle(a, b, link)
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
  })
})

describe('equal stamps on two hosts', () => {
  it('an edit whose base shares a millisecond with the other host is still a conflict, and is kept', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    const note = a.notes.notes.create({ title: 'T', body: 'start' })
    await settle(a, b, link)
    a.clock.advance(DAY)
    b.clock.advance(DAY)
    a.notes.notes.update(note.id, { body: 'A text' })
    b.notes.notes.update(note.id, { body: 'B text' })
    expect(a.notes.notes.getNote(note.id)?.updated_at).toBe(
      b.notes.notes.getNote(note.id)?.updated_at,
    )
    b.notes.notes.update(note.id, { body: 'B text 2' }) // built on the version that shares A's stamp
    await settle(a, b, link)
    for (const h of [a, b]) {
      expect(h.notes.notes.getNote(note.id)?.body).toBe('B text 2')
      expect(conflicts(h)).toContainEqual({ table_name: 'notes', field: 'body', text: 'A text' })
    }
    expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
  })
})

describe('a link to a deleted tab', () => {
  it('is no link on either host, though its row is kept', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    const pane = a.web.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'claude' })
    a.web.link('s0000001', pane.id, 'claude')
    await settle(a, b, link)
    link.down()
    a.clock.advance(MINUTE)
    a.web.deletePane(pane.id)
    b.clock.advance(2 * MINUTE)
    b.web.link('s0000002', pane.id, 'shell')
    link.up()
    await settle(a, b, link)
    for (const h of [a, b]) {
      expect(h.web.getPane(pane.id)).toBeNull()
      expect(h.web.listLinks()).toEqual([])
      expect(h.web.getLink('s0000002')).toBeNull()
      expect(h.web.linksForPane(pane.id)).toEqual([])
    }
    expect(dump(a.handles.web)).toEqual(dump(b.handles.web))
    // The session can be linked to a live tab again.
    const other = b.web.createPane({ projectId: 'aico', name: 'Again', activeMode: 'shell' })
    b.web.link('s0000002', other.id, 'shell')
    await settle(a, b, link)
    expect(a.web.getLink('s0000002')?.pane_id).toBe(other.id)
  })
})

describe('search after an item moves between notes', () => {
  it('finds the item only in the note that now holds it', async () => {
    const a = host('workstation')
    const b = host('gem')
    const link = new Link()
    const first = a.notes.notes.create({
      kind: 'list',
      title: 'First',
      items: [{ text: 'zucchini' }],
    })
    const second = a.notes.notes.create({ kind: 'list', title: 'Second' })
    await settle(a, b, link)
    expect(b.notes.notes.list({ q: 'zucchini' }).notes.map((n) => n.id)).toEqual([first.id])
    // The same item id arrives from the peer filed in the other note (as two doors
    // filing one capture into their own Groceries lists do).
    const item = changesSince(a.handles.notes, 0, 100).rows.find((r) => r.table === 'note_items')
    applyPage(b.handles.notes, [
      {
        table: 'note_items',
        row: { ...item?.row, note_id: second.id, updated_at: START + DAY, origin: 'workstation' },
      },
    ])
    expect(b.notes.notes.items(second.id).map((i) => i.text)).toEqual(['zucchini'])
    expect(b.notes.notes.list({ q: 'zucchini' }).notes.map((n) => n.id)).toEqual([second.id])
  })
})

describe('tombstone purge', () => {
  it('with no named peers purges nothing', async () => {
    const a = host('workstation')
    const note = a.notes.notes.create({ title: 'gone' })
    a.notes.notes.remove(note.id)
    a.clock.advance(400 * DAY)
    expect(purgeTombstones(a.handles.notes, { retentionMs: 180 * DAY, peers: [] })).toBe(0)
    expect(a.notes.notes.getNote(note.id, true)?.deleted).toBe(1)
  })
})

describe('random split brain', () => {
  // A small seeded storm: two hosts with skewed clocks edit the same notes, items and
  // labels while apart, pull each other at random, and must end with identical files.
  it.each(Array.from({ length: 12 }, (_, i) => i + 1))(
    'seed %i ends with identical dumps on both hosts',
    async (seed) => {
      let state = seed * 7919
      const random = (n: number) => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
        return Math.floor((state / 2_147_483_648) * n)
      }
      const a = host('workstation')
      const b = host('gem')
      b.clock.advance(random(5) * MINUTE - 2 * MINUTE)
      const link = new Link()
      const groceries = [a, b].map((h) => h.notes.notes.groceries()) // two lists, one name
      const ids = [a.notes.notes.create({ kind: 'list', title: 'Shared' }).id]
      await settle(a, b, link)
      for (let step = 0; step < 60; step += 1) {
        const h = random(2) === 0 ? a : b
        h.clock.advance(random(3) * 1000)
        const id = ids[random(ids.length)] as string
        const items = h.notes.notes.items(id)
        const item = items[random(items.length)]
        const action = random(9)
        if (action === 0) ids.push(h.notes.notes.create({ kind: 'list', title: `n${step}` }).id)
        else if (action === 1) h.notes.notes.update(id, { title: `t${step}${h.name}` })
        else if (action === 2) h.notes.notes.update(id, { body: `b${step}${h.name}` })
        else if (action === 3) h.notes.notes.addItem(id, { text: `i${step}${h.name}` })
        else if (action === 4 && item) h.notes.notes.updateItem(id, item.id, { text: `u${step}` })
        else if (action === 5 && item) h.notes.notes.removeItem(id, item.id)
        else if (action === 6) h.notes.notes.setLabels(id, [`l${random(3)}`])
        else if (action === 7 && random(4) === 0) h.notes.notes.remove(id)
        else if (action === 8)
          h.notes.notes.fileGroceries(
            {
              captureId: `cap${step}`,
              hash: 'e'.repeat(64),
              name: 'g.jpg',
              mime: 'image/jpeg',
              size: 1,
            },
            [{ text: `g${step}` }],
          )
        if (random(5) === 0) await (random(2) === 0 ? pull(a, b, link) : pull(b, a, link))
      }
      expect(groceries).toHaveLength(2)
      await settle(a, b, link)
      expect(dump(a.handles.notes)).toEqual(dump(b.handles.notes))
    },
  )
})
