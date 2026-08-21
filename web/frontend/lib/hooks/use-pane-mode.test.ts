import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { usePaneMode } from './use-pane-mode'

function setup() {
  const send = vi.fn()
  const wsRef = { current: { readyState: WebSocket.OPEN, send } }
  const { result } = renderHook(() =>
    usePaneMode(wsRef as unknown as React.RefObject<WebSocket | null>),
  )
  return { send, result }
}

describe('usePaneMode', () => {
  it('knows nothing until the session answers', () => {
    const { result } = setup()
    expect(result.current.paneOwnsScrollback()).toBeNull()
  })

  it('reports app-owned scrollback for an alternate-screen mouse grabber', () => {
    const { result } = setup()
    // Claude Code.
    result.current.handlePaneMode({
      alternate_screen: true,
      mouse_reporting: true,
    })
    expect(result.current.paneOwnsScrollback()).toBe(true)
  })

  it('leaves tmux-backed panes to the scrollback overlay', () => {
    const { result } = setup()
    // Antigravity: normal screen, no mouse grab.
    result.current.handlePaneMode({
      alternate_screen: false,
      mouse_reporting: false,
    })
    expect(result.current.paneOwnsScrollback()).toBe(false)
    // A half-match is not ownership either.
    result.current.handlePaneMode({
      alternate_screen: true,
      mouse_reporting: false,
    })
    expect(result.current.paneOwnsScrollback()).toBe(false)
  })

  it('forgets a stale answer so callers fall back to xterm', () => {
    vi.useFakeTimers()
    try {
      const { result } = setup()
      result.current.handlePaneMode({
        alternate_screen: true,
        mouse_reporting: true,
      })
      vi.advanceTimersByTime(1600)
      expect(result.current.paneOwnsScrollback()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks the session once per staleness window', () => {
    vi.useFakeTimers()
    try {
      const { send, result } = setup()
      result.current.requestPaneMode()
      result.current.requestPaneMode()
      expect(send).toHaveBeenCalledTimes(1)
      expect(JSON.parse(send.mock.calls[0][0])).toEqual({
        __ctrl: true,
        pane_mode_request: true,
      })
      vi.advanceTimersByTime(1600)
      result.current.requestPaneMode()
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not ask again while a fresh answer is in hand', () => {
    const { send, result } = setup()
    result.current.handlePaneMode({
      alternate_screen: true,
      mouse_reporting: true,
    })
    result.current.requestPaneMode()
    expect(send).not.toHaveBeenCalled()
  })
})
