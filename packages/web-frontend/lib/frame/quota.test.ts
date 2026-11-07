import { describe, expect, it } from 'vitest'
import type { UsageProvider, UsageReport, UsageWindow } from '../quota-usage'
import { quotaGlances, quotaLine, quotaTitle } from './quota'

const win = (over: Partial<UsageWindow>): UsageWindow => ({
  label: 'weekly',
  state: 'ok',
  left_percent: 80,
  resets_at: null,
  length_seconds: 1000,
  resets_in_seconds: 400,
  text: 'weekly 80% left, resets Nov 13',
  ...over,
})
const provider = (over: Partial<UsageProvider>): UsageProvider => ({
  id: 'claude',
  name: 'Claude',
  status: 'ok',
  answer: 'Available now',
  plan: null,
  windows: [win({})],
  credits: null,
  problem: null,
  spend: { unit: null, recorded_since: null, days: [] },
  by_project: {
    tracked: false,
    unit: null,
    from: '',
    to: '',
    total: 0,
    items: [],
  },
  ...over,
})
const report = (...providers: UsageProvider[]): UsageReport => ({
  as_of: '',
  collected_at: '',
  providers,
})

describe('quota glance short line', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')
  it('says what is left and the day it resets, a weekday within the week', () => {
    const [glance] = quotaGlances(
      report(
        provider({
          windows: [
            win({ left_percent: 73, resets_at: '2026-11-06T18:00:00Z' }),
          ],
        }),
      ),
      now,
    )
    expect(glance?.short).toMatch(/^73% left · resets (Thu|Fri)$/)
    const [far] = quotaGlances(
      report(
        provider({ windows: [win({ resets_at: '2026-11-13T18:00:00Z' })] }),
      ),
      now,
    )
    expect(far?.short).toBe('80% left · resets Nov 13')
  })

  it('says credits with the balance and the day, and used up with when it is back', () => {
    const used = win({
      state: 'used_up',
      left_percent: 0,
      resets_at: '2026-11-11T18:00:00Z',
    })
    const [credits] = quotaGlances(
      report(
        provider({
          status: 'on_credits',
          windows: [used],
          credits: { balance: 4500, lasts_days: 7, text: '' },
        }),
      ),
      now,
    )
    expect(credits?.short).toBe('credits · 4.5K left, to Nov 11')
    const [out] = quotaGlances(
      report(provider({ status: 'used_up', windows: [used] })),
      now,
    )
    expect(out?.short).toBe('used up · back Nov 11')
  })

  it('says not reported when no window can be read', () => {
    const [glance] = quotaGlances(
      report(
        provider({
          status: 'unknown',
          windows: [win({ state: 'unknown', left_percent: null })],
        }),
      ),
      now,
    )
    expect(glance?.short).toBe('not reported')
  })
})

describe('quota glance', () => {
  it('reads the share left in the tightest window, with how much of its time is gone', () => {
    const [claude] = quotaGlances(
      report(
        provider({
          windows: [
            win({ label: '5h', left_percent: 95, text: '5h 95% left' }),
            win({ left_percent: 79, resets_in_seconds: 600 }),
          ],
        }),
      ),
    )
    expect(claude).toMatchObject({
      state: 'left',
      left: 79,
      gone: 40,
      line: 'Weekly 80% left, resets Nov 13',
    })
  })

  it('says each provider in one line: left, on credits, used up', () => {
    const glances = quotaGlances(
      report(
        provider({}),
        provider({
          id: 'codex',
          name: 'Codex',
          status: 'on_credits',
          answer:
            'Running on credits until the Nov 11 reset; 4.6K credits left, enough at the recent pace',
          credits: { balance: 4571.7, lasts_days: 2.9, text: '4.6K credits' },
          windows: [
            win({
              state: 'used_up',
              left_percent: 0,
              text: 'weekly used up',
              resets_at: '2026-11-11T10:35:00.000Z',
            }),
          ],
        }),
        provider({
          id: 'opencode-go',
          name: 'OpenCode Go',
          status: 'used_up',
          answer: 'Used up until Nov 8, 7:00 PM EST (weekly)',
          windows: [
            win({ label: '5h', left_percent: 100 }),
            win({
              state: 'used_up',
              left_percent: 0,
              text: 'weekly used up',
              resets_at: '2026-11-08T21:00:00.000Z',
            }),
          ],
        }),
      ),
    )
    expect(glances.map((g) => [g.name, g.state, g.left])).toEqual([
      ['Claude', 'left', 80],
      ['Codex', 'credits', 0],
      ['OpenCode Go', 'used_up', 0],
    ])
    // Not used up and credits both lead with the one answer, not a window's 0%.
    expect(glances[1]?.line).toBe(
      'Running on credits until the Nov 11 reset; 4.6K credits left, enough at the recent pace',
    )
    expect(glances[2]?.line).toBe('Used up until Nov 8, 7:00 PM EST (weekly)')
    expect(quotaLine(glances)).toBe(
      'Claude 80% left · Codex on credits until Nov 11 · OpenCode Go used up until Nov 8',
    )
    expect(quotaTitle(glances)).toContain('Codex: Running on credits until')
    expect(quotaTitle(glances)).toContain('Windows: weekly used up')
    expect(quotaTitle(glances)).toContain('Bar: how much is left')
  })

  it('says unknown, not zero, when nothing was read', () => {
    const [glance] = quotaGlances(
      report(
        provider({
          status: 'unknown',
          answer: 'Can’t tell yet: no current usage reading',
          windows: [win({ state: 'unknown', left_percent: null })],
        }),
      ),
    )
    expect(glance).toMatchObject({ state: 'unknown', left: null, warn: true })
    expect(quotaLine([glance as never])).toBe('Claude unknown')
  })

  it('has no glances before the first read', () => {
    expect(quotaGlances(null)).toEqual([])
  })
})
