import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setFilesOpener } from '@/lib/files-opener'
import { useAgentShows } from './use-agent-shows'

const first = {
  id: 'ab12cd34ef56',
  session: 'ab12cd34',
  title: 'Report',
  createdAt: '2026-10-27T10:00:00.000Z',
  kind: 'files',
  paths: ['/srv/out/report.md'],
}
const second = {
  ...first,
  id: 'bbbbbbbbbbbb',
  title: 'Second report',
  createdAt: '2026-10-27T10:05:00.000Z',
}
const SEEN_KEY = 'aico:shares-seen-at'

function respond(...shows: unknown[]) {
  return new Response(JSON.stringify({ shows }))
}

async function flushPoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('useAgentShows', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    setFilesOpener(null)
    window.history.replaceState(null, '', '/')
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows new shares once, polling from the last one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond())
      .mockResolvedValueOnce(respond(first))
      .mockResolvedValueOnce(respond())
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAgentShows())
    await flushPoll()
    expect(result.current.show).toBeUndefined()

    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(result.current.show).toEqual(first)
    act(() => result.current.dismiss())
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/api/shows?since=${first.id}`)
    expect(result.current.show).toBeUndefined()
  })

  it('on opening, pops up only shares made since it was last open', async () => {
    window.localStorage.setItem(SEEN_KEY, first.createdAt)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(first, second)),
    )
    const { result } = renderHook(() => useAgentShows())
    await flushPoll()
    expect(result.current.show).toEqual(second)
    act(() => result.current.dismiss())
    expect(result.current.show).toBeUndefined()
    expect(window.localStorage.getItem(SEEN_KEY)).toBe(second.createdAt)
  })

  it('pops up nothing old on a first ever open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(first, second)),
    )
    const { result } = renderHook(() => useAgentShows())
    await flushPoll()
    expect(result.current.show).toBeUndefined()
    expect(window.localStorage.getItem(SEEN_KEY)).toBe(second.createdAt)
  })

  it('suspends requests while hidden and fetches on becoming visible', async () => {
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    const fetchMock = vi.fn(async () => respond(first))
    vi.stubGlobal('fetch', fetchMock)
    renderHook(() => useAgentShows())
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(fetchMock).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await flushPoll()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('opens a push link’s share in Files when a session is open', async () => {
    window.history.replaceState(null, '', `/?show=${first.id}`)
    const opened = vi.fn()
    setFilesOpener(opened)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(first, second)),
    )
    const { result } = renderHook(() => useAgentShows())
    await flushPoll()
    expect(opened).toHaveBeenCalledWith({ kind: 'shared', showId: first.id })
    expect(result.current.show).toBeUndefined()
  })

  it('puts a push link’s share first when no session is open', async () => {
    window.localStorage.setItem(SEEN_KEY, first.createdAt)
    window.history.replaceState(null, '', `/?show=${first.id}`)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(first, second)),
    )
    const { result } = renderHook(() => useAgentShows())
    await flushPoll()
    expect(result.current.show).toEqual(first)
    act(() => result.current.dismiss())
    expect(result.current.show).toEqual(second)
  })

  it('retries failures and refuses shares that are not what the server sends', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(respond({ ...first, paths: ['relative/x'] }))
      .mockResolvedValueOnce(respond(first))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useAgentShows())
    await flushPoll()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(result.current.show).toBeUndefined()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(result.current.show).toBeUndefined()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(result.current.show).toEqual(first)
    unmount()
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[3]?.[1].signal.aborted).toBe(true)
  })
})
