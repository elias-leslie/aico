import { createRef, forwardRef } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ATermHandle } from '@/components/ATerm'
import { useATermHandle } from './use-a-term-handle'

const search = vi.fn()
const clearSearch = vi.fn()

const Harness = forwardRef<ATermHandle, { sendInput: (data: string) => void }>(
  function Harness({ sendInput }, ref) {
    useATermHandle(ref, {
      reconnect: vi.fn(),
      sendInput,
      status: 'connected',
      aTermRef: { current: null },
      search,
      clearSearch,
    })
    return null
  },
)

describe('useATermHandle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    search.mockReset()
    clearSearch.mockReset()
  })

  it('sends large bracketed pastes in ordered chunks', async () => {
    const sendInput = vi.fn()
    const ref = createRef<ATermHandle>()

    render(<Harness ref={ref} sendInput={sendInput} />)

    await act(async () => {
      ref.current?.pasteInput('x'.repeat(5_000))
      await vi.runAllTimersAsync()
    })

    expect(sendInput).toHaveBeenCalledTimes(7)
    expect(sendInput).toHaveBeenNthCalledWith(1, '\x1b[200~')
    expect(sendInput.mock.calls[1]?.[0]).toHaveLength(1_024)
    expect(sendInput.mock.calls[2]?.[0]).toHaveLength(1_024)
    expect(sendInput.mock.calls[3]?.[0]).toHaveLength(1_024)
    expect(sendInput.mock.calls[4]?.[0]).toHaveLength(1_024)
    expect(sendInput.mock.calls[5]?.[0]).toHaveLength(904)
    expect(sendInput).toHaveBeenNthCalledWith(7, '\x1b[201~')
  })

  it('exposes search helpers on the a-term handle', () => {
    const ref = createRef<ATermHandle>()

    search.mockReturnValue({
      query: 'alpha',
      totalMatches: 2,
      activeIndex: 0,
      found: true,
    })

    render(<Harness ref={ref} sendInput={vi.fn()} />)

    expect(ref.current?.search('alpha')).toEqual({
      query: 'alpha',
      totalMatches: 2,
      activeIndex: 0,
      found: true,
    })

    ref.current?.clearSearch()

    expect(search).toHaveBeenCalledWith('alpha')
    expect(clearSearch).toHaveBeenCalledTimes(1)
  })
})
