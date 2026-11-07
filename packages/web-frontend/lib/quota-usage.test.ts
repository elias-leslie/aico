import { describe, expect, it } from 'vitest'
import {
  barHeights,
  compact,
  dayLabel,
  dayText,
  type SpendDay,
  summarize,
  windowGone,
} from './quota-usage'

const day = (over: Partial<SpendDay>): SpendDay => ({
  day: '2026-11-05',
  recorded: true,
  credits: null,
  tokens: 0,
  requests: 0,
  ...over,
})

describe('compact', () => {
  it('keeps counts short', () => {
    expect(
      [999, 1234, 15_000, 2_100_000, 34_700_000, 1_200_000_000].map(compact),
    ).toEqual(['999', '1.2K', '15K', '2.1M', '35M', '1.2B'])
  })
})

describe('spend bars', () => {
  const days = [
    day({ day: '2026-11-03', recorded: false }),
    day({ day: '2026-11-04', credits: 0 }),
    day({ day: '2026-11-05', credits: 40, requests: 1 }),
    day({ day: '2026-11-06', credits: 20, requests: 3 }),
  ]

  it('scales to the biggest day, a quiet day is zero and an unrecorded day is no bar', () => {
    expect(barHeights(days, 'credits')).toEqual([null, 0, 1, 0.5])
  })

  it('totals only the recorded days', () => {
    expect(summarize(days, 'credits')).toEqual({
      total: 60,
      peak: 40,
      recordedDays: 3,
    })
  })

  it('says a day was not recorded instead of 0', () => {
    expect(dayText(days[0] as SpendDay, 'credits')).toBe('Nov 3: not recorded')
    expect(dayText(days[2] as SpendDay, 'credits')).toBe(
      'Nov 5: 40 credits, 1 request',
    )
    expect(dayText(days[3] as SpendDay, 'credits', '2026-11-06')).toBe(
      'Today: 20 credits, 3 requests',
    )
  })

  it('does not divide by zero when nothing was spent', () => {
    expect(barHeights([day({ tokens: 0 })], 'tokens')).toEqual([0])
  })
})

describe('windows and days', () => {
  it('measures how much of a window is gone', () => {
    const base = {
      label: 'weekly',
      state: 'ok' as const,
      left_percent: 50,
      resets_at: null,
      text: '',
    }
    expect(
      windowGone({ ...base, length_seconds: 1000, resets_in_seconds: 250 }),
    ).toBe(0.75)
    expect(
      windowGone({ ...base, length_seconds: 1000, resets_in_seconds: null }),
    ).toBeNull()
  })

  it('names a day', () => {
    expect(dayLabel('2026-11-05')).toBe('Nov 5')
    expect(dayLabel('2026-11-06', '2026-11-06')).toBe('Today')
  })
})
