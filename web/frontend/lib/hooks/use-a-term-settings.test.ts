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

  it('falls back to global settings when project settings are missing', () => {
    writeSettings('a-term-settings', {
      fontId: 'fira-code',
      fontSize: 16,
      scrollback: 5000,
      cursorStyle: 'underline',
      cursorBlink: false,
      themeId: 'dracula',
    })

    const { result } = renderHook(() => useATermSettings('project-a'))

    expect(result.current.fontId).toBe('fira-code')
    expect(result.current.fontSize).toBe(16)
    expect(result.current.scrollback).toBe(5000)
    expect(result.current.cursorStyle).toBe('underline')
    expect(result.current.cursorBlink).toBe(false)
    expect(result.current.themeId).toBe('dracula')
  })

  it('reloads project-scoped settings when projectId changes', async () => {
    writeSettings('a-term-settings', {
      fontId: 'jetbrains-mono',
      fontSize: 14,
      scrollback: 10000,
      cursorStyle: 'block',
      cursorBlink: true,
      themeId: 'phosphor',
    })
    writeSettings('a-term-settings-project-project-a', {
      fontId: 'fira-code',
      fontSize: 18,
      scrollback: 25000,
      cursorStyle: 'bar',
      cursorBlink: false,
      themeId: 'dracula',
    })

    const { result, rerender } = renderHook(
      ({ projectId }: HookProps) => useATermSettings(projectId),
      { initialProps: { projectId: undefined } as HookProps },
    )

    expect(result.current.fontId).toBe('jetbrains-mono')

    rerender({ projectId: 'project-a' })

    await waitFor(() => {
      expect(result.current.fontId).toBe('fira-code')
      expect(result.current.fontSize).toBe(18)
      expect(result.current.scrollback).toBe(25000)
      expect(result.current.cursorStyle).toBe('bar')
      expect(result.current.cursorBlink).toBe(false)
      expect(result.current.themeId).toBe('dracula')
    })
  })

  it('reloads global settings when leaving a project scope', async () => {
    writeSettings('a-term-settings', {
      fontId: 'source-code-pro',
      fontSize: 15,
      scrollback: 5000,
      cursorStyle: 'underline',
      cursorBlink: true,
      themeId: 'tokyo-night',
    })
    writeSettings('a-term-settings-project-project-a', {
      fontId: 'fira-code',
      fontSize: 18,
      scrollback: 25000,
      cursorStyle: 'bar',
      cursorBlink: false,
      themeId: 'dracula',
    })

    const { result, rerender } = renderHook(
      ({ projectId }: HookProps) => useATermSettings(projectId),
      { initialProps: { projectId: 'project-a' } as HookProps },
    )

    expect(result.current.fontId).toBe('fira-code')

    rerender({ projectId: undefined })

    await waitFor(() => {
      expect(result.current.fontId).toBe('source-code-pro')
      expect(result.current.fontSize).toBe(15)
      expect(result.current.scrollback).toBe(5000)
      expect(result.current.cursorStyle).toBe('underline')
      expect(result.current.cursorBlink).toBe(true)
      expect(result.current.themeId).toBe('tokyo-night')
    })
  })

  it('keeps updating in-memory settings when storage writes fail', () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota exceeded')
      })

    const { result } = renderHook(() => useATermSettings())

    expect(() => {
      act(() => {
        result.current.setThemeId('dracula')
      })
    }).not.toThrow()

    expect(result.current.themeId).toBe('dracula')

    setItemSpy.mockRestore()
  })
})
