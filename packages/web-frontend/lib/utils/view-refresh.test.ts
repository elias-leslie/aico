import { describe, expect, it } from 'vitest'
import { viewRefresh } from './view-refresh'

describe('viewRefresh', () => {
  it('reseeds when a view first shows the holder size and the seed was laid out at its own size', () => {
    // Phone seeded at its fitted 43x38, then shown at the holder's 43x20: a
    // repaint would overwrite the 18 history rows above the screen.
    expect(
      viewRefresh(null, { cols: 43, rows: 20 }, { cols: 43, rows: 38 }),
    ).toBe('seed')
    expect(viewRefresh(null, { cols: 43, rows: 20 }, null)).toBe('seed')
  })

  it('repaints when the seed was already at that size', () => {
    expect(
      viewRefresh(null, { cols: 43, rows: 20 }, { cols: 43, rows: 20 }),
    ).toBe('screen')
  })

  it('repaints when the holder size changes while shown at it', () => {
    expect(
      viewRefresh(
        { cols: 43, rows: 20 },
        { cols: 43, rows: 30 },
        { cols: 43, rows: 20 },
      ),
    ).toBe('screen')
  })
})
