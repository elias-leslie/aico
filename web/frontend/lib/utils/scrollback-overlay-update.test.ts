import { describe, expect, it } from 'vitest'
import {
  shouldDeferScrollbackOverlayWrite,
  shouldFlushPendingScrollbackOverlayWrite,
} from './scrollback-overlay-update'

describe('shouldDeferScrollbackOverlayWrite', () => {
  it('defers live updates once the reader has scrolled up', () => {
    expect(
      shouldDeferScrollbackOverlayWrite({
        hasScrolled: true,
        isAtBottom: false,
      }),
    ).toBe(true)
  })

  it('continues following live output before the first scroll or when back at bottom', () => {
    expect(
      shouldDeferScrollbackOverlayWrite({
        hasScrolled: false,
        isAtBottom: true,
      }),
    ).toBe(false)

    expect(
      shouldDeferScrollbackOverlayWrite({
        hasScrolled: true,
        isAtBottom: true,
      }),
    ).toBe(false)
  })
})

describe('shouldFlushPendingScrollbackOverlayWrite', () => {
  it('flushes queued updates only after the reader returns to bottom', () => {
    expect(
      shouldFlushPendingScrollbackOverlayWrite({
        hasPendingLines: true,
        isAtBottom: true,
      }),
    ).toBe(true)
  })

  it('keeps queued updates deferred while the reader is still scrolled up', () => {
    expect(
      shouldFlushPendingScrollbackOverlayWrite({
        hasPendingLines: true,
        isAtBottom: false,
      }),
    ).toBe(false)

    expect(
      shouldFlushPendingScrollbackOverlayWrite({
        hasPendingLines: false,
        isAtBottom: true,
      }),
    ).toBe(false)
  })
})
