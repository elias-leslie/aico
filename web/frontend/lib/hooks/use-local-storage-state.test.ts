import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, beforeEach } from 'vitest'
import { useLocalStorageState } from './use-local-storage-state'

describe('useLocalStorageState', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('persists non-null values', () => {
    const { result } = renderHook(() =>
      useLocalStorageState('aTerm:test-key', 'default'),
    )

    act(() => {
      result.current[1]('persisted')
    })

    expect(result.current[0]).toBe('persisted')
    expect(window.localStorage.getItem('aTerm:test-key')).toBe('"persisted"')
  })

  it('removes the storage entry when set to null', () => {
    window.localStorage.setItem('aTerm:test-key', '"persisted"')

    const { result } = renderHook(() =>
      useLocalStorageState<string | null>('aTerm:test-key', 'default'),
    )

    act(() => {
      result.current[1](null)
    })

    expect(result.current[0]).toBe(null)
    expect(window.localStorage.getItem('aTerm:test-key')).toBeNull()
  })

  it('supports functional updates', () => {
    const { result } = renderHook(() =>
      useLocalStorageState('aTerm:test-key', ['a']),
    )

    act(() => {
      result.current[1]((current) => [...current, 'b'])
    })

    expect(result.current[0]).toEqual(['a', 'b'])
    expect(window.localStorage.getItem('aTerm:test-key')).toBe('["a","b"]')
  })
})
