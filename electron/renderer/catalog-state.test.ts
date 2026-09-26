import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allActions,
  sanitizePins,
  setProjectActions,
  setTmuxSessionActions,
  setTuiActions,
} from './actions'
import { createCatalogState, type TmuxSessionInfo } from './catalog-state'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  setTuiActions([])
  setProjectActions([])
  setTmuxSessionActions([])
})

describe('picker catalog state', () => {
  it('starts independent requests together and registers all dynamic pins before initialization ends', async () => {
    const tuis = deferred<{ slug: string; displayName: string; accent: string }[]>()
    const projects = deferred<{ id: string; name: string; current: boolean }[]>()
    const tmux = deferred<TmuxSessionInfo[]>()
    const listTuis = vi.fn(() => tuis.promise)
    const listProjects = vi.fn(() => projects.promise)
    const listTmuxSessions = vi.fn(() => tmux.promise)
    const catalogs = createCatalogState({ listTuis, listProjects, listTmuxSessions })

    let finished = false
    const loading = catalogs.loadInitial().then(() => {
      finished = true
    })
    expect(listTuis).toHaveBeenCalledOnce()
    expect(listProjects).toHaveBeenCalledOnce()
    expect(listTmuxSessions).toHaveBeenCalledOnce()

    projects.resolve([{ id: 'workspace-1', name: 'Workspace', current: true }])
    tmux.resolve([{ id: 'default:a-term-1', label: 'A-Term', source: 'A-Term' }])
    await Promise.resolve()
    expect(finished).toBe(false)

    tuis.resolve([{ slug: 'claude', displayName: 'Claude', accent: '#fff' }])
    await loading
    expect(
      sanitizePins([
        'new:claude',
        'replace:claude',
        'project:workspace-1',
        'tmux:default:a-term-1',
      ]),
    ).toEqual(['new:claude', 'replace:claude', 'project:workspace-1', 'tmux:default:a-term-1'])
    expect(catalogs.tuis).toHaveLength(1)
    expect(catalogs.projects).toHaveLength(1)
    expect(catalogs.tmuxSessionStatus).toBe('ready')
  })

  it('keeps a newer tmux result when an older request completes afterward', async () => {
    const first = deferred<TmuxSessionInfo[]>()
    const second = deferred<TmuxSessionInfo[]>()
    const listTmuxSessions = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const catalogs = createCatalogState({
      listTuis: async () => [],
      listProjects: async () => [],
      listTmuxSessions,
    })
    const oldRefresh = catalogs.refreshTmuxSessions()
    const newRefresh = catalogs.refreshTmuxSessions()
    second.resolve([{ id: 'new', label: 'New', source: 'A-Term' }])
    await newRefresh
    first.resolve([{ id: 'old', label: 'Old', source: 'A-Term' }])
    await oldRefresh

    expect(catalogs.tmuxSessions.map((session) => session.id)).toEqual(['new'])
    expect(allActions().some((action) => action.id === 'tmux:new')).toBe(true)
    expect(allActions().some((action) => action.id === 'tmux:old')).toBe(false)
  })

  it('degrades a failed catalog independently of the others', async () => {
    const catalogs = createCatalogState({
      listTuis: async () => [{ slug: 'claude', displayName: 'Claude', accent: '#fff' }],
      listProjects: async () => {
        throw new Error('projects unavailable')
      },
      listTmuxSessions: async () => [],
    })
    await catalogs.loadInitial()

    expect(catalogs.projects).toEqual([])
    expect(sanitizePins(['new:claude', 'project:missing'])).toEqual(['new:claude'])
    expect(catalogs.tmuxSessionStatus).toBe('empty')
  })
})
