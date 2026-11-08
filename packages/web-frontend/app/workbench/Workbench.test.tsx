import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchScreen as WorkbenchPage } from './Workbench'

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  params: new URLSearchParams(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  useSearchParams: () => nav.params,
}))
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => true }))
vi.mock('@/lib/frame/shown-project', () => ({ shownProject: () => null }))
vi.mock('@/components/workbench/tab-views', () => ({
  TAB_VIEWS: {
    notes: { icon: () => null, Content: () => <p>The notes view</p> },
    files: { icon: () => null, Content: () => <p>The files view</p> },
    designs: { icon: () => null, Content: () => <p>The designs view</p> },
  },
}))

const popup = () => ({ focus: vi.fn() }) as unknown as Window

beforeEach(() => {
  nav.replace.mockReset()
  nav.params = new URLSearchParams()
  window.name = ''
  localStorage.clear()
})
afterEach(() => vi.restoreAllMocks())

describe('Workbench', () => {
  it('shows the tab the address names, and moves between tabs keeping the project', () => {
    nav.params = new URLSearchParams('tab=files&project=aico&path=/tmp')
    render(<WorkbenchPage />)
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByText('The files view')).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Notes' }))
    expect(nav.replace).toHaveBeenCalledWith(
      '/workbench?tab=notes&project=aico',
    )
  })

  it('opens on the first tab when the address names none', () => {
    render(<WorkbenchPage />)
    expect(screen.getByText('The notes view')).toBeVisible()
  })

  it('splits a tab into a window of its own, carrying its place, and moves on to another', () => {
    nav.params = new URLSearchParams('tab=files&project=aico&path=/tmp')
    const open = vi.spyOn(window, 'open').mockReturnValue(popup())
    render(<WorkbenchPage />)
    fireEvent.click(screen.getByTestId('workbench-split-files'))
    expect(open).toHaveBeenCalledWith(
      '/workbench?tab=files&project=aico&path=%2Ftmp',
      'aico-workbench-files',
      expect.stringContaining('popup'),
    )
    expect(nav.replace).toHaveBeenCalledWith(
      '/workbench?tab=notes&project=aico',
    )
  })

  it('says so when the browser blocks the new window, and stays on the tab', () => {
    nav.params = new URLSearchParams('tab=files')
    vi.spyOn(window, 'open').mockReturnValue(null)
    render(<WorkbenchPage />)
    fireEvent.click(screen.getByTestId('workbench-split-files'))
    expect(screen.getByRole('alert').textContent).toBe('Pop-up blocked')
    expect(nav.replace).not.toHaveBeenCalled()
  })

  it('points a tab that has its own window at that window and brings it forward', () => {
    nav.params = new URLSearchParams('tab=files&project=aico')
    localStorage.setItem('aico-workbench-split:files', String(Date.now()))
    const open = vi.spyOn(window, 'open').mockReturnValue(popup())
    render(<WorkbenchPage />)
    expect(screen.getByTestId('workbench-apart').textContent).toContain(
      'Files is open in its own window',
    )
    expect(screen.queryByText('The files view')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show Files' }))
    expect(open).toHaveBeenCalledWith(
      '/workbench?tab=files&project=aico',
      'aico-workbench-files',
      expect.any(String),
    )
  })

  it('in a tab’s own window shows that tab alone and tells the others it is there', () => {
    window.name = 'aico-workbench-files'
    nav.params = new URLSearchParams('tab=notes')
    const { unmount } = render(<WorkbenchPage />)
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByText('The files view')).toBeVisible()
    expect(screen.queryByTestId('workbench-split-files')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Back to sessions' })).toBeNull()
    expect(localStorage.getItem('aico-workbench-split:files')).not.toBeNull()
    act(() => unmount())
    expect(localStorage.getItem('aico-workbench-split:files')).toBeNull()
  })
})
