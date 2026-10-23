import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useATermSettings } from './use-a-term-settings'

interface HookProps {
  projectId: string | undefined
}

function writeSettings(key: string, value: Record<string, unknown>) {
  window.localStorage.setItem(key, JSON.stringify(value))
}

describe('useATermSettings', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('falls back to the global size when the project has none', () => {
    // Settings saved by older versions carry fields that are now ignored.
    writeSettings('a-term-settings', {
      fontId: 'fira-code',
      fontSize: 16,
      themeId: 'dracula',
    })

    const { result } = renderHook(() => useATermSettings('project-a'))

    expect(result.current).toEqual({
      fontSize: 16,
      setFontSize: expect.any(Function),
    })
  })

  it('reloads the size when the project changes', async () => {
    writeSettings('a-term-settings', { fontSize: 14 })
    writeSettings('a-term-settings-project-project-a', { fontSize: 18 })

    const { result, rerender } = renderHook(
      ({ projectId }: HookProps) => useATermSettings(projectId),
      { initialProps: { projectId: undefined } as HookProps },
    )

    expect(result.current.fontSize).toBe(14)

    rerender({ projectId: 'project-a' })
    await waitFor(() => expect(result.current.fontSize).toBe(18))

    rerender({ projectId: undefined })
    await waitFor(() => expect(result.current.fontSize).toBe(14))
  })

  it('saves the size under the project key', () => {
    const { result } = renderHook(() => useATermSettings('project-a'))

    act(() => result.current.setFontSize(12))

    expect(
      JSON.parse(
        window.localStorage.getItem('a-term-settings-project-project-a') ?? '',
      ),
    ).toEqual({ fontSize: 12 })
  })

  it('keeps the new size in memory when storage writes fail', () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota exceeded')
      })

    const { result } = renderHook(() => useATermSettings())

    expect(() => {
      act(() => result.current.setFontSize(18))
    }).not.toThrow()
    expect(result.current.fontSize).toBe(18)

    setItemSpy.mockRestore()
  })
})
