import { act, renderHook } from '@testing-library/react'
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
    window.history.replaceState(null, '', '/')
  })

  it('follows the URL modal param', () => {
    mockSearchParams.set('modal', 'a-term-manager')
    const setShowATermManager = vi.fn()

    const { rerender } = renderHook(() =>
      useATermModals({ setShowATermManager }),
    )
    expect(setShowATermManager).toHaveBeenLastCalledWith(true)

    mockSearchParams.delete('modal')
    rerender()
    expect(setShowATermManager).toHaveBeenLastCalledWith(false)
  })

  it('opening a running session closes the picker and switches to it', () => {
    window.history.replaceState(null, '', '/?modal=a-term-manager&session=a')
    const setShowATermManager = vi.fn()

    const { result } = renderHook(() => useATermModals({ setShowATermManager }))
    act(() => result.current.handleOpenSession('b'))

    expect(setShowATermManager).toHaveBeenLastCalledWith(false)
    expect(mockReplace).toHaveBeenCalledWith('/?session=b', { scroll: false })
  })
})
