import { afterEach, describe, expect, it, vi } from 'vitest'
import { openNotes } from './notes-window'

const shown = vi.hoisted(() => ({ project: null as string | null }))
vi.mock('./frame/shown-project', () => ({ shownProject: () => shown.project }))

describe('openNotes', () => {
  afterEach(() => {
    shown.project = null
    vi.restoreAllMocks()
  })

  it('opens the notes window on the project of the session on screen', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({
      focus: vi.fn(),
    } as unknown as Window)
    shown.project = 'portfolio-ai'
    openNotes()
    expect(open).toHaveBeenCalledWith(
      '/notes?project=portfolio-ai',
      'aico-notes',
      expect.any(String),
    )
  })

  it('takes a project of its own, or none for All', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({
      focus: vi.fn(),
    } as unknown as Window)
    shown.project = 'portfolio-ai'
    openNotes('aico')
    expect(open).toHaveBeenLastCalledWith(
      '/notes?project=aico',
      'aico-notes',
      expect.any(String),
    )
    openNotes(null)
    expect(open).toHaveBeenLastCalledWith(
      '/notes',
      'aico-notes',
      expect.any(String),
    )
  })

  it('opens in this window where the browser blocks the pop-up', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      assign,
    } as unknown as Location)
    openNotes('aico')
    expect(assign).toHaveBeenCalledWith('/notes?project=aico')
  })
})
