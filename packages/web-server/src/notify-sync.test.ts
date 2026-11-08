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
  const state = { holding: null as { by: string; firm?: boolean } | null, now: T0 }
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
  return { host, store, outbox, sender, pushes, state, handle, device }
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
    gem.state.holding = { by: 'workstation' }
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
    gem.state.holding = { by: 'workstation' }
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
    gem.state.holding = { by: 'workstation' }
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

  /** Each store marked so its next raise under the key differs: a list from before the sync. */
  const unsynced = (who: Aico) => who.handle.db.exec('UPDATE notices SET seq = 0')

  it('the sender failing for good, learned together with the notice: this Aico still tries', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    const { id } = raise(ws)
    const [row] = ws.store.claimDue(T0)
    if (!row) throw new Error('no row')
    ws.store.finish(row.id, { state: 'failed', result: 'rejected:403' }, T0)
    await sync(ws, gem)
    gem.state.now += SYNC_SETTLE_MS + 1
    expect(await gem.outbox.pass()).toBe(1)
    expect(gem.pushes).toEqual([id])
  })

  it('a row is claimed only right before its send, so a restart leaves one unsure at most', async () => {
    const ws = aico('workstation', 'phone-1')
    raise(ws, { title: 'One' })
    raise(ws, { title: 'Two' })
    const inFlight: number[] = []
    const send = ws.sender.send
    ws.sender.send = async (...args) => {
      const { n } = ws.handle.db
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE state = 'sending'`)
        .get() as { n: number }
      inFlight.push(Number(n))
      return send(...args)
    }
    expect(await ws.outbox.pass()).toBe(2)
    expect(inFlight).toEqual([1, 1])
  })

  it('an earlier entry still retrying is no word; once one goes, the other stands down everywhere', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    const key = { key: 'status-sustained:a/backup' }
    const first = raise(ws, key)
    const [row] = ws.store.claimDue(T0)
    if (!row) throw new Error('no row')
    ws.store.finish(row.id, { retryAt: T0 + 60_000, result: 'retry' }, T0)
    unsynced(ws)
    gem.state.holding = { by: 'workstation' }
    gem.state.now = T0 + 60_000
    const later = raise(gem, key)
    await sync(ws, gem)
    expect(gem.store.get(later.id)?.deliveries[0]?.state).toBe('pending')
    ws.state.now = T0 + 60_000 + SYNC_SETTLE_MS + 1
    expect(await ws.outbox.pass()).toBe(1)
    expect(ws.pushes).toEqual([first.id])
    await sync(ws, gem)
    gem.state.holding = null
    gem.state.now += 10 * 60_000
    expect(await gem.outbox.pass()).toBe(0)
    expect(gem.pushes).toEqual([])
  })

  it('word arriving mid-send: a retry after it is dropped, not stuck', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    const { id } = raise(gem)
    await sync(ws, gem)
    ws.state.now += SYNC_SETTLE_MS + 1
    const [row] = ws.store.claimDue(ws.state.now)
    if (!row) throw new Error('no row')
    await gem.outbox.pass()
    await sync(ws, gem)
    ws.store.finish(row.id, { retryAt: ws.state.now, result: 'retry' }, ws.state.now)
    expect(await ws.outbox.pass()).toBe(0)
    expect(ws.store.outboxSummary(0).pending).toBe(0)
    expect(gem.pushes).toEqual([id])
    expect(ws.pushes).toEqual([])
  })

  it("sent stays sent when another Aico's failure comes later", async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    const { id } = raise(ws)
    gem.store.accept(phone(), 'local', ['proxmox'], T0)
    await ws.outbox.pass()
    const [row] = gem.store.claimDue(T0)
    if (!row) throw new Error('no row')
    gem.store.finish(row.id, { state: 'failed', result: 'rejected:403' }, T0 + 5_000)
    await sync(ws, gem)
    await sync(ws, gem)
    const said = (who: Aico) =>
      who.handle.db.prepare('SELECT state, sent_by FROM notice_sends WHERE notice_id = ?').get(id)
    expect({ ...said(ws) }).toEqual({ state: 'sent', sent_by: 'workstation' })
    expect({ ...said(gem) }).toEqual({ state: 'sent', sent_by: 'workstation' })
  })

  it('a keyed event is one entry whatever the minute', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    gem.state.holding = { by: 'workstation' }
    const first = raise(ws, { key: 'status-sustained:a/backup' })
    const later = raise(gem, { key: 'status-sustained:a/backup' }, T0 + 40_000)
    expect(later.id).toBe(first.id)
    await ws.outbox.pass()
    await sync(ws, gem)
    expect(ws.pushes).toEqual([first.id])
    expect(gem.store.since(0)).toHaveLength(1)
  })

  it('an earlier entry the other Aico lacks: the raiser of the later one never pushes it', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    const key = { key: 'status-sustained:a/backup' }
    raise(ws, key)
    await ws.outbox.pass()
    unsynced(ws)
    gem.state.holding = { by: 'workstation' }
    gem.state.now = T0 + 60_000
    const held = raise(gem, key)
    await sync(ws, gem)
    gem.state.now += 10 * 60_000
    gem.state.holding = null
    expect(await gem.outbox.pass()).toBe(0)
    expect(gem.store.get(held.id)?.deliveries[0]?.state).toBe('sent')
    expect(ws.pushes).toHaveLength(1)
  })

  it('raised on both with different lists, whichever was sent first: one push', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    const key = { key: 'status-sustained:a/backup' }
    // The workstation has an old recovery under the key, the standby doesn't.
    raise(ws, { ...key, severity: 'ok', kind: 'info', push: 'tray', interrupt: undefined })
    unsynced(ws)
    gem.state.holding = { by: 'workstation' }
    gem.state.now = T0 + 60_000
    ws.state.now = T0 + 61_000
    const early = raise(gem, key)
    const late = raise(ws, key)
    expect(late.id).not.toBe(early.id)
    expect(await ws.outbox.pass()).toBe(1)
    await sync(ws, gem)
    ws.state.now += SYNC_SETTLE_MS + 1
    expect(await ws.outbox.pass()).toBe(0)
    gem.state.now += 10 * 60_000
    gem.state.holding = null
    expect(await gem.outbox.pass()).toBe(0)
    expect(ws.pushes).toEqual([late.id])
    expect(gem.pushes).toEqual([])
  })

  it('a holder sends anyway when no word comes: a one-way link or a sender that never sends', async () => {
    const gem = aico('gem', 'proxmox')
    gem.state.holding = { by: 'workstation' }
    const { id } = raise(gem)
    expect(await gem.outbox.pass()).toBe(0)
    gem.state.now += 2 * 60_000
    expect(await gem.outbox.pass()).toBe(0)
    gem.state.now += 60_000 + 1
    expect(await gem.outbox.pass()).toBe(1)
    expect(gem.pushes).toEqual([id])
  })

  it('firm hold: right after a start nothing goes, however old', async () => {
    const ws = aico('workstation', 'phone-1')
    raise(ws)
    ws.state.holding = { by: 'The first sync', firm: true }
    ws.state.now += 10 * 60_000
    expect(await ws.outbox.pass()).toBe(0)
  })

  it('the sender failing for good leaves the holder its own route', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    gem.state.holding = { by: 'workstation' }
    const { id } = raise(gem)
    await sync(ws, gem)
    ws.state.now += SYNC_SETTLE_MS + 1
    const [row] = ws.store.claimDue(ws.state.now)
    if (!row) throw new Error('no row')
    ws.store.finish(row.id, { state: 'failed', result: 'rejected:403' }, ws.state.now)
    await sync(ws, gem)
    gem.state.holding = null
    gem.state.now += SYNC_SETTLE_MS + 1
    expect(await gem.outbox.pass()).toBe(1)
    expect(gem.pushes).toEqual([id])
  })

  it('no word until every phone on the sender has an outcome', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    const { id } = ws.store.accept(phone(), 'local', ['phone-1', 'phone-2'], T0)
    const [one, two] = ws.store.claimDue(T0)
    if (!one || !two) throw new Error('no rows')
    ws.store.finish(one.id, { state: 'sent', result: 'sent' }, T0)
    await sync(ws, gem)
    gem.state.now += SYNC_SETTLE_MS + 1
    expect(await gem.outbox.pass()).toBe(1) // the sender is gone with phone-2 unsettled
    ws.store.finish(two.id, { retryAt: T0 + 1, result: 'no-token' }, T0)
    expect(gem.pushes).toEqual([id])
  })

  it('a restart mid-send tells the others, so a takeover never sends it again', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    gem.state.holding = { by: 'workstation' }
    const { id } = raise(ws)
    ws.store.claimDue(T0)
    expect(ws.outbox.recover()).toBe(1)
    await sync(ws, gem)
    gem.state.holding = null
    gem.state.now += SYNC_SETTLE_MS + 1
    expect(await gem.outbox.pass()).toBe(0)
    expect(gem.store.get(id)?.deliveries[0]?.state).toBe('unsure')
  })

  it('a takeover never sends a row past the give-up age', async () => {
    const gem = aico('gem', 'proxmox')
    raise(gem)
    gem.state.now += 25 * 3600_000
    expect(await gem.outbox.pass()).toBe(0)
    expect(gem.pushes).toEqual([])
  })

  it('problem, recovery, problem, recovery in one minute: each one counts', () => {
    const gem = aico('gem', 'proxmox')
    const key = { key: 'status-sustained:a/backup' }
    const ok = { ...key, severity: 'ok', kind: 'info', push: 'tray', interrupt: undefined }
    const ids = [
      raise(gem, key, T0),
      raise(gem, ok, T0 + 10),
      raise(gem, key, T0 + 20),
      raise(gem, ok, T0 + 30),
    ].map((one) => one.id)
    expect(new Set(ids).size).toBe(4)
  })

  it('an ask stays on the Aico whose Tether holds it', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    const { id } = raise(gem)
    gem.store.setAsk(id, 'ask-on-gem')
    gem.store.answer(id, 'That was me', T0)
    raise(gem, { title: 'Another, so the sync moves on' })
    await sync(ws, gem)
    expect(ws.store.get(id)?.askId).toBeNull()
    ws.store.rewriteNotice(id, { ...phone(), title: 'Changed on the workstation' })
    await sync(ws, gem)
    expect(gem.store.get(id)?.notice.title).toBe('Changed on the workstation')
    expect(gem.store.get(id)?.askId).toBe('ask-on-gem')
    expect(gem.store.get(id)?.answer).toBe('That was me')
  })

  it('a push the sender dropped for a switch that went off leaves the other Aico too', async () => {
    const ws = aico('workstation', 'phone-1')
    const gem = aico('gem', 'proxmox')
    gem.state.holding = { by: 'workstation' }
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
    expect(rule([peer()])).toEqual({ by: 'workstation' })
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
    expect(rule([gem], third)).toEqual({ by: 'gem' })
    expect(rule([peer({ host: 'zen', standby: true })])).toBeNull()
  })

  it('after a start nothing goes until the first clean sync, but not for long', () => {
    const early = { now: () => 10_000, startedAt: 0 }
    const firm = { by: 'The first sync', firm: true }
    expect(rule([peer({ state: 'waiting', lastSyncAt: null })], early)).toEqual(firm)
    expect(rule([peer({ state: 'down', lastSyncAt: null })], early)).toEqual(firm)
    expect(rule([peer({ state: 'waiting', lastSyncAt: null })], { now: () => 40_000 })).toBeNull()
  })
})
