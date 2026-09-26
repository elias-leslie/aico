import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenableSession } from '../types'
import {
  allActions,
  sanitizePins,
  setProjectActions,
  setSessionActions,
  setTuiActions,
} from './actions'
import { createCatalogState } from './catalog-state'

const aTermSession = (id: string): OpenableSession => ({
  owner: 'a-term',
  id,
  label: `A-Term ${id}`,
  project: 'Aico',
  tool: 'Codex',
  status: 'running',
  locallyOpen: false,
})

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
  setSessionActions([])
})

describe('picker catalog state', () => {
  it('starts independent requests together and registers all dynamic pins before initialization ends', async () => {
    const tuis = deferred<{ slug: string; displayName: string; accent: string }[]>()
    const projects = deferred<{ id: string; name: string; current: boolean }[]>()
    const sessions = deferred<OpenableSession[]>()
    const listTuis = vi.fn(() => tuis.promise)
    const listProjects = vi.fn(() => projects.promise)
    const listOpenableSessions = vi.fn(() => sessions.promise)
    const catalogs = createCatalogState({ listTuis, listProjects, listOpenableSessions })

    let finished = false
    const loading = catalogs.loadInitial().then(() => {
      finished = true
    })
    expect(listTuis).toHaveBeenCalledOnce()
    expect(listProjects).toHaveBeenCalledOnce()
    expect(listOpenableSessions).toHaveBeenCalledOnce()

    projects.resolve([{ id: 'workspace-1', name: 'Workspace', current: true }])
    sessions.resolve([aTermSession('default:a-term-1')])
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
    expect(catalogs.sessionStatus).toBe('ready')
  })

  it('keeps a newer session result when an older request completes afterward', async () => {
    const first = deferred<OpenableSession[]>()
    const second = deferred<OpenableSession[]>()
    const listOpenableSessions = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const catalogs = createCatalogState({
      listTuis: async () => [],
      listProjects: async () => [],
      listOpenableSessions,
    })
    const oldRefresh = catalogs.refreshSessions()
    const newRefresh = catalogs.refreshSessions()
    second.resolve([aTermSession('new')])
    await newRefresh
    first.resolve([aTermSession('old')])
    await oldRefresh

    expect(catalogs.sessions.map((session) => session.id)).toEqual(['new'])
    expect(allActions().some((action) => action.id === 'tmux:new')).toBe(true)
    expect(allActions().some((action) => action.id === 'tmux:old')).toBe(false)
  })

  it('degrades a failed catalog independently of the others', async () => {
    const catalogs = createCatalogState({
      listTuis: async () => [{ slug: 'claude', displayName: 'Claude', accent: '#fff' }],
      listProjects: async () => {
        throw new Error('projects unavailable')
      },
      listOpenableSessions: async () => [],
    })
    await catalogs.loadInitial()

    expect(catalogs.projects).toEqual([])
    expect(sanitizePins(['new:claude', 'project:missing'])).toEqual(['new:claude'])
    expect(catalogs.sessionStatus).toBe('empty')
  })

  it('keeps sessions from both owners available to Open session', async () => {
    const catalogs = createCatalogState({
      listTuis: async () => [],
      listProjects: async () => [],
      listOpenableSessions: async () => [
        {
          owner: 'aico',
          id: 'widget-1',
          label: 'Aico Codex',
          project: 'Aico',
          tool: 'Codex',
          status: 'running',
          locallyOpen: false,
        },
        aTermSession('default:a-term-2'),
      ],
    })

    await catalogs.loadInitial()

    expect(catalogs.sessions.map((session) => session.owner)).toEqual(['aico', 'a-term'])
    expect(sanitizePins(['session:aico:widget-1', 'tmux:default:a-term-2'])).toEqual([
      'session:aico:widget-1',
      'tmux:default:a-term-2',
    ])
  })
})
