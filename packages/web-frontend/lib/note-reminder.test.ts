import { describe, expect, it } from 'vitest'
import { fromLocalInput, toLocalInput } from './note-reminder'

describe('note reminder times', () => {
  it('round-trips a time through the input form, in local time', () => {
    const ms = new Date(2026, 10, 7, 14, 30).getTime()
    expect(toLocalInput(ms)).toBe('2026-11-07T14:30')
    expect(fromLocalInput('2026-11-07T14:30')).toBe(ms)
  })
  it('reads an empty or half-typed value as no time', () => {
    expect(fromLocalInput('')).toBeNull()
    expect(fromLocalInput('2026-11-07')).toBeNull()
  })
})
