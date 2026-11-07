import { describe, expect, it } from 'vitest'
import { shortWhen } from './short-when'

describe('shortWhen', () => {
  it('shows a recorded time short and an unrecorded one as not recorded', () => {
    expect(shortWhen(null)).toBe('Not recorded')
    expect(shortWhen('not a date')).toBe('Not recorded')
    expect(shortWhen('2026-11-06T20:30:17.888Z')).toMatch(/Nov/)
  })
})
