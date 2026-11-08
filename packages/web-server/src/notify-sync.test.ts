// The one notification list across full Aicos: two stores pulling from each other as the sync loop
// does, with a phone that counts what it receives.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NOTIFY_SCHEMA_VERSION,
  NotifyStore,
  Outbox,
  type PhoneSender,
  parseNotice,
  SYNC_SETTLE_MS,
} from '@aico/notify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { holdingFor, type SenderPeer } from './notify'
import { pullSet, type SyncHandle, serveChanges, serveHello } from './sync/engine'
import { NOTIFY_SYNC_TABLES } from './sync/registry'

let dir: string
const opened: NotifyStore[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notify-sync-'))
})
afterEach(() => {
  for (const store of opened.splice(0)) store.close()
  rmSync(dir, { recursive: true, force: true })
})

const T0 = Date.UTC(2026, 10, 8, 15, 0, 30)

/** One Aico: its store, its outbox and what it sent. */
function aico(host: string, device: string) {
  const store = new NotifyStore(join(dir, `${host}.db`), { hostName: host })
  opened.push(store)
  const pushes: string[] = []
  const state = { holding: null as string | null, now: T0 }
  const sender: PhoneSender = {
    devices: () => [{ id: device, fcmToken: '', encPub: '', auth: '' }],
    send: async (_device, plaintext) => {
      pushes.push(JSON.parse(plaintext.toString('utf8')).id)
      return 'sent'
    },
  }
  const outbox = new Outbox({
    store,
    sender,
    publicHost: null,
    holding: () => state.holding,
    now: () => state.now,
  })
  const handle = {
    ...store.syncParts(),
    set: 'notify',
    tables: NOTIFY_SYNC_TABLES,
    schemaVersion: () => NOTIFY_SCHEMA_VERSION,
    afterApply: (touched: { table: string; row: Record<string, unknown> }[]) => {
      store.takeSynced(
        touched.flatMap(({ table, row }) =>
          table === 'notices'
            ? [{ table, id: String(row.id) }]
            : table === 'notice_sends'
              ? [{ table, id: String(row.notice_id) }]
              : [],
        ),
        [device],
        state.now,
      )
    },
  }
  return { host, store, outbox, pushes, state, handle, device }
}
type Aico = ReturnType<typeof aico>

async function pull(to: Aico, from: Aico) {
  const source: SyncHandle = from.handle
  return pullSet(to.handle as SyncHandle, {
    hello: async () => serveHello([source], from.host, Date.now()),
    changes: async ({ since, limit, peer }) => serveChanges(source, { since, limit, peer }),
  })
}

async function sync(a: Aico, b: Aico) {
  await pull(a, b)
  await pull(b, a)
}

const phone = (over: Record<string, unknown> = {}) =>
  parseNotice({
    v: 1,
    source: 'aico',
    kind: 'alert',
    severity: 'critical',
    title: 'Backup still failing',
    body: 'The copy failed again.',
    push: 'phone',
    interrupt: 'data-risk',
    ...over,
  })

function raise(on: Aico, over: Record<string, unknown> = {}, now = on.state.now) {
  return on.store.accept({ ...phone(over), raised_by: on.host }, 'local', [on.device], now)
}

describe('one list across Aicos', () => {
  it('a standby holds what it raised; the primary sends it once and the word comes back', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    gem.state.holding = 'workstation'
    const { id } = raise(gem)
    expect(await gem.outbox.pass()).toBe(0)

    await sync(ws, gem)
    expect(ws.store.get(id)?.notice.raised_by).toBe('gem')
    // It waits a moment, so word that it went can catch up.
    expect(await ws.outbox.pass()).toBe(0)
    ws.state.now += SYNC_SETTLE_MS + 1
    expect(await ws.outbox.pass()).toBe(1)

    await sync(ws, gem)
    gem.state.holding = null
    gem.state.now = ws.state.now
    expect(await gem.outbox.pass()).toBe(0)
    expect(ws.pushes).toEqual([id])
    expect(gem.pushes).toEqual([])
    expect(gem.store.get(id)?.deliveries[0]).toMatchObject({ state: 'sent', device: 'workstation' })
  })

  it('takes over when the sender is gone, sends only what was not sent, and hands back clean', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    gem.state.holding = 'workstation'
    const sent = raise(ws, { title: 'Sent before the machine went off' })
    await ws.outbox.pass()
    await sync(ws, gem)
    // Raised while the workstation is still the sender, then it goes off before sending.
    const held = raise(ws, { title: 'Raised, never sent' })
    await sync(ws, gem)

    gem.state.holding = null
    gem.state.now += SYNC_SETTLE_MS + 1
    const alone = raise(gem, { title: 'Raised while the workstation is off' }, gem.state.now)
    expect(await gem.outbox.pass()).toBe(2)
    expect(gem.pushes.sort()).toEqual([held.id, alone.id].sort())
    expect(gem.pushes).not.toContain(sent.id)

    // Back on: the first sync comes before its first pass, and nothing goes twice.
    await sync(ws, gem)
    ws.state.now = gem.state.now + 10 * SYNC_SETTLE_MS
    expect(await ws.outbox.pass()).toBe(0)
    expect(ws.pushes).toEqual([sent.id])
    expect(ws.store.since(0)).toHaveLength(3)
    expect(gem.store.since(0)).toHaveLength(3)
  })

  it('the same event from two Aicos in the same minute is one entry and one push', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    gem.state.holding = 'workstation'
    const one = raise(ws, { key: 'status-sustained:a/backup' })
    const two = raise(gem, { key: 'status-sustained:a/backup' })
    expect(two.id).toBe(one.id)
    await ws.outbox.pass()
    await sync(ws, gem)
    ws.state.now += SYNC_SETTLE_MS + 1
    await ws.outbox.pass()
    expect(ws.store.since(0)).toHaveLength(1)
    expect(gem.store.since(0)).toHaveLength(1)
    expect(ws.pushes).toEqual([one.id])
  })

  it('a keyed event raised either side of a minute reaches the phone once', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    gem.state.holding = 'workstation'
    const later = raise(gem, { key: 'status-sustained:a/backup' }, T0 + 40_000)
    const first = raise(ws, { key: 'status-sustained:a/backup' })
    expect(later.id).not.toBe(first.id)
    ws.state.now = T0 + 40_000
    await ws.outbox.pass()
    await sync(ws, gem)
    ws.state.now += SYNC_SETTLE_MS + 1
    await ws.outbox.pass()
    expect(ws.pushes).toEqual([first.id])
  })

  it('a push the sender dropped for a switch that went off leaves the other Aico too', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    gem.state.holding = 'workstation'
    const { id } = raise(gem)
    await sync(ws, gem)
    const stored = ws.store.get(id)
    if (!stored) throw new Error('no row')
    ws.store.rewriteNotice(id, { ...stored.notice, push: 'tray', phone_silenced: 'off' })
    await sync(ws, gem)
    gem.state.holding = null
    gem.state.now += SYNC_SETTLE_MS + 1
    expect(await gem.outbox.pass()).toBe(0)
  })

  it('reads and Mark all read travel; notices from before the list stay where they are', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    const { id } = raise(ws)
    ws.store.markRead([id], 'tray', T0)
    ws.store.markAllRead(T0 - 5)
    await sync(ws, gem)
    const marks = gem.store.readMarks()
    expect(marks.readAllAt).toBe(T0 - 5)
    expect(marks.reads.get(id)).toBe(T0)
    gem.store.markAllRead(T0 + 5)
    await sync(ws, gem)
    expect(ws.store.readMarks().readAllAt).toBe(T0 + 5)
  })
})

describe('who sends', () => {
  const rule = (peers: SenderPeer[], over = {}) =>
    holdingFor({
      hostName: 'gem',
      standby: true,
      peers: () => peers,
      aliveMs: 150_000,
      settleMs: 30_000,
      startedAt: 0,
      now: () => 1_000_000,
      ...over,
    })
  const peer = (over: Partial<SenderPeer> = {}): SenderPeer => ({
    host: 'workstation',
    state: 'ok',
    lastSyncAt: 990_000,
    ...over,
  })

  it('a standby holds while its primary answers and syncs', () => {
    expect(rule([peer()])).toBe('workstation')
  })

  it('a standby sends when the primary is off, silent or out of step, so nothing is lost', () => {
    expect(rule([peer({ state: 'down' })])).toBeNull()
    expect(rule([peer({ state: 'paused' })])).toBeNull()
    expect(rule([peer({ state: 'error' })])).toBeNull()
    expect(rule([peer({ lastSyncAt: 800_000 })])).toBeNull()
    expect(rule([])).toBeNull()
  })

  it('the primary always sends, whatever its peers say', () => {
    const me = { hostName: 'workstation', standby: false }
    expect(rule([peer({ host: 'gem', standby: true })], me)).toBeNull()
  })

  it('more than two: one sender among the standbys, by name, none waiting on the other', () => {
    const third = { hostName: 'zen', standby: true }
    const gem = peer({ host: 'gem', standby: true })
    expect(rule([gem], third)).toBe('gem')
    expect(rule([peer({ host: 'zen', standby: true })])).toBeNull()
  })

  it('after a start it waits for the first sync, but not for long', () => {
    expect(rule([peer({ state: 'waiting' })], { now: () => 10_000, startedAt: 0 })).toBe(
      'The first sync',
    )
    expect(rule([peer({ state: 'waiting' })], { now: () => 40_000, startedAt: 0 })).toBeNull()
  })
})
