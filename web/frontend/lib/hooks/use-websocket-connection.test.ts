import { describe, expect, it, vi } from 'vitest'
import { dispatchControlMessage } from './use-websocket-connection'

function buildCallbacks() {
  return {
    onScrollbackPage: vi.fn(),
    setStatus: vi.fn(),
  }
}

describe('dispatchControlMessage', () => {
  it('returns false for non-control payloads', () => {
    const callbacks = buildCallbacks()

    expect(dispatchControlMessage('{"message":"hello"}', callbacks)).toBe(false)
    expect(callbacks.onScrollbackPage).not.toHaveBeenCalled()
  })

  it('swallows unknown control frames such as backpressure commits', () => {
    const callbacks = buildCallbacks()

    expect(
      dispatchControlMessage('{"__ctrl":true,"commit":262412}', callbacks),
    ).toBe(true)
    expect(callbacks.onScrollbackPage).not.toHaveBeenCalled()
  })

  it('dispatches known scrollback page control frames', () => {
    const callbacks = buildCallbacks()

    expect(
      dispatchControlMessage(
        '{"__ctrl":true,"scrollback_page":{"from_line":5,"lines":["a"],"total_lines":10}}',
        callbacks,
      ),
    ).toBe(true)
    expect(callbacks.onScrollbackPage).toHaveBeenCalledWith({
      from_line: 5,
      lines: ['a'],
      total_lines: 10,
    })
  })
})
