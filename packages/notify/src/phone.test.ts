// What reaches the phone, replayed on real notices (owner 2026-11-07: only an agent that truly needs
// the owner, or a major issue). fixtures/phone-replay.json holds one notice per distinct kind
// aico-web took in the three days before the rule, anonymised, with what happened then.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseNotice } from './notice'
import { Notifier } from './notifier'
import { NotifyStore } from './store'

interface Replay {
  notice: Record<string, unknown>
  wasPushed: boolean
  count: number
  expectPush: 'phone' | 'tray'
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
      expect(item.notice.source).toBe('aico')
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
