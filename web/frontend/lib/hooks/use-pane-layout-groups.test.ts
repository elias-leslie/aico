import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { usePaneLayoutGroups } from './use-pane-layout-groups'

describe('usePaneLayoutGroups', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('uses the new storage bucket immediately when the storage key changes', () => {
    window.localStorage.setItem(
      'a-term-layout-groups:grid-3x2:5',
      JSON.stringify({
        'wide-pane-root': [70, 30],
      }),
    )
    window.localStorage.setItem(
      'a-term-layout-groups:grid-3x2:6',
      JSON.stringify({
        'wide-pane-root': [45, 55],
      }),
    )

    const { result, rerender } = renderHook(
      ({ storageKey }: { storageKey: string }) =>
        usePaneLayoutGroups(storageKey),
      {
        initialProps: { storageKey: 'a-term-layout-groups:grid-3x2:5' },
      },
    )

    expect(result.current.getGroupSizes('wide-pane-root', 2, 50)).toEqual([
      70, 30,
    ])

    rerender({ storageKey: 'a-term-layout-groups:grid-3x2:6' })

    expect(result.current.getGroupSizes('wide-pane-root', 2, 50)).toEqual([
      45, 55,
    ])
  })

  it('writes updates into the active storage bucket after a key change', () => {
    const { result, rerender } = renderHook(
      ({ storageKey }: { storageKey: string }) =>
        usePaneLayoutGroups(storageKey),
      {
        initialProps: { storageKey: 'a-term-layout-groups:grid-3x2:5' },
      },
    )

    rerender({ storageKey: 'a-term-layout-groups:grid-3x2:6' })
    act(() => {
      result.current.updateGroupSizes('wide-pane-root', [40, 60])
    })

    expect(window.localStorage.getItem('a-term-layout-groups:grid-3x2:6')).toBe(
      '{"wide-pane-root":[40,60]}',
    )
    expect(
      window.localStorage.getItem('a-term-layout-groups:grid-3x2:5'),
    ).toBeNull()
  })

  it('persists updates without rerendering the hook during resize', () => {
    let renderCount = 0

    const { result } = renderHook(() => {
      renderCount += 1
      return usePaneLayoutGroups('a-term-layout-groups:split-horizontal:2')
    })

    act(() => {
      result.current.updateGroupSizes('two-pane-horizontal', [62, 38])
    })

    expect(renderCount).toBe(1)
    expect(result.current.getGroupSizes('two-pane-horizontal', 2, 50)).toEqual([
      62, 38,
    ])
    expect(
      window.localStorage.getItem('a-term-layout-groups:split-horizontal:2'),
    ).toBe('{"two-pane-horizontal":[62,38]}')
  })
})
