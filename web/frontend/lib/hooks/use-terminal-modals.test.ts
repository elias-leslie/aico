import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalModals } from './use-terminal-modals'

const mockReplace = vi.fn()
const mockSearchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
  usePathname: () => '/',
  useSearchParams: () => mockSearchParams,
}))

describe('useTerminalModals', () => {
  beforeEach(() => {
    mockReplace.mockReset()
    for (const key of Array.from(mockSearchParams.keys())) {
      mockSearchParams.delete(key)
    }
  })

  it('opens the terminal manager when the URL modal param targets it', () => {
    mockSearchParams.set('modal', 'terminal-manager')

    const setShowTerminalManager = vi.fn()
    const setShowKeyboardHelp = vi.fn()

    renderHook(() =>
      useTerminalModals({
        showTerminalManager: false,
        setShowTerminalManager,
        showKeyboardHelp: false,
        setShowKeyboardHelp,
      }),
    )

    expect(setShowTerminalManager).toHaveBeenCalledWith(true)
    expect(setShowKeyboardHelp).toHaveBeenCalledWith(false)
  })

  it('closes both overlays when the URL modal param is cleared', () => {
    const setShowTerminalManager = vi.fn()
    const setShowKeyboardHelp = vi.fn()

    const { rerender } = renderHook(() =>
      useTerminalModals({
        showTerminalManager: true,
        setShowTerminalManager,
        showKeyboardHelp: true,
        setShowKeyboardHelp,
      }),
    )

    mockSearchParams.set('modal', 'terminal-manager')
    rerender()

    setShowTerminalManager.mockClear()
    setShowKeyboardHelp.mockClear()

    mockSearchParams.delete('modal')
    rerender()

    expect(setShowTerminalManager).toHaveBeenCalledWith(false)
    expect(setShowKeyboardHelp).toHaveBeenCalledWith(false)
  })

  it('switches visible overlays when the URL modal param changes', () => {
    const setShowTerminalManager = vi.fn()
    const setShowKeyboardHelp = vi.fn()

    mockSearchParams.set('modal', 'terminal-manager')

    const { rerender } = renderHook(() =>
      useTerminalModals({
        showTerminalManager: true,
        setShowTerminalManager,
        showKeyboardHelp: false,
        setShowKeyboardHelp,
      }),
    )

    setShowTerminalManager.mockClear()
    setShowKeyboardHelp.mockClear()

    mockSearchParams.set('modal', 'keyboard-shortcuts')
    rerender()

    expect(setShowTerminalManager).toHaveBeenCalledWith(false)
    expect(setShowKeyboardHelp).toHaveBeenCalledWith(true)
  })

  it('runs the external attach callback while keeping session URL sync', () => {
    const setShowTerminalManager = vi.fn()
    const setShowKeyboardHelp = vi.fn()
    const onAttachExternalSession = vi.fn()

    const { result } = renderHook(() =>
      useTerminalModals({
        showTerminalManager: true,
        setShowTerminalManager,
        showKeyboardHelp: false,
        setShowKeyboardHelp,
        onAttachExternalSession,
      }),
    )

    result.current.handleAttachExternalSession('codex-terminal')

    expect(onAttachExternalSession).toHaveBeenCalledWith('codex-terminal')
    expect(mockReplace).toHaveBeenCalledWith('/?session=codex-terminal', { scroll: false })
  })

  it('runs the detached pane attach callback and syncs the active session URL', async () => {
    const setShowTerminalManager = vi.fn()
    const setShowKeyboardHelp = vi.fn()
    const onAttachDetachedPane = vi.fn().mockResolvedValue('managed-session-1')

    const { result } = renderHook(() =>
      useTerminalModals({
        showTerminalManager: true,
        setShowTerminalManager,
        showKeyboardHelp: false,
        setShowKeyboardHelp,
        onAttachDetachedPane,
      }),
    )

    await result.current.handleAttachDetachedPane('pane-1')

    expect(onAttachDetachedPane).toHaveBeenCalledWith('pane-1')
    expect(mockReplace).toHaveBeenCalledWith('/?session=managed-session-1', { scroll: false })
  })
})
