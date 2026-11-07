import { QueryClient } from '@tanstack/react-query'
// The store is read through the hook in components; here through a probe.
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '../api-fetch'
import {
  isUnreachable,
  markAnswered,
  markFailed,
  resetServerReachForTest,
  useServerReach,
  watchServerReach,
} from './server-reach'

afterEach(() => resetServerReachForTest())

describe('server reach', () => {
  it('counts no answer and a gateway saying the server is gone, not a refusal', () => {
    expect(isUnreachable(new TypeError('Failed to fetch'))).toBe(true)
    expect(isUnreachable(new ApiError('Bad gateway', 502))).toBe(true)
    expect(isUnreachable(new ApiError('Not found', 404))).toBe(false)
    expect(isUnreachable(new ApiError('Server error', 500))).toBe(false)
  })

  it('is down since the last answer, and up again on the next one', () => {
    const { result } = renderHook(() => useServerReach())
    act(() => markAnswered(1_000))
    expect(result.current.down).toBe(false)
    act(() => markFailed(5_000))
    expect(result.current).toEqual({ down: true, since: 1_000 })
    act(() => markAnswered(9_000))
    expect(result.current.down).toBe(false)
  })

  it('without any answer on this load, says since the first failure', () => {
    const { result } = renderHook(() => useServerReach())
    act(() => markFailed(2_000))
    act(() => markFailed(3_000))
    expect(result.current).toEqual({ down: true, since: 2_000 })
  })

  it('follows the session list poll: one failed try is a blip, a failed read is down', async () => {
    const client = new QueryClient()
    const stop = watchServerReach(client)
    const { result } = renderHook(() => useServerReach())
    await act(() =>
      client
        .fetchQuery({
          queryKey: ['terminal-sessions', true],
          queryFn: () => Promise.reject(new TypeError('Failed to fetch')),
          retry: false,
        })
        .catch(() => {}),
    )
    expect(result.current.down).toBe(true)
    await act(() =>
      client.fetchQuery({
        queryKey: ['terminal-sessions', true],
        queryFn: () => Promise.resolve([]),
      }),
    )
    expect(result.current.down).toBe(false)
    // Another query failing says nothing about the Aico server.
    await act(() =>
      client
        .fetchQuery({
          queryKey: ['hosts'],
          queryFn: () => Promise.reject(new TypeError('Failed to fetch')),
          retry: false,
        })
        .catch(() => {}),
    )
    expect(result.current.down).toBe(false)
    stop()
  })
})
