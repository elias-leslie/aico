import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useATermModals } from './use-a-term-modals'

const mockReplace = vi.fn()
const mockSearchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
  usePathname: () => '/',
  useSearchParams: () => mockSearchParams,
}))

describe('useATermModals', () => {
  beforeEach(() => {
    mockReplace.mockReset()
    for (const key of Array.from(mockSearchParams.keys())) {
      mockSearchParams.delete(key)
    }
  })

  it('opens the a-term manager when the URL modal param targets it', () => {
    mockSearchParams.set('modal', 'a-term-manager')

    const setShowATermManager = vi.fn()
    const setShowKeyboardHelp = vi.fn()

    renderHook(() =>
      useATermModals({
        showATermManager: false,
        setShowATermManager,
        showKeyboardHelp: false,
        setShowKeyboardHelp,
      }),
    )

    expect(setShowATermManager).toHaveBeenCalledWith(true)
    expect(setShowKeyboardHelp).toHaveBeenCalledWith(false)
  })

  it('closes both overlays when the URL modal param is cleared', () => {
    const setShowATermManager = vi.fn()
    const setShowKeyboardHelp = vi.fn()

    const { rerender } = renderHook(() =>
      useATermModals({
        showATermManager: true,
        setShowATermManager,
        showKeyboardHelp: true,
        setShowKeyboardHelp,
      }),
    )

    mockSearchParams.set('modal', 'a-term-manager')
    rerender()

    setShowATermManager.mockClear()
    setShowKeyboardHelp.mockClear()

    mockSearchParams.delete('modal')
    rerender()

    expect(setShowATermManager).toHaveBeenCalledWith(false)
    expect(setShowKeyboardHelp).toHaveBeenCalledWith(false)
  })

  it('switches visible overlays when the URL modal param changes', () => {
    const setShowATermManager = vi.fn()
    const setShowKeyboardHelp = vi.fn()

    mockSearchParams.set('modal', 'a-term-manager')

    const { rerender } = renderHook(() =>
      useATermModals({
        showATermManager: true,
        setShowATermManager,
        showKeyboardHelp: false,
        setShowKeyboardHelp,
      }),
    )

    setShowATermManager.mockClear()
    setShowKeyboardHelp.mockClear()

    mockSearchParams.set('modal', 'keyboard-shortcuts')
    rerender()

    expect(setShowATermManager).toHaveBeenCalledWith(false)
    expect(setShowKeyboardHelp).toHaveBeenCalledWith(true)
  })

  it('runs the external attach callback while keeping session URL sync', () => {
    const setShowATermManager = vi.fn()
    const setShowKeyboardHelp = vi.fn()
    const onAttachExternalSession = vi.fn()

    const { result } = renderHook(() =>
      useATermModals({
        showATermManager: true,
        setShowATermManager,
        showKeyboardHelp: false,
        setShowKeyboardHelp,
        onAttachExternalSession,
      }),
    )

    result.current.handleAttachExternalSession('codex-a-term')

    expect(onAttachExternalSession).toHaveBeenCalledWith('codex-a-term')
    expect(mockReplace).toHaveBeenCalledWith('/?session=codex-a-term', {
      scroll: false,
    })
  })

  it('runs the detached pane attach callback and syncs the active session URL', async () => {
    const setShowATermManager = vi.fn()
    const setShowKeyboardHelp = vi.fn()
    const onAttachDetachedPane = vi.fn().mockResolvedValue({
      sessionId: 'managed-session-1',
    })

    const { result } = renderHook(() =>
      useATermModals({
        showATermManager: true,
        setShowATermManager,
        showKeyboardHelp: false,
        setShowKeyboardHelp,
        onAttachDetachedPane,
      }),
    )

    await result.current.handleAttachDetachedPane('pane-1')

    expect(onAttachDetachedPane).toHaveBeenCalledWith('pane-1')
    expect(mockReplace).toHaveBeenCalledWith('/?session=managed-session-1', {
      scroll: false,
    })
  })

  it('merges detached-window URL updates when attaching a pane into an empty scoped window', async () => {
    const setShowATermManager = vi.fn()
    const setShowKeyboardHelp = vi.fn()
    mockSearchParams.set('modal', 'a-term-manager')
    mockSearchParams.set('windowScope', 'scope-1')
    mockSearchParams.set('detachedPane', 'old-pane')
    const onAttachDetachedPane = vi.fn().mockResolvedValue({
      sessionId: 'managed-session-2',
      urlUpdates: {
        detachedPane: 'pane-2',
        windowPanes: 'pane-2',
        windowScope: 'scope-1',
      },
    })

    const { result } = renderHook(() =>
      useATermModals({
        showATermManager: true,
        setShowATermManager,
        showKeyboardHelp: false,
        setShowKeyboardHelp,
        onAttachDetachedPane,
      }),
    )

    await result.current.handleAttachDetachedPane('pane-2')

    expect(mockReplace).toHaveBeenCalledTimes(1)
    const [url, options] = mockReplace.mock.calls[0]
    const params = new URL(url, 'http://localhost').searchParams

    expect(params.get('windowScope')).toBe('scope-1')
    expect(params.get('detachedPane')).toBe('pane-2')
    expect(params.get('windowPanes')).toBe('pane-2')
    expect(params.get('session')).toBe('managed-session-2')
    expect(options).toEqual({ scroll: false })
  })
})
