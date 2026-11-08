import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openFilesWindow,
  openNotes,
  openWorkbench,
  readTab,
  splitOff,
  WORKBENCH_TABS,
  workbenchHref,
  workbenchTip,
} from './workbench'

const shown = vi.hoisted(() => ({ project: null as string | null }))
vi.mock('./frame/shown-project', () => ({ shownProject: () => shown.project }))

const popup = () => ({ focus: vi.fn() }) as unknown as Window

afterEach(() => {
  vi.unstubAllGlobals()
  shown.project = null
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('the Workbench links', () => {
  it('keep a tab, its project and its place in the address', () => {
    expect(workbenchHref('files', { project: 'aico', path: '/tmp' })).toBe(
      '/workbench?tab=files&project=aico&path=%2Ftmp',
    )
    expect(workbenchHref('notes', { project: null })).toBe(
      '/workbench?tab=notes',
    )
    expect(readTab('files')).toBe('files')
    expect(readTab('nope')).toBeNull()
  })

  it('name every tab in the tooltip', () => {
    expect(workbenchTip()).toBe(
      `Workbench: ${WORKBENCH_TABS.map((tab) => tab.label).join(', ')}`,
    )
    expect(workbenchTip()).toContain('Notes')
    expect(workbenchTip()).toContain('Files')
  })
})

describe('opening the Workbench', () => {
  it('opens Notes on the project of the session on screen, in the shared window', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(popup())
    shown.project = 'portfolio-ai'
    openNotes()
    expect(open).toHaveBeenCalledWith(
      '/workbench?tab=notes&project=portfolio-ai',
      'aico-workbench',
      expect.stringContaining('popup'),
    )
    openNotes(null)
    expect(open).toHaveBeenLastCalledWith(
      '/workbench?tab=notes',
      'aico-workbench',
      expect.any(String),
    )
  })

  it('opens Files on a folder, a path or what is shared', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(popup())
    expect(openFilesWindow({ project: 'aico' })).toBe(true)
    expect(open).toHaveBeenLastCalledWith(
      '/workbench?tab=files&project=aico',
      'aico-workbench',
      expect.any(String),
    )
    openFilesWindow({ session: 'ab12cd34', path: '/tmp/x.txt' })
    expect(open).toHaveBeenLastCalledWith(
      '/workbench?tab=files&session=ab12cd34&path=%2Ftmp%2Fx.txt',
      'aico-workbench',
      expect.any(String),
    )
    openFilesWindow({ shared: 'show1' })
    expect(open).toHaveBeenLastCalledWith(
      '/workbench?tab=files&view=shared&show=show1',
      'aico-workbench',
      expect.any(String),
    )
  })

  it('brings a tab that has its own window forward instead of the shared one', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(popup())
    expect(splitOff('files', { project: 'aico' })).toBe(true)
    expect(open).toHaveBeenLastCalledWith(
      '/workbench?tab=files&project=aico',
      'aico-workbench-files',
      expect.any(String),
    )
    // That window says it is there.
    localStorage.setItem('aico-workbench-split:files', String(Date.now()))
    openWorkbench('files', { project: 'other' })
    expect(open).toHaveBeenLastCalledWith(
      '/workbench?tab=files&project=other',
      'aico-workbench-files',
      expect.any(String),
    )
    // Notes has none, and a window that stopped saying so no longer counts.
    openWorkbench('notes')
    expect(open).toHaveBeenLastCalledWith(
      '/workbench?tab=notes',
      'aico-workbench',
      expect.any(String),
    )
    localStorage.setItem(
      'aico-workbench-split:files',
      String(Date.now() - 60_000),
    )
    openWorkbench('files')
    expect(open).toHaveBeenLastCalledWith(
      '/workbench?tab=files',
      'aico-workbench',
      expect.any(String),
    )
  })

  it('keeps Files in place on a phone and where the browser blocks the window', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openFilesWindow({ project: 'aico' })).toBe(false)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    )
    open.mockClear()
    expect(openFilesWindow({ project: 'aico' })).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps Files in place on a narrow screen even with a mouse', () => {
    const open = vi.spyOn(window, 'open')
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: !query.includes('min-width') })),
    )
    expect(openFilesWindow({ project: 'aico' })).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('opens Notes in this window where there is no side window', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      assign,
    } as unknown as Location)
    openNotes('aico')
    expect(assign).toHaveBeenCalledWith('/notes?project=aico')
  })
})
