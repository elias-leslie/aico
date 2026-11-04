// The staleness rules: a reading says how much is used only until its window resets
// (or, with no reset named, until the window is over); after that it is unknown, never 0%.

import { describe, expect, it } from 'vitest'
import { optionUsage, type Reading, windowFacts } from './windows'

const NOW = '2026-11-04T12:00:00.000Z'
const HOUR = 3600_000
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString()

function reading(over: Partial<Reading> & Pick<Reading, 'window_minutes'>): Reading {
  return {
    provider: 'claude',
    observed_at: at(-HOUR),
    used_percent: 40,
    resets_at: at(2 * HOUR),
    source: 'claude_statusline',
    ...over,
  }
}

describe('windowFacts', () => {
  it('shows an open window with what is left and when it resets', () => {
    const [window] = windowFacts([reading({ window_minutes: 300 })], NOW).claude ?? []
    expect(window).toMatchObject({
      label: '5h',
      state: 'ok',
      used_percent: 40,
      left_percent: 60,
      resets_in_seconds: 7200,
      age_seconds: 3600,
    })
  })

  it('reads a window whose reset passed as unknown, not as 0% used', () => {
    const [window] =
      windowFacts([reading({ window_minutes: 300, resets_at: at(-60_000) })], NOW).claude ?? []
    expect(window).toMatchObject({ state: 'unknown', used_percent: null, left_percent: null })
  })

  it('calls a lapsed window "not reported" once another window was read since', () => {
    const facts = windowFacts(
      [
        reading({ window_minutes: 300, observed_at: at(-6 * HOUR), resets_at: at(-HOUR) }),
        reading({ window_minutes: 10080 }),
      ],
      NOW,
    ).claude
    expect(facts?.map((w) => [w.label, w.state])).toEqual([
      ['5h', 'not_reported'],
      ['weekly', 'ok'],
    ])
  })

  it('reads a reading that names no reset as unknown once its window is over', () => {
    const fresh = reading({ window_minutes: 300, resets_at: null, observed_at: at(-HOUR) })
    const old = reading({ window_minutes: 300, resets_at: null, observed_at: at(-6 * HOUR) })
    expect(windowFacts([fresh], NOW).claude?.[0]?.state).toBe('ok')
    expect(windowFacts([old], NOW).claude?.[0]?.state).toBe('unknown')
  })

  it('marks 100% as used up until the reset', () => {
    const [window] =
      windowFacts([reading({ window_minutes: 10080, used_percent: 100 })], NOW).claude ?? []
    expect(window?.state).toBe('used_up')
  })
})

describe('optionUsage', () => {
  const credits = { codex: { balance: 500, pace_per_day_7d: 100, earliest_expiry: null } }

  it('runs on credits while a window is used up and credits remain', () => {
    const windows = windowFacts(
      [
        reading({
          provider: 'codex',
          window_minutes: 10080,
          used_percent: 100,
          resets_at: at(30 * HOUR),
        }),
      ],
      NOW,
    )
    const usage = optionUsage('codex', windows, credits)
    expect(usage.status).toBe('on_credits')
    expect(usage.credits).toMatchObject({ lasts_days: 5, lasts_past_reset: true })
  })

  it('is used up with no credits, unknown with no readings, untracked with no provider', () => {
    const windows = windowFacts([reading({ window_minutes: 10080, used_percent: 100 })], NOW)
    expect(optionUsage('claude', windows, {}).status).toBe('used_up')
    expect(optionUsage('opencode-go', windows, {}).status).toBe('unknown')
    expect(optionUsage(null, windows, {}).status).toBe('untracked')
  })

  it('says credits do not last past the reset when the pace outruns them', () => {
    const windows = windowFacts(
      [
        reading({
          provider: 'codex',
          window_minutes: 10080,
          used_percent: 100,
          resets_at: at(10 * 24 * HOUR),
        }),
      ],
      NOW,
    )
    expect(optionUsage('codex', windows, credits).credits?.lasts_past_reset).toBe(false)
  })
})
