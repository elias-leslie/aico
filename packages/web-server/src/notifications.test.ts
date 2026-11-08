import { type NoticeChannel, NotifyStore, parseNotice } from '@aico/notify'
import { describe, expect, it } from 'vitest'
import type { Router } from './http'
import { type ChoiceStore, registerNotificationRoutes } from './notifications'

class Memory implements ChoiceStore {
  rows = new Map<string, { phone: boolean | null; desktop: boolean | null }>()
  noticeChoices() {
    return this.rows
  }
  setNoticeChoice(type: string, channel: NoticeChannel, value: boolean) {
    const row = this.rows.get(type) ?? { phone: null, desktop: null }
    this.rows.set(type, { ...row, [channel]: value })
  }
}

const NOW = 1_800_000_000_000

function harness() {
  const notify = new NotifyStore(':memory:')
  const choices = new Memory()
  const routes = new Map<string, (ctx: never) => unknown>()
  const router = {
    on: (method: string, path: string, handler: (ctx: never) => unknown) =>
      routes.set(`${method} ${path}`, handler),
  } as unknown as Router
  registerNotificationRoutes(router, { notify, choices, now: () => NOW })
  const call = async (name: string, ctx: object = {}) =>
    (await routes.get(name)?.(ctx as never)) as never
  const list = () => call('GET /api/notifications') as Promise<{ types: Row[]; fixed: unknown[] }>
  const put = (type: string, channel: string, on: unknown) =>
    call('PUT /api/notifications/choice', { body: async () => ({ type, channel, on }) })
  return { notify, choices, call, list, put }
}

interface Row {
  id: string
  phone: { on: boolean; chosen: boolean }
  desktop: { on: boolean; chosen: boolean }
  fired: number
  phoned: number
}

const take = (h: ReturnType<typeof harness>, value: object, devices: string[] = []) =>
  h.notify.accept(
    parseNotice({ v: 1, title: 'T', body: 'x', severity: 'warning', ...value }),
    'local',
    devices,
    NOW - 1000,
  )

describe('Settings > Notifications', () => {
  it('lists every type with its rule default, and counts what fired this week', async () => {
    const h = harness()
    take(h, { source: 'aico', key: 'aico-waiting:1', interrupt: 'needs-you' }, ['p1'])
    take(h, { source: 'aico', key: 'aico-waiting:1', severity: 'ok' })
    const { types, fixed } = await h.list()
    const waiting = types.find((row) => row.id === 'agent-waiting')
    expect(waiting).toMatchObject({ fired: 1, phoned: 1, phone: { on: true, chosen: false } })
    expect(types.find((row) => row.id === 'jobinator')?.phone.on).toBe(false)
    expect(fixed.length).toBeGreaterThan(0)
  })

  it('shows a new sender by itself, with what the rule did for it', async () => {
    const h = harness()
    take(h, { source: 'new-sender', interrupt: 'needs-you' }, ['p1'])
    take(h, { source: 'quiet-sender', severity: 'info' })
    const { types } = await h.list()
    expect(types.find((row) => row.id === 'source:new-sender')?.phone.on).toBe(true)
    expect(types.find((row) => row.id === 'source:quiet-sender')?.phone.on).toBe(false)
  })

  it('saves every switch as flipped, so an off row stays off and an on row is forced', async () => {
    const h = harness()
    await h.put('agent-waiting', 'phone', false)
    expect(h.choices.noticeChoices().get('agent-waiting')?.phone).toBe(false)
    expect((await h.list()).types.find((row) => row.id === 'agent-waiting')?.phone).toEqual({
      on: false,
      chosen: true,
    })
    await h.put('agent-waiting', 'phone', true)
    expect(h.choices.noticeChoices().get('agent-waiting')?.phone).toBe(true)
    await h.put('source:new-sender', 'phone', false)
    const { types } = await h.list()
    expect(types.find((row) => row.id === 'source:new-sender')?.phone.on).toBe(false)
  })

  it('refuses a type, channel or value it does not know', async () => {
    const h = harness()
    await expect(h.put('nonsense', 'phone', true)).rejects.toThrow(/type/)
    await expect(h.put('tests', 'email', true)).rejects.toThrow(/channel/)
    await expect(h.put('tests', 'phone', 'yes')).rejects.toThrow(/on/)
  })

  it('says why each recent one went out', async () => {
    const h = harness()
    take(h, { source: 'aico', key: 'aico-waiting:1', interrupt: 'needs-you' }, ['p1'])
    const { items } = (await h.call('GET /api/notifications/recent', {
      query: new URLSearchParams({ type: 'agent-waiting' }),
    })) as { items: { why: string; phone: string; desktop: boolean }[] }
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ phone: 'queued', desktop: true })
    // What the door decided when it arrived, not what today's switch says.
    h.notify.accept(
      {
        ...parseNotice({
          v: 1,
          source: 'aico',
          title: 'T',
          body: 'x',
          severity: 'warning',
          key: 'aico-waiting:2',
          interrupt: 'needs-you',
        }),
        desktop_card: false,
      },
      'local',
      [],
      NOW - 500,
    )
    const later = (await h.call('GET /api/notifications/recent', {
      query: new URLSearchParams({ type: 'agent-waiting' }),
    })) as { items: { desktop: boolean }[] }
    expect(later.items.map((item) => item.desktop)).toEqual([false, true])
    expect(items[0]?.why).toMatch(/waiting on you/)
  })

  it('gives the Proxmox sender what shows off, from this machine only', async () => {
    const h = harness()
    await h.put('outage', 'phone', false)
    const local = {
      req: { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3002' } },
    }
    const { phone_off } = (await h.call('GET /api/notifications/phone-off', local)) as {
      phone_off: string[]
    }
    expect(phone_off).toContain('outage')
    expect(phone_off).toContain('jobinator') // off by the rule: Proxmox must not contradict the switch
    expect(phone_off).not.toContain('approval')
    await expect(
      h.call('GET /api/notifications/phone-off', {
        req: { socket: { remoteAddress: '8.8.8.8' }, headers: {} },
      }),
    ).rejects.toThrow(/this machine/)
  })
})
