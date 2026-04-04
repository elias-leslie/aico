import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useLayoutChangeHandler } from './use-layout-change-handler'

describe('useLayoutChangeHandler', () => {
  it('persists only pane-backed slots', () => {
    const onLayoutChange = vi.fn()
    const displaySlots = [
      {
        type: 'adhoc' as const,
        paneId: 'pane-native',
        sessionId: 'native-session',
        name: 'Ad-Hoc Terminal',
        workingDir: null,
      },
      {
        type: 'adhoc' as const,
        sessionId: 'codex-agent-hub',
        name: 'codex-agent-hub',
        workingDir: '/workspace/agent-hub',
        isExternal: true,
      },
    ]

    const { result } = renderHook(() =>
      useLayoutChangeHandler(displaySlots, 2, onLayoutChange),
    )

    result.current({
      'adhoc-native-session': 50,
      'adhoc-codex-agent-hub': 50,
    })

    expect(onLayoutChange).toHaveBeenCalledWith([
      {
        slotId: 'pane-native',
        widthPercent: 50,
        heightPercent: 100,
        row: 0,
        col: 0,
      },
    ])
  })
})
