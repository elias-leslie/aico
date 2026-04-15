import { describe, expect, it, vi } from 'vitest'
import {
  applyInitialOverlayViewportScroll,
  getOverlayViewportRestoreLine,
  applyOverlaySearchSelection,
} from './use-scrollback-a-term'

describe('applyInitialOverlayViewportScroll', () => {
  it('scrolls the overlay when activation carries an initial wheel delta', () => {
    const term = {
      scrollLines: vi.fn(),
    }

    const applied = applyInitialOverlayViewportScroll(term as never, -10)

    expect(applied).toBe(true)
    expect(term.scrollLines).toHaveBeenCalledWith(-10)
  })

  it('does nothing when there is no pending initial delta', () => {
    const term = {
      scrollLines: vi.fn(),
    }

    const applied = applyInitialOverlayViewportScroll(term as never, 0)

    expect(applied).toBe(false)
    expect(term.scrollLines).not.toHaveBeenCalled()
  })
})

describe('applyOverlaySearchSelection', () => {
  it('selects against rendered buffer lines instead of logical pre-wrap lines', () => {
    const clearSelection = vi.fn()
    const select = vi.fn()
    const scrollToLine = vi.fn()
    const term = {
      rows: 20,
      clearSelection,
      select,
      scrollToLine,
      buffer: {
        active: {
          baseY: 1,
          cursorY: 0,
          getLine: (index: number) => {
            const lines = ['very long logical ', 'line with needle']
            const value = lines[index]
            if (value === undefined) return undefined
            return {
              translateToString: () => value,
            }
          },
        },
      },
    }

    const applied = applyOverlaySearchSelection(term as never, 'needle', 0)

    expect(applied).toBe(true)
    expect(clearSelection).toHaveBeenCalled()
    expect(select).toHaveBeenCalledWith(10, 1, 6)
  })

  it('clears selection when the rendered buffer no longer contains the query', () => {
    const clearSelection = vi.fn()
    const select = vi.fn()
    const scrollToLine = vi.fn()
    const term = {
      rows: 20,
      clearSelection,
      select,
      scrollToLine,
      buffer: {
        active: {
          baseY: 1,
          cursorY: 0,
          getLine: (index: number) => {
            const lines = ['very long logical ', 'line without it']
            const value = lines[index]
            if (value === undefined) return undefined
            return {
              translateToString: () => value,
            }
          },
        },
      },
    }

    const applied = applyOverlaySearchSelection(term as never, 'needle', 0)

    expect(applied).toBe(false)
    expect(clearSelection).toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    expect(scrollToLine).not.toHaveBeenCalled()
  })
})

describe('getOverlayViewportRestoreLine', () => {
  it('keeps the same viewport line when refreshed content grows', () => {
    expect(getOverlayViewportRestoreLine(120, 180)).toBe(120)
  })

  it('clamps to the newest base line when refreshed content shrinks', () => {
    expect(getOverlayViewportRestoreLine(120, 90)).toBe(90)
  })
})
