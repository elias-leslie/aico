import { describe, expect, it } from 'vitest'
import { shortWhen } from './short-when'

describe('shortWhen', () => {
  it('shows a recorded time short and an unrecorded one as not recorded', () => {
    expect(shortWhen(null)).toBe('Not recorded')
    expect(shortWhen('not a date')).toBe('Not recorded')
    expect(shortWhen('2026-11-06T20:30:17.888Z')).toMatch(/Nov/)
  })

  it('takes epoch milliseconds, and never prints the numeric 11/6/2026 form', () => {
    const text = shortWhen(Date.UTC(2026, 10, 6, 20, 30))
    expect(text).toMatch(/^Nov \d{1,2}, \d{1,2}:\d{2} [AP]M$/)
    expect(shortWhen(0)).toBe('Not recorded')
  })
})
