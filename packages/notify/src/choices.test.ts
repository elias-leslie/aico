// The owner's Settings choices at the door: they beat the rule and every sender, stop only the pop,
// and apply to the next notice and to a push still queued.

import { describe, expect, it } from 'vitest'
import { desktopCard, desktopOff, type NoticeChannel, type NoticeChoices } from './choices'
import { parseNotice } from './notice'
import { Notifier } from './notifier'
import { Outbox } from './outbox'
import { NotifyStore } from './store'
import { describeType, NOTICE_TYPES, typeOf, validTypeId } from './types'

const phone = { id: 'p1', fcmToken: 't', encPub: 'e', auth: 'a' }

function harness(
  saved: Record<string, Partial<Record<NoticeChannel, boolean>>> = {},
  at = () => 1_000,
) {
  const store = new NotifyStore(':memory:')
  const choices: NoticeChoices = { choice: (type, channel) => saved[type]?.[channel] ?? null }
  const sent: string[] = []
  const sender = {
    devices: () => [phone],
    send: async (_device: unknown, plain: Buffer) => {
      sent.push(JSON.parse(plain.toString()).title)
      return 'sent' as const
    },
  }
  const asks: string[] = []
  const outbox = new Outbox({ store, sender: sender as never, publicHost: null, choices, now: at })
  const notifier = new Notifier({
    store,
    sender: sender as never,
    outbox: { kick: async () => 0 } as never,
    needsYou: {
      noticeAccepted: async (id: string) => {
        asks.push(id)
      },
    } as never,
    choices,
    now: at,
    log: () => {},
  })
  return { store, notifier, outbox, sent, asks, saved }
}

const waiting = {
  v: 1,
  source: 'aico',
  kind: 'alert',
  severity: 'warning',
  title: 'Claude Code waiting in x',
  body: 'x',
  key: 'aico-waiting:abcd1234',
  interrupt: 'needs-you',
}
const followUps = {
  v: 1,
  source: 'jobinator-4000',
  kind: 'todo',
  severity: 'warning',
  title: 'Follow-ups due',
  body: 'x',
  key: 'jobinator:1',
}

describe('a type switched off for the phone', () => {
  it('queues no push and still logs the notice and files its ask', async () => {
    const h = harness({ 'agent-waiting': { phone: false } })
    const { id } = h.notifier.receive(waiting, 'local')
    const stored = h.store.get(id)
    expect(stored?.deliveries).toEqual([])
    expect(stored?.notice).toMatchObject({ push: 'tray', phone_silenced: expect.any(String) })
    expect(stored?.notice.phone_reason).toBeUndefined()
    await Promise.resolve()
    expect(h.asks).toEqual([id])
  })

  it('drops a push still queued when the switch goes off, and fails nothing', async () => {
    const h = harness()
    const { id } = h.notifier.receive(waiting, 'local')
    expect(h.store.get(id)?.deliveries).toHaveLength(1)
    h.saved['agent-waiting'] = { phone: false }
    await h.outbox.pass()
    expect(h.sent).toEqual([])
    expect(h.store.get(id)?.deliveries).toEqual([])
    expect(h.store.get(id)?.notice).toMatchObject({
      push: 'tray',
      phone_silenced: expect.any(String),
    })
    expect(h.store.get(id)?.notice.phone_reason).toBeUndefined()
    expect(h.outbox.statusRow('m', 1000).state).not.toBe('failed')
  })

  it('applies from the next notice on, with no restart', () => {
    const h = harness()
    const first = h.notifier.receive(waiting, 'local')
    h.saved['agent-waiting'] = { phone: false }
    const second = h.notifier.receive({ ...waiting, key: 'aico-waiting:bbbb1234' }, 'local')
    h.saved['agent-waiting'] = { phone: true }
    const third = h.notifier.receive({ ...waiting, key: 'aico-waiting:cccc1234' }, 'local')
    expect(h.store.get(first.id)?.deliveries).toHaveLength(1)
    expect(h.store.get(second.id)?.deliveries).toHaveLength(0)
    expect(h.store.get(third.id)?.deliveries).toHaveLength(1)
  })
})

describe('a row the table keeps off', () => {
  const asks = { ...followUps, interrupt: 'needs-you' }

  it('stops a sender who asks for the phone, as the row shows', () => {
    const h = harness()
    const { id } = h.notifier.receive(asks, 'local')
    expect(h.store.get(id)?.deliveries).toEqual([])
    expect(h.store.get(id)?.notice.phone_silenced).toBeDefined()
  })

  it('reaches the phone once the owner turns it on', () => {
    const h = harness({ jobinator: { phone: true } })
    expect(h.store.get(h.notifier.receive(asks, 'local').id)?.deliveries).toHaveLength(1)
  })
})

describe('the Tests row', () => {
  it('never pushes an agent test by the switch alone', () => {
    const h = harness({ tests: { phone: true, desktop: true } })
    const { id } = h.notifier.receive(
      { ...followUps, source: 'zz-toast-test', key: 'zz-toast-test:1' },
      'local',
    )
    expect(h.store.get(id)?.deliveries).toEqual([])
  })
})

describe('a type switched on for the phone', () => {
  it('reaches the phone though the sender gave no reason, and says why', () => {
    const h = harness({ jobinator: { phone: true } })
    const { id } = h.notifier.receive(followUps, 'local')
    const stored = h.store.get(id)
    expect(stored?.deliveries).toHaveLength(1)
    expect(stored?.notice).toMatchObject({ push: 'phone', phone_reason: expect.any(String) })
  })

  it('never pushes an ok: a recovery only ends the earlier notice', () => {
    const h = harness({ jobinator: { phone: true } })
    const { id } = h.notifier.receive({ ...followUps, kind: 'info', severity: 'ok' }, 'local')
    expect(h.store.get(id)?.deliveries).toEqual([])
  })
})

describe('the daily phone limit', () => {
  const school = {
    v: 1,
    source: 'school-check',
    kind: 'info',
    severity: 'warning',
    title: 'School',
    body: 'x',
    key: 'school-check-2026-11-08',
    interrupt: 'reminder',
    cooldown: 0,
  }

  it('lets one school check a day reach the phone; the rest stay in the tray', () => {
    let at = new Date(2026, 10, 8, 9).getTime()
    const h = harness({}, () => at)
    const first = h.notifier.receive(school, 'local')
    at += 3600_000
    const second = h.notifier.receive(school, 'local')
    at = new Date(2026, 10, 9, 9).getTime()
    const nextDay = h.notifier.receive({ ...school, key: 'school-check-2026-11-09' }, 'local')
    expect(h.store.get(first.id)?.deliveries).toHaveLength(1)
    expect(h.store.get(second.id)?.deliveries).toEqual([])
    expect(h.store.get(second.id)?.notice.phone_silenced).toMatch(/today/)
    expect(h.store.get(nextDay.id)?.deliveries).toHaveLength(1)
  })

  it('does not count a push dropped from the queue against the day', async () => {
    const at = new Date(2026, 10, 8, 9).getTime()
    const h = harness({}, () => at)
    h.notifier.receive(school, 'local')
    h.saved['school-check'] = { phone: false }
    await h.outbox.pass()
    h.saved['school-check'] = {}
    const again = h.notifier.receive({ ...school, key: 'school-check-2' }, 'local')
    expect(h.store.get(again.id)?.deliveries).toHaveLength(1)
  })
})

describe('the desktop switch', () => {
  const choose = (value: boolean | null): NoticeChoices => ({ choice: () => value })

  it('follows the rule with no choice, and beats it either way', () => {
    const asks = parseNotice(followUps)
    const row = parseNotice({ ...followUps, kind: 'alert', source: 'aico', key: 'status:1' })
    expect(desktopCard(asks, choose(null))).toBe(true)
    expect(desktopCard(asks, choose(false))).toBe(false)
    expect(desktopCard(row, choose(null))).toBe(false)
    expect(desktopCard(row, choose(true))).toBe(true)
    expect(desktopOff('approval', choose(false))).toBe(true)
  })

  it('never pops an ok', () => {
    const ok = parseNotice({ ...followUps, kind: 'info', severity: 'ok' })
    expect(desktopCard(ok, choose(true))).toBe(false)
  })
})

describe('a choice that cannot be read', () => {
  it('decides nothing, so no notice is lost', () => {
    const notice = parseNotice(waiting)
    const broken: NoticeChoices = {
      choice: () => {
        throw new Error('disk')
      },
    }
    expect(desktopCard(notice, broken)).toBe(true)
    const h = harness()
    const notifier = new Notifier({
      store: h.store,
      sender: { devices: () => [phone] } as never,
      outbox: { kick: async () => 0 } as never,
      needsYou: { noticeAccepted: async () => {} } as never,
      choices: broken,
      log: () => {},
    })
    expect(h.store.get(notifier.receive(waiting, 'local').id)?.deliveries).toHaveLength(1)
  })
})

describe('the types', () => {
  const of = (notice: object) =>
    typeOf(parseNotice({ v: 1, body: 'x', title: 'T', severity: 'warning', ...notice }))
  const page = {
    source: 'ominull',
    kind: 'alert',
    severity: 'critical',
    title: 'Security alert on h',
    key: 'alerts:7c1d2e3f',
  }

  it('splits OmniNull pages into lab and real machines', () => {
    expect(of(page)).toBe('security-real')
    expect(of({ ...page, lab: true })).toBe('security-lab')
    expect(of({ ...page, fields: [{ label: 'Rule', value: 'lab escape' }] })).toBe('security-lab')
  })

  it('files the senders the data shows', () => {
    expect(of({ source: 'aico', key: 'aico-waiting:x' })).toBe('agent-waiting')
    expect(of({ source: 'aico', kind: 'question', key: 'ask:x' })).toBe('agent-question')
    expect(of({ source: 'aico', key: 'approve:elevate:1' })).toBe('approval')
    expect(of({ source: 'school-check', key: 'school-check-2026-11-08' })).toBe('school-check')
    expect(of({ source: 'aico', key: 'digest:2026-11-08' })).toBe('digest')
    expect(of({ source: 'jobinator-4000', key: 'jobinator:1' })).toBe('jobinator')
    expect(of({ source: 'portfolio-ai', key: 'portfolio-ai:1' })).toBe('portfolio')
    expect(of({ source: 'aico', key: 'status-sustained:a', interrupt: 'data-risk' })).toBe('backup')
    expect(of({ source: 'aico', key: 'status-sustained:a', interrupt: 'outage' })).toBe('outage')
    expect(of({ source: 'aico', key: 'status:abc' })).toBe('status')
    expect(of({ source: 'zz-toast-test', key: 'zz-toast-test:1' })).toBe('tests')
    expect(of({ source: 'agent', title: 'Test: my phone' })).toBe('tests')
  })

  it('gives a sender the table does not name its own row, and no way around a switch', () => {
    expect(of({ source: 'new-sender', interrupt: 'needs-you', severity: 'warning' })).toBe(
      'source:new-sender',
    )
    expect(describeType('source:new-sender').label).toBe('new-sender')
    expect(validTypeId('source:new-sender')).toBe(true)
    expect(validTypeId('source:../etc')).toBe(false)
    expect(validTypeId('nonsense')).toBe(false)
    const h = harness({ 'source:new-sender': { phone: false } })
    const { id } = h.notifier.receive(
      {
        v: 1,
        source: 'new-sender',
        title: 'T',
        body: 'x',
        severity: 'warning',
        interrupt: 'needs-you',
      },
      'local',
    )
    expect(h.store.get(id)?.deliveries).toEqual([])
  })

  it('lists every row once', () => {
    const ids = NOTICE_TYPES.map((type) => type.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
