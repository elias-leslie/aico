import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useScrollbackOverlay } from './use-scrollback-overlay'

describe('useScrollbackOverlay', () => {
  function createMockWsRef() {
    return {
      current: {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      },
    } as unknown as React.RefObject<WebSocket | null>
  }

  it('does not shrink active overlay content when a shorter sync arrives', () => {
    const wsRef = createMockWsRef()

    const { result } = renderHook(() =>
      useScrollbackOverlay({
        wsRef,
        sessionMode: 'agent-hermes',
      }),
    )

    act(() => {
      result.current.updateCacheFromSync('line-1\r\nline-2\r\nline-3\r\n')
    })
    act(() => {
      result.current.activate()
    })

    expect(result.current.lines).toEqual(['line-1', 'line-2', 'line-3'])
    expect(result.current.totalLines).toBe(3)

    act(() => {
      result.current.updateCacheFromSync('line-1\r\n')
    })

    expect(result.current.lines).toEqual(['line-1', 'line-2', 'line-3'])
    expect(result.current.totalLines).toBe(3)
  })

  it('does not replace an active longer overlay with a shorter page response', () => {
    const wsRef = createMockWsRef()

    const { result } = renderHook(() =>
      useScrollbackOverlay({
        wsRef,
        sessionMode: 'agent-hermes',
      }),
    )

    act(() => {
      result.current.updateCacheFromSync(
        'line-1\r\nline-2\r\nline-3\r\nline-4\r\n',
      )
    })
    act(() => {
      result.current.activate()
    })

    act(() => {
      result.current.handleScrollbackPage({
        from_line: 0,
        lines: ['line-1', 'line-2'],
        total_lines: 120,
      })
    })

    expect(result.current.lines).toEqual([
      'line-1',
      'line-2',
      'line-3',
      'line-4',
    ])
    expect(result.current.totalLines).toBe(120)
  })

  it('still grows the active overlay when a larger sync arrives', () => {
    const wsRef = createMockWsRef()

    const { result } = renderHook(() =>
      useScrollbackOverlay({
        wsRef,
        sessionMode: 'agent-hermes',
      }),
    )

    act(() => {
      result.current.updateCacheFromSync('line-1\r\nline-2\r\n')
    })
    act(() => {
      result.current.activate()
    })
    act(() => {
      result.current.updateCacheFromSync(
        'line-1\r\nline-2\r\nline-3\r\nline-4\r\n',
      )
    })

    expect(result.current.lines).toEqual([
      'line-1',
      'line-2',
      'line-3',
      'line-4',
    ])
    expect(result.current.totalLines).toBe(4)
  })
})
