import { act, renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useATermSearch } from './use-a-term-search'

function createMockTerm(lines: string[]) {
  return {
    clearSelection: vi.fn(),
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
  it('re-syncs TUI search matches when fresh overlay scrollback arrives', () => {
    let overlayLines: string[] = []
    const activateOverlay = vi.fn()
    const getOverlayLines = () => overlayLines
    const aTermRef = {
      current: createMockTerm(['current context', 'project flag']),
    } as unknown as RefObject<InstanceType<
      typeof import('@xterm/xterm').Terminal
    > | null>

    const { result, rerender } = renderHook(
      ({ overlaySearchVersion }: { overlaySearchVersion: number }) =>
        useATermSearch({
          aTermRef,
          sessionMode: 'agent-codex',
          activateOverlay,
          getOverlayLines,
          overlaySearchVersion,
        }),
      {
        initialProps: {
          overlaySearchVersion: 0,
        },
      },
    )

    act(() => {
      expect(
        result.current.search('project', { direction: 'next', reset: true }),
      ).toEqual({
        query: 'project',
        totalMatches: 1,
        activeIndex: 0,
        found: true,
      })
    })

    expect(activateOverlay).toHaveBeenCalledTimes(1)
    expect(result.current.overlaySearchState).toEqual({
      query: 'project',
      activeIndex: 0,
    })

    overlayLines = ['older context', 'earlier output', 'project flag']

    act(() => {
      rerender({ overlaySearchVersion: 1 })
    })

    expect(result.current.overlaySearchState).toEqual({
      query: 'project',
      activeIndex: 0,
    })
  })
})
