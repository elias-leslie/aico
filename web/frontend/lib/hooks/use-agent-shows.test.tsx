import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentShows } from './use-agent-shows'

const first = {
  id: 'ab12cd34ef56',
  session: 'ab12cd34',
  title: 'Report',
  name: 'ab12cd34/out/report.pdf',
  kind: 'file',
}
const second = { ...first, id: 'bbbbbbbbbbbb', title: 'Second report' }

async function flushPoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('useAgentShows', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })

  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('polls with the last cursor, queues shares, and does not replay duplicates', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ shows: [first] })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ shows: [first, second] })),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAgentShows())
    await flushPoll()
    expect(result.current.show).toEqual(first)
    act(() => result.current.dismiss())
    expect(result.current.show).toBeUndefined()

    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/shows?since=${first.id}`)
    expect(result.current.show).toEqual(second)
    act(() => result.current.dismiss())
    expect(result.current.show).toBeUndefined()
  })

  it('suspends requests while hidden and fetches immediately on becoming visible', async () => {
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ shows: [first] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAgentShows())
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(fetchMock).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await flushPoll()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.show).toEqual(first)
  })

  it('puts the phone link selection first without navigating to a URL', async () => {
    window.history.replaceState(null, '', `/?show=${second.id}`)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ shows: [first, second] })),
      ),
    )
    const { result } = renderHook(() => useAgentShows())
    await flushPoll()
    expect(result.current.show).toEqual(second)
    act(() => result.current.dismiss())
    expect(result.current.show).toEqual(first)
    expect(window.location.search).toBe(`?show=${second.id}`)
  })

  it('retries failures and invalid payloads without accepting an unsafe file ID', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ shows: [{ ...first, id: '../../elsewhere' }] }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ shows: [first] })))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useAgentShows())
    await flushPoll()
    expect(result.current.show).toBeUndefined()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(result.current.show).toBeUndefined()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(result.current.show).toEqual(first)
    unmount()
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2]?.[1].signal.aborted).toBe(true)
  })
})
