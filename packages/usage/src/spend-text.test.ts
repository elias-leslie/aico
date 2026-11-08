// The words the spend card, the Quota page and `aico usage` share for windows and credits.

import { expect, it } from 'vitest'
import { answerText, creditText, windowText } from './spend'
import type { Usage, Window } from './windows'

const NOW = Date.parse('2026-11-07T15:00:00.000Z')
const DAY = 86_400_000
const credit = (over: Partial<NonNullable<Usage['credits']>>): NonNullable<Usage['credits']> =>
  ({
    balance: 4568.6,
    pace_per_day_7d: 1200,
    earliest_expiry: null,
    lasts_days: 3.8,
    reset_at: new Date(NOW + 4 * DAY).toISOString(),
    lasts_past_reset: false,
    ...over,
  }) as NonNullable<Usage['credits']>

it('says when credits run out against the reset, with dates', () => {
  const text = creditText(credit({ lasts_days: 2 }), NOW)
  expect(text).toMatch(/^4\.6K credits left, runs out about Nov 9, before the Nov 11 reset$/)
  expect(text).not.toContain('so not until')
})

it('says credits last past the reset', () => {
  expect(creditText(credit({ lasts_past_reset: true, lasts_days: 9 }), NOW)).toBe(
    '4.6K credits left, lasts past the Nov 11 reset at the recent pace',
  )
})

it('does not promise a runway for an empty balance', () => {
  expect(creditText(credit({ balance: 0, lasts_days: 0 }), NOW)).toBe('0 credits left')
})

it('an unreadable window says it was not reported this time, with when it was last known', () => {
  const window = { label: '5h', state: 'unknown', age_seconds: 8 * 3600 } as Window
  expect(windowText(window)).toBe('5h not reported this time; last known 8 h ago')
})

const usage = (over: Partial<Usage>): Usage => ({
  provider: 'codex',
  status: 'ok',
  windows: [],
  credits: null,
  unknown_windows: [],
  ...over,
})
const out = (label: string, resetsAt: string, inSeconds: number) =>
  ({
    label,
    state: 'used_up',
    resets_at: resetsAt,
    resets_in_seconds: inSeconds,
  }) as Window

it('answers can-I-use-it first: credits carry past the reset', () => {
  const text = answerText(
    usage({
      status: 'on_credits',
      windows: [out('weekly', new Date(NOW + 4 * DAY).toISOString(), 4 * 86400)],
      credits: credit({ lasts_past_reset: true, lasts_days: 9 }),
    }),
    NOW,
  )
  expect(text).toBe(
    'Available on credits until the Nov 11 reset; 4.6K credits left, enough at the recent pace',
  )
})

it('answers can-I-use-it first: credits that run out before the reset say when', () => {
  const text = answerText(
    usage({
      status: 'on_credits',
      windows: [out('weekly', new Date(NOW + 4 * DAY).toISOString(), 4 * 86400)],
      credits: credit({ lasts_days: 2 }),
    }),
    NOW,
  )
  expect(text).toBe(
    'Available on credits until the Nov 11 reset; 4.6K credits left, not enough at the recent pace (runs out about Nov 9)',
  )
})

it('answers can-I-use-it first: used up names the window and when it returns', () => {
  const text = answerText(
    usage({
      status: 'used_up',
      windows: [out('weekly', '2026-11-08T21:00:00.000Z', 86400)],
    }),
    NOW,
  )
  expect(text).toMatch(/^Used up until Nov 8, [^()]+ E[SD]T \(weekly\)$/)
})

it('answers can-I-use-it first: open, partly unread, unknown', () => {
  expect(answerText(usage({}), NOW)).toBe('Available now')
  expect(answerText(usage({ status: 'partly_unknown', unknown_windows: ['5h'] }), NOW)).toBe(
    'Available now; the 5h window was not reported this time',
  )
  expect(answerText(usage({ status: 'unknown' }), NOW)).toBe(
    'Can’t tell yet: no current usage reading',
  )
})
