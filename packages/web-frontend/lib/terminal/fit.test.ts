import { describe, expect, it, vi } from 'vitest'
import { MIN_FIT_COLS, MIN_FIT_ROWS } from '../constants/terminal'
import { fitTerminal, usableDimensions } from './fit'

const addon = (dims: { cols: number; rows: number } | undefined) => ({
  fit: vi.fn(),
  proposeDimensions: () => dims,
})

describe('usableDimensions', () => {
  it('returns a grid a terminal can have', () => {
    expect(usableDimensions(addon({ cols: 80, rows: 24 }))).toEqual({
      cols: 80,
      rows: 24,
    })
    expect(
      usableDimensions(addon({ cols: MIN_FIT_COLS, rows: MIN_FIT_ROWS })),
    ).not.toBeNull()
  })

  it('refuses a container that is not laid out or too small', () => {
    expect(usableDimensions(addon(undefined))).toBeNull()
    expect(usableDimensions(addon({ cols: 2, rows: 1 }))).toBeNull()
    expect(
      usableDimensions(addon({ cols: MIN_FIT_COLS - 1, rows: 40 })),
    ).toBeNull()
    expect(
      usableDimensions(addon({ cols: 80, rows: MIN_FIT_ROWS - 1 })),
    ).toBeNull()
    expect(usableDimensions(addon({ cols: Number.NaN, rows: 24 }))).toBeNull()
  })
})

describe('fitTerminal', () => {
  it('fits only a usable container', () => {
    const small = addon({ cols: 2, rows: 1 })
    expect(fitTerminal(small)).toBe(false)
    expect(small.fit).not.toHaveBeenCalled()
    const ok = addon({ cols: 100, rows: 30 })
    expect(fitTerminal(ok)).toBe(true)
    expect(ok.fit).toHaveBeenCalledTimes(1)
  })
})
