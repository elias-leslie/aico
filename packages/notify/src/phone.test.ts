// What reaches the phone, replayed on real notices (owner 2026-11-07: only an agent that truly needs
// the owner, or a major issue). fixtures/phone-replay.json holds one notice per distinct kind
// aico-web took in the three days before the rule, anonymised, with what happened then.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseNotice } from './notice'
import { Notifier } from './notifier'
import { popsUp } from './phone'
import { NotifyStore } from './store'

interface Replay {
  notice: Record<string, unknown>
  wasPushed: boolean
  count: number
  expectPush: 'phone' | 'tray'
  expectToast: boolean
}
const replay: { notices: Replay[] } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/phone-replay.json', import.meta.url)), 'utf8'),
)

describe('the last three days of notices', () => {
  const titles = (items: Replay[]) => items.map((item) => item.notice.title as string)
  const pushNow = replay.notices.filter((item) => parseNotice(item.notice).push === 'phone')

  it('routes every distinct kind as the rule says', () => {
    for (const item of replay.notices)
      expect([parseNotice(item.notice).push, item.notice.title]).toEqual([
        item.expectPush,
        item.notice.title,
      ])
  })

  it('pushes approvals, a waiting agent, a blocking ask, canary trips and the digest', () => {
    const pushed = titles(pushNow).join('\n')
    expect(pushed).toContain('Open your main Chrome')
    expect(pushed).toContain('waiting in Aico')
    expect(pushed).toContain('An agent is waiting on you')
    expect(pushed).toContain('Canary tripped: ssh host')
    expect(pushed).toContain('Canary tripped: env')
    expect(pushed).toContain('While you were away')
  })

  it('pushes no late or failed status row, no app notice and no test push', () => {
    for (const title of titles(replay.notices.filter((item) => !pushNow.includes(item)))) void title
    for (const item of pushNow) {
      const title = item.notice.title as string
      expect(title).not.toMatch(/^\d+ (late|failed):/)
      if (!title.startsWith('Test: ')) expect(item.notice.source).toBe('aico')
      expect(String(item.notice.key ?? '')).not.toMatch(
        /^(status|jobinator|portfolio|pushcheck|host-rename)/,
      )
    }
    // Before: about 30 of these kinds reached the phone; now a handful.
    expect(replay.notices.filter((item) => item.wasPushed).length).toBeGreaterThan(
      pushNow.length * 3,
    )
  })

  it('says why each pushed notice reached the phone', () => {
    expect(pushNow.length).toBeGreaterThan(0)
    for (const item of pushNow) expect(parseNotice(item.notice).phone_reason).toMatch(/\S/)
    for (const item of replay.notices.filter((entry) => !pushNow.includes(entry)))
      expect(parseNotice(item.notice).phone_reason).toBeUndefined()
  })
})

describe('an agent test', () => {
  const test = { v: 1, body: 'x', severity: 'warning', interrupt: 'needs-you' }

  it('stays off the phone even with a reason, from a test sender or under a test title', () => {
    const route = (extra: object) => parseNotice({ ...test, ...extra }).push
    expect(route({ source: 'zz-toast-test', title: 'Toast check' })).toBe('tray')
    expect(route({ source: 'aico', key: 'pushcheck:1', title: 'Push check' })).toBe('tray')
    expect(route({ source: 'aico', key: 'm10d2-test-a:1', title: 'Pairing' })).toBe('tray')
    expect(route({ source: 'aico', title: 'TEST ignore: toast check' })).toBe('tray')
    expect(route({ source: 'agent', title: 'Test notification' })).toBe('tray')
    expect(route({ source: 'agent', title: 'Testing the phone push' })).toBe('tray')
  })

  it('reaches the phone only as the documented phone test', () => {
    expect(parseNotice({ ...test, source: 'agent', title: 'Test: my phone' }).push).toBe('phone')
    expect(parseNotice({ ...test, source: 'agent', title: 'Test failures in aico' }).push).toBe(
      'phone',
    )
    expect(parseNotice({ ...test, source: 'aico', key: 'm2-disk:1', title: 'Disk' }).push).toBe(
      'phone',
    )
  })
})

describe('the rule', () => {
  const base = {
    v: 1,
    source: 'jobinator',
    title: 'Follow-ups due',
    body: 'x',
    severity: 'warning',
  }

  it('does not route by severity: a critical with no reason stays in the tray', () => {
    expect(parseNotice({ ...base, severity: 'critical' }).push).toBe('tray')
    expect(parseNotice({ ...base, push: 'phone' }).push).toBe('tray')
  })

  it('refuses a reason it does not know and a sender-written phone_reason', () => {
    expect(() => parseNotice({ ...base, interrupt: 'urgent' })).toThrow(/interrupt/)
    expect(() => parseNotice({ ...base, phone_reason: 'because' })).toThrow(/phone_reason/)
  })

  it('records the reason with the notice', () => {
    const notice = parseNotice({ ...base, interrupt: 'data-risk' })
    expect(notice).toMatchObject({
      push: 'phone',
      phone_reason: 'A backup is failing or long overdue.',
    })
  })

  it('treats an OmniNull detection page as a security event, at the door', () => {
    const store = new NotifyStore(':memory:')
    const sender = { devices: () => [] }
    const notifier = new Notifier({
      store,
      sender: sender as never,
      outbox: { kick: async () => 0 } as never,
      needsYou: { noticeAccepted: async () => {} } as never,
      log: () => {},
    })
    const page = {
      v: 1,
      source: 'ominull',
      kind: 'alert',
      severity: 'critical',
      title: 'New outbound connection',
      body: 'x',
      key: 'alerts:7c1d2e3f',
    }
    const taken = notifier.receive(page, 'ominull')
    expect(store.get(taken.id)?.notice).toMatchObject({ interrupt: 'security', push: 'phone' })
    const status = notifier.receive({ ...page, key: 'maintenance:1', title: 'Patches' }, 'ominull')
    expect(store.get(status.id)?.notice.push).toBe('tray')
    const spoofed = notifier.receive({ ...page, key: 'alerts:abc', title: 'From local' }, 'local')
    expect(store.get(spoofed.id)?.notice.push).toBe('tray')
  })
})

describe('what pops up as a corner card', () => {
  const popped = (item: Replay) => popsUp(parseNotice(item.notice))

  it('is what the replay says, notice by notice', () => {
    for (const item of replay.notices)
      expect([popped(item), item.notice.title]).toEqual([item.expectToast, item.notice.title])
  })

  it('never pops an info or an ok, such as "nothing left to do"', () => {
    const quiet = replay.notices.filter((item) =>
      ['info', 'ok'].includes(String(item.notice.severity)),
    )
    expect(quiet.length).toBeGreaterThan(10)
    for (const item of quiet)
      expect([popped(item), item.notice.title]).toEqual([false, item.notice.title])
  })

  it('pops what asks the owner or names a reason, and not a failed or late row', () => {
    const titles = (want: boolean) =>
      replay.notices
        .filter((item) => popped(item) === want)
        .map((item) => item.notice.title as string)
    expect(titles(true)).toEqual(
      expect.arrayContaining(['Browser needs you', 'An agent is waiting on you']),
    )
    expect(titles(true).join('\n')).toContain('Open your main Chrome')
    expect(titles(true).join('\n')).not.toMatch(/\d failed:/) // a failing row alone is Status, not a card
    expect(titles(false).join('\n')).toMatch(/\d failed:/)
    expect(titles(false).join('\n')).toMatch(/\d late:/)
    expect(titles(false).join('\n')).toContain('The session was resumed; nothing left to do.')
  })
})

describe('resolving a notice', () => {
  const notifier = () => {
    const store = new NotifyStore(':memory:')
    const needsYou = { noticeAccepted: async () => {}, noticeResolved: async () => {} }
    return {
      store,
      notifier: new Notifier({
        store,
        sender: { devices: () => [] } as never,
        outbox: { kick: async () => 0 } as never,
        needsYou: needsYou as never,
        log: () => {},
      }),
    }
  }
  const handOff = {
    v: 1,
    source: 'browser-automation',
    kind: 'todo',
    severity: 'warning',
    title: 'Browser needs you',
    body: 'Log in.',
    key: 'browser-hand-off:work',
  }

  it('ends an open notice with one ok that never pops up', async () => {
    const { store, notifier: n } = notifier()
    n.receive(handOff, 'local')
    const done = await n.resolve('browser-automation', handOff.key, 'The session was resumed.')
    expect(done.resolved).toBe(1)
    const [newest] = store.forKey('browser-automation', handOff.key)
    expect(newest?.notice).toMatchObject({ severity: 'ok', push: 'tray' })
    expect(popsUp(newest?.notice as never)).toBe(false)
  })

  it('writes nothing when there is nothing open to end', async () => {
    const { store, notifier: n } = notifier()
    const none = await n.resolve('browser-automation', handOff.key, 'The session was closed.')
    expect(none.resolved).toBe(0)
    expect(store.forKey('browser-automation', handOff.key)).toEqual([])
    n.receive(handOff, 'local')
    await n.resolve('browser-automation', handOff.key, 'First.')
    await n.resolve('browser-automation', handOff.key, 'Second.')
    expect(store.forKey('browser-automation', handOff.key)).toHaveLength(2)
  })
})
