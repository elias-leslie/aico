import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDetachedPaneWindow } from './use-detached-pane-window'

const mockReplace = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

function getLastUrlParams(): URLSearchParams {
  const [url] = mockReplace.mock.calls.at(-1) ?? ['/']
  return new URL(url as string, 'http://localhost').searchParams
}

describe('useDetachedPaneWindow', () => {
  beforeEach(() => {
    mockReplace.mockReset()
    window.history.replaceState(null, '', '/')
  })

  it('adds any detached pane into an empty scoped detached window', () => {
    window.history.replaceState(null, '', '/?windowScope=scope-1')

    const { result } = renderHook(() => useDetachedPaneWindow())

    act(() => {
      result.current.addDetachedWindowPane('pane-a', 'session-a')
    })

    const params = getLastUrlParams()
    expect(params.get('windowScope')).toBe('scope-1')
    expect(params.get('detachedPane')).toBe('pane-a')
    expect(params.get('windowPanes')).toBe('pane-a')
    expect(params.get('session')).toBe('session-a')
  })

  it('removes the last pane without destroying the detached window scope', () => {
    window.history.replaceState(
      null,
      '',
      '/?windowScope=scope-1&detachedPane=pane-a&windowPanes=pane-a&session=session-a',
    )

    const { result } = renderHook(() => useDetachedPaneWindow())

    act(() => {
      result.current.removeDetachedWindowPane('pane-a', null)
    })

    const params = getLastUrlParams()
    expect(params.get('windowScope')).toBe('scope-1')
    expect(params.get('detachedPane')).toBeNull()
    expect(params.get('windowPanes')).toBeNull()
    expect(params.get('session')).toBeNull()
  })

  it('uses the latest URL pane list when adding and replacing panes', () => {
    window.history.replaceState(
      null,
      '',
      '/?windowScope=scope-1&detachedPane=pane-a&windowPanes=pane-a',
    )

    const { result } = renderHook(() => useDetachedPaneWindow())
    window.history.replaceState(
      null,
      '',
      '/?windowScope=scope-1&detachedPane=pane-a&windowPanes=pane-a,pane-b',
    )

    act(() => {
      result.current.addDetachedWindowPane('pane-c', 'session-c')
    })

    let params = getLastUrlParams()
    expect(params.get('windowPanes')).toBe('pane-a,pane-b,pane-c')

    window.history.replaceState(null, '', `/?${params.toString()}`)

    act(() => {
      result.current.replaceDetachedWindowPane('pane-b', 'pane-d', 'session-d')
    })

    params = getLastUrlParams()
    expect(params.get('windowPanes')).toBe('pane-a,pane-d,pane-c')
    expect(params.get('session')).toBe('session-d')
  })
})
