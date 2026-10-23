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
    window.history.replaceState(null, '', '/')
  })

  it('follows the URL modal param', () => {
    mockSearchParams.set('modal', 'terminal-manager')
    const setShowTerminalManager = vi.fn()

    const { rerender } = renderHook(() =>
      useTerminalModals({ setShowTerminalManager }),
    )
    expect(setShowTerminalManager).toHaveBeenLastCalledWith(true)

    mockSearchParams.delete('modal')
    rerender()
    expect(setShowTerminalManager).toHaveBeenLastCalledWith(false)
  })
})
