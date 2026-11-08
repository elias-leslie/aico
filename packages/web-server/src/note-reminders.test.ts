import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Router } from './http'
import { ago, registerReminderRoutes, sendDueReminders } from './note-reminders'
import { NotesStore } from './notes-db'
import { Link, openHost, settle } from './sync/harness'
import { serveRoutes } from './testing'

const MIN = 60_000
const T0 = 1_700_000_000_000

describe('note reminders', () => {
  let wall: number
  let store: NotesStore
  let notices: Record<string, unknown>[]
  let failNext: boolean
  const notifier = {
    receive: (value: unknown) => {
      if (failNext) throw new Error('refused')
      notices.push(value as Record<string, unknown>)
      return {} as never
    },
  }
  const deps = (host: string | null = 'aico.example.dev') => ({
    store,
    notifier,
    publicHost: host,
    now: () => wall,
  })

  beforeEach(() => {
    wall = T0
    notices = []
    failNext = false
    store = new NotesStore(':memory:', { hostName: 'here', now: () => wall })
  })
  afterEach(() => store.close())

  it('sends a reminder once, when its time has come', () => {
    const note = store.notes.create({ title: 'Car service', remindAt: T0 + 10 * MIN })
    expect(sendDueReminders(deps())).toEqual({ sent: 0, failed: 0 })
    wall = T0 + 10 * MIN
    expect(sendDueReminders(deps())).toEqual({ sent: 1, failed: 0 })
    expect(sendDueReminders(deps())).toEqual({ sent: 0, failed: 0 })
    expect(notices).toHaveLength(1)
    // Warning, because only warnings and criticals reach the phone (notice.ts).
    expect(notices[0]).toMatchObject({
      v: 1,
      source: 'aico',
      kind: 'info',
      severity: 'warning',
      push: 'phone',
      title: 'Reminder: Car service',
      body: 'It is due now.',
      key: `reminder:${note.id}:${T0 + 10 * MIN}`,
      open: `https://aico.example.dev/notes?id=${note.id}`,
    })
    expect(store.notes.getNote(note.id)?.reminded_at).toBe(wall)
  })

  it('says how late a reminder is when the hosts were down, and passes the notice contract', async () => {
    const { parseNotice } = await import('@aico/notify')
    store.notes.create({ title: 'Renew plates', remindAt: T0 })
    wall = T0 + 3 * 3_600_000
    sendDueReminders(deps(null))
    expect(notices[0]?.body).toBe('This was due 3 h ago.')
    expect(notices[0]).not.toHaveProperty('open')
    expect(parseNotice(notices[0])).toMatchObject({ push: 'phone', severity: 'warning' })
    expect(ago(90 * 1000)).toBe('2 min ago')
    expect(ago(60 * MIN)).toBe('1 h ago')
    expect(ago(3 * 86_400_000)).toBe('3 days ago')
  })

  it('names an untitled note by its first line, hides secrets, and skips deleted notes', () => {
    store.notes.create({ body: 'Call the garage\nsecond line', remindAt: T0 })
    store.notes.create({
      // split so secret scanners don't flag the fake token
      title: `bot ${'7012345678'}:${'AAFakeFakeFake_0123456789abcdefXYZ'}w`,
      remindAt: T0,
    })
    const gone = store.notes.create({ title: 'Gone', remindAt: T0 })
    store.notes.remove(gone.id)
    store.notes.create({ remindAt: T0 })
    sendDueReminders(deps())
    const titles = notices.map((n) => n.title as string).sort()
    expect(titles).toHaveLength(3)
    expect(titles).toContain('Reminder: Call the garage')
    expect(titles).toContain('Reminder: Untitled note')
    expect(titles.join('\n')).not.toContain('AAFakeFake')
    expect(titles.join('\n')).not.toContain('Gone')
  })

  it('sends again when the owner moves the time, and not when it is cleared', () => {
    const note = store.notes.create({ title: 'Dentist', remindAt: T0 })
    sendDueReminders(deps())
    store.notes.update(note.id, { remindAt: T0 + 60 * MIN })
    expect(store.notes.getNote(note.id)?.reminded_at).toBeNull()
    wall = T0 + 60 * MIN
    sendDueReminders(deps())
    expect(notices).toHaveLength(2)
    store.notes.update(note.id, { remindAt: wall + MIN })
    store.notes.update(note.id, { remindAt: null })
    wall += 5 * MIN
    sendDueReminders(deps())
    expect(notices).toHaveLength(2)
  })

  it('takes the sent mark back when the notice cannot be queued, then tries again', () => {
    const note = store.notes.create({ title: 'Pills', remindAt: T0 })
    failNext = true
    expect(sendDueReminders(deps())).toEqual({ sent: 0, failed: 1 })
    expect(store.notes.getNote(note.id)?.reminded_at).toBeNull()
    failNext = false
    expect(sendDueReminders(deps())).toEqual({ sent: 1, failed: 0 })
  })

  it('claims a reminder for one caller only', () => {
    const note = store.notes.create({ title: 'Once', remindAt: T0 })
    expect(store.notes.claimReminder(note.id, wall)).not.toBeNull()
    expect(store.notes.claimReminder(note.id, wall)).toBeNull()
    // Not yet due, or moved after the list was read: no claim.
    const later = store.notes.create({ title: 'Later', remindAt: T0 + MIN })
    expect(store.notes.claimReminder(later.id, wall)).toBeNull()
  })

  it('the other host sees the sent mark after a sync and does not send again', async () => {
    const link = new Link()
    const a = openHost('workstation')
    const b = openHost('gem', { clock: a.clock })
    try {
      const note = a.notes.notes.create({ title: 'Brakes', remindAt: a.clock.ms + MIN })
      await settle(a, b, link)
      a.clock.advance(2 * MIN)
      const sentBy: string[] = []
      const send = (host: typeof a) =>
        sendDueReminders({
          store: host.notes,
          notifier: { receive: () => (sentBy.push(host.name), {} as never) },
          publicHost: null,
          now: a.clock.now,
        })
      expect(send(a).sent).toBe(1)
      await settle(a, b, link)
      expect(send(b).sent).toBe(0)
      expect(sentBy).toEqual(['workstation'])
      expect(b.notes.notes.getNote(note.id)?.reminded_at).not.toBeNull()
    } finally {
      a.notes.close()
      a.web.close()
      b.notes.close()
      b.web.close()
    }
  })

  it('the other host sends it when the first never did (its host was down)', async () => {
    const link = new Link()
    const a = openHost('workstation')
    const b = openHost('gem', { clock: a.clock })
    try {
      a.notes.notes.create({ title: 'Brakes', remindAt: a.clock.ms + MIN })
      await settle(a, b, link)
      link.down()
      a.clock.advance(2 * MIN)
      let sent = 0
      const result = sendDueReminders({
        store: b.notes,
        notifier: { receive: () => (sent++, {} as never) },
        publicHost: null,
        now: a.clock.now,
      })
      expect(result.sent).toBe(1)
      expect(sent).toBe(1)
    } finally {
      a.notes.close()
      a.web.close()
      b.notes.close()
      b.web.close()
    }
  })

  describe('POST /api/notes/reminders/run', () => {
    it('runs from this machine and reports plainly', async () => {
      store.notes.create({ title: 'Car service', remindAt: T0 })
      const api = await serveRoutes((router: Router) => registerReminderRoutes(router, deps()))
      try {
        const run = async () => {
          const response = await fetch(`${api.base}/api/notes/reminders/run`, { method: 'POST' })
          return { status: response.status, body: await response.json() }
        }
        expect(await run()).toMatchObject({
          status: 200,
          body: { state: 'ok', message: 'Sent 1 reminder.', sent: 1 },
        })
        expect((await run()).body).toMatchObject({ state: 'ok', message: 'No reminders due.' })
        failNext = true
        store.notes.create({ title: 'Two', remindAt: T0 })
        expect((await run()).body).toMatchObject({
          state: 'failed',
          message: '1 reminder could not be queued.',
        })
      } finally {
        await api.close()
      }
    })

    it('refuses a request that came through the public host', async () => {
      const api = await serveRoutes((router: Router) => registerReminderRoutes(router, deps()))
      try {
        const response = await fetch(`${api.base}/api/notes/reminders/run`, {
          method: 'POST',
          headers: { 'x-forwarded-for': '203.0.113.9' },
        })
        expect(response.status).toBe(403)
      } finally {
        await api.close()
      }
    })
  })
})
