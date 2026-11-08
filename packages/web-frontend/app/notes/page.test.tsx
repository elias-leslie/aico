import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NotesPage from './page'

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  params: new URLSearchParams(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  useSearchParams: () => nav.params,
}))
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => true }))
vi.mock('@/components/capture/CaptureLauncher', () => ({
  CaptureLauncher: () => null,
}))
vi.mock('@/components/notes/NoteList', () => ({ NoteList: () => null }))
const editor = vi.hoisted(() => ({ props: [] as unknown[] }))
vi.mock('@/components/notes/NoteEditor', () => ({
  NoteEditor: (props: unknown) => {
    editor.props.push(props)
    return null
  },
  handOffNote: vi.fn(),
  noteScreenKey: (id: string | null) => id ?? 'new',
}))

beforeEach(() => {
  nav.push.mockReset()
  nav.params = new URLSearchParams()
  window.name = ''
})
afterEach(() => vi.restoreAllMocks())

describe('Notes page', () => {
  it('opens the open note in the Workbench and takes this window back to the sessions', () => {
    nav.params = new URLSearchParams('id=abcdef012345')
    const popup = { focus: vi.fn() } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    render(<NotesPage />)
    fireEvent.click(screen.getByTestId('notes-pop-out'))
    expect(open).toHaveBeenCalledWith(
      '/workbench?tab=notes&id=abcdef012345',
      'aico-workbench',
      expect.stringContaining('popup'),
    )
    expect(nav.push).toHaveBeenCalledWith('/')
  })

  it('a New note link shows an unsaved note of that kind', () => {
    nav.params = new URLSearchParams('new=list')
    editor.props = []
    render(<NotesPage />)
    expect(screen.getByRole('heading').textContent).toBe('New list')
    expect(editor.props.at(-1)).toMatchObject({ id: null, kind: 'list' })
  })

  it('stays put and says so when the browser blocks the window', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    render(<NotesPage />)
    fireEvent.click(screen.getByTestId('notes-pop-out'))
    expect(screen.getByRole('alert').textContent).toBe('Pop-up blocked')
    expect(nav.push).not.toHaveBeenCalled()
  })
})
