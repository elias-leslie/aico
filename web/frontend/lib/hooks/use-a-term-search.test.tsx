import { act, renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useATermSearch } from './use-a-term-search'

function createMockTerm(lines: string[]) {
  return {
    rows: 24,
    clearSelection: vi.fn(),
    select: vi.fn(),
    scrollToLine: vi.fn(),
    buffer: {
      active: {
        baseY: lines.length - 1,
        cursorY: 0,
        getLine: (index: number) => {
          const value = lines[index]
          if (value === undefined) return undefined
          return {
            translateToString: () => value,
          }
        },
      },
    },
  }
}

describe('useATermSearch', () => {
  it('selects matches in the terminal buffer and steps through them', () => {
    const term = createMockTerm(['project one', 'other', 'project two'])
    const aTermRef = {
      current: term,
    } as unknown as RefObject<InstanceType<
      typeof import('@xterm/xterm').Terminal
    > | null>
    const { result } = renderHook(() => useATermSearch({ aTermRef }))

    act(() => {
      expect(result.current.search('project')).toEqual({
        query: 'project',
        totalMatches: 2,
        activeIndex: 0,
        found: true,
      })
    })
    expect(term.select).toHaveBeenLastCalledWith(0, 0, 7)

    act(() => {
      expect(result.current.search('project', { direction: 'next' })).toEqual({
        query: 'project',
        totalMatches: 2,
        activeIndex: 1,
        found: true,
      })
    })
    expect(term.select).toHaveBeenLastCalledWith(0, 2, 7)
  })

  it('reports no match and clears the selection', () => {
    const term = createMockTerm(['nothing here'])
    const aTermRef = {
      current: term,
    } as unknown as RefObject<InstanceType<
      typeof import('@xterm/xterm').Terminal
    > | null>
    const { result } = renderHook(() => useATermSearch({ aTermRef }))

    act(() => {
      expect(result.current.search('absent').found).toBe(false)
    })
    expect(term.clearSelection).toHaveBeenCalled()
  })
})
