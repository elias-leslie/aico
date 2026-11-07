import { describe, expect, it } from 'vitest'
import { grantsLine, splitGrants, statement } from './grants'

const NOW = Date.parse('2026-11-06T12:00:00') // local time
const s = (offsetMin: number) => NOW / 1000 + offsetMin * 60
const req = (id: string, state: string, expires: number, extra = {}) => ({
  id,
  title: 'Open your main Chrome for 15 min?',
  reason: 'Check the page',
  agent: 'aico',
  state,
  expires,
  ...extra,
})

describe('splitGrants', () => {
  it('puts open and waiting in Active and everything else in History', () => {
    const { active, history } = splitGrants(
      {
        requests: [
          req('a', 'approved', s(10)),
          req('b', 'pending', s(5)),
          req('c', 'expired', s(-60)),
          req('d', 'revoked', s(-30), { ended: s(-40) }),
        ],
        uses: [
          { at: 0, event: 'approved', id: 'd', kind: 'owner-chrome', uid: 1 },
        ],
      },
      NOW,
    )
    expect(active.map((i) => i.request.id)).toEqual(['b', 'a'])
    expect(history.map((i) => i.request.id)).toEqual(['d', 'c'])
    expect(history[0]?.when).toMatch(/^Ended by you /)
    expect(history[1]?.when).toMatch(/^Expired .*Nobody tapped/)
    expect(grantsLine(active)).toBe('1 waiting for your tap · 1 open')
  })

  it('moves a pending request past its expiry to History as expired, not a question', () => {
    const { active, history } = splitGrants(
      { requests: [req('p', 'pending', s(-3))], uses: [] },
      NOW,
    )
    expect(active).toEqual([])
    expect(history[0]).toMatchObject({
      kind: 'expired',
      chip: 'Expired',
      live: false,
    })
    expect(history[0]?.title).toBe('Your main Chrome for 15 min')
    expect(history[0]?.when).not.toContain('tap in')
  })

  it('says a withdrawn request was withdrawn, and an approved one that ran out ended', () => {
    const { history } = splitGrants(
      {
        requests: [
          req('w', 'revoked', s(-30), { ended: s(-35) }),
          req('e', 'expired', s(-90)),
        ],
        uses: [{ at: 0, event: 'approved', id: 'e', kind: 'k', uid: 1 }],
      },
      NOW,
    )
    const by = Object.fromEntries(history.map((i) => [i.request.id, i]))
    expect(by.w?.chip).toBe('Withdrawn')
    expect(by.e?.when).toMatch(/^Ended .*Time ran out/)
  })

  it('keeps the question title only while it waits', () => {
    const { active } = splitGrants(
      { requests: [req('p', 'pending', s(5))], uses: [] },
      NOW,
    )
    expect(active[0]?.title).toBe('Open your main Chrome for 15 min?')
    expect(active[0]?.when).toContain(
      'Waiting for your tap in the Nightshift or Aico tray',
    )
  })
})

describe('statement', () => {
  it('turns a question into a name', () => {
    expect(statement('Open test access?')).toBe('Test access')
  })
})
