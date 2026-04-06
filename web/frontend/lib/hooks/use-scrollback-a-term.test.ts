import { describe, expect, it, vi } from 'vitest'
import { applyInitialOverlayViewportScroll } from './use-scrollback-a-term'

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
