import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTES_WINDOW } from '@/lib/notes-window'
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

describe('Notes pop-out', () => {
  it('opens the open note in the notes window and takes this one back to the sessions', () => {
    nav.params = new URLSearchParams('id=abcdef012345')
    const popup = { focus: vi.fn() } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    render(<NotesPage />)
    fireEvent.click(screen.getByTestId('notes-pop-out'))
    expect(open).toHaveBeenCalledWith(
      '/notes?id=abcdef012345',
      NOTES_WINDOW,
      expect.stringContaining('popup'),
    )
    expect(nav.push).toHaveBeenCalledWith('/')
  })

  it('from the list, opens a New note ready to type in the notes window', () => {
    const popup = { focus: vi.fn() } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    render(<NotesPage />)
    fireEvent.click(screen.getByTestId('notes-pop-out'))
    expect(open).toHaveBeenCalledWith(
      '/notes?new=note',
      NOTES_WINDOW,
      expect.stringContaining('popup'),
    )
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

  it('in the notes window: no pop-out and no way back to the sessions', () => {
    window.name = NOTES_WINDOW
    render(<NotesPage />)
    expect(screen.queryByTestId('notes-pop-out')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Back to sessions' })).toBeNull()
  })
})
