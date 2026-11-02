// The note's autosave: waits for a pause in typing, sends only what changed,
// keeps a failed save visible until it is retried, and follows the server
// when nothing is being edited.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutosave } from './use-autosave'

const base = { title: 'Soup', body: '' }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useAutosave', () => {
  it('goes saved, saving, saved and sends only the changed field', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useAutosave({ base, save, delay: 500 }))
    expect(result.current.state).toBe('saved')

    act(() => result.current.edit({ body: 'two onions' }))
    expect(result.current.state).toBe('dirty')
    expect(save).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(save).toHaveBeenCalledWith({ body: 'two onions' })
    expect(result.current.state).toBe('saved')
  })

  it('shows saving while the request is out', async () => {
    let finish = () => {}
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const { result } = renderHook(() => useAutosave({ base, save, delay: 100 }))
    act(() => result.current.edit({ title: 'Soup 2' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(result.current.state).toBe('saving')
    await act(async () => finish())
    expect(result.current.state).toBe('saved')
  })

  it('keeps a failed save visible, then saves on retry', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    const { result } = renderHook(() => useAutosave({ base, save, delay: 100 }))
    act(() => result.current.edit({ body: 'x' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(result.current.state).toBe('error')
    await act(async () => {
      result.current.retry()
    })
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith({ body: 'x' })
    expect(result.current.state).toBe('saved')
  })

  it('takes the server copy when the draft is untouched, not when it is dirty', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const { result, rerender } = renderHook(
      (props: { base: typeof base }) => useAutosave({ base: props.base, save }),
      { initialProps: { base } },
    )
    rerender({ base: { title: 'Soup', body: 'from the phone' } })
    expect(result.current.draft.body).toBe('from the phone')

    act(() => result.current.edit({ title: 'Mine' }))
    rerender({ base: { title: 'Soup', body: 'changed again' } })
    expect(result.current.draft).toEqual({
      title: 'Mine',
      body: 'from the phone',
    })
  })
})
