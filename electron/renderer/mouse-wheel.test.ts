import { describe, expect, it } from 'vitest'
import { pointToCell, sgrWheelSequence, wheelMouseTicks } from './mouse-wheel'

const ESC = String.fromCharCode(27)

describe('sgrWheelSequence', () => {
  it('builds SGR wheel reports for both directions', () => {
    expect(sgrWheelSequence('up', 10, 4)).toBe(`${ESC}[<64;10;4M`)
    expect(sgrWheelSequence('down', 10, 4)).toBe(`${ESC}[<65;10;4M`)
  })

  it('keeps cell coordinates one-based and finite', () => {
    expect(sgrWheelSequence('up', 0, -3)).toBe(`${ESC}[<64;1;1M`)
    expect(sgrWheelSequence('up', Number.NaN, 2)).toBe(`${ESC}[<64;1;2M`)
  })
})

describe('wheelMouseTicks', () => {
  it('converts a pixel notch into rows of scroll', () => {
    expect(wheelMouseTicks(120, 0, 20, 30)).toBe(6)
    expect(wheelMouseTicks(-120, 0, 20, 30)).toBe(6)
  })

  it('falls back to a nominal row height before the terminal is measured', () => {
    expect(wheelMouseTicks(120, 0, 0, 30)).toBe(9)
  })

  it('takes line and page deltas at face value', () => {
    expect(wheelMouseTicks(3, 1, 20, 30)).toBe(3)
    expect(wheelMouseTicks(1, 2, 20, 8)).toBe(8)
  })

  it('always moves a row and never floods the program', () => {
    expect(wheelMouseTicks(2, 0, 20, 30)).toBe(1)
    expect(wheelMouseTicks(10_000, 0, 20, 30)).toBe(12)
    expect(wheelMouseTicks(0, 0, 20, 30)).toBe(0)
  })
})

describe('pointToCell', () => {
  const screen = {
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }) as DOMRect,
  }

  it('maps a client point to the cell under it', () => {
    expect(pointToCell(screen, 80, 30, 500, 350)).toEqual({ column: 41, row: 16 })
  })

  it('clamps to the terminal grid and survives a missing screen', () => {
    expect(pointToCell(screen, 80, 30, 5000, 5000)).toEqual({ column: 80, row: 30 })
    expect(pointToCell(screen, 80, 30, 0, 0)).toEqual({ column: 1, row: 1 })
    expect(pointToCell(null, 80, 30, 500, 350)).toEqual({ column: 1, row: 1 })
  })
})
