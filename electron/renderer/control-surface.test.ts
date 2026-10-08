import { afterEach, describe, expect, it, vi } from 'vitest'
import { allActions, setSessionActions } from './actions'
import { refreshSessions, sessionSubmenuLabel } from './control-surface'

afterEach(() => {
  setSessionActions([])
  vi.unstubAllGlobals()
})

describe('openable session discovery', () => {
  it('shows the project or ad hoc identity alongside a custom Open label', () => {
    expect(sessionSubmenuLabel({ label: 'My work', project: 'Agent Hub' })).toBe(
      'My work · Agent Hub',
    )
    expect(sessionSubmenuLabel({ label: 'Scratchpad', project: 'Ad-Hoc Shell' })).toBe(
      'Scratchpad · Ad-Hoc Shell',
    )
    expect(sessionSubmenuLabel({ label: 'Agent Hub', project: 'Agent Hub' })).toBe('Agent Hub')
    expect(sessionSubmenuLabel({ label: 'Agent Hub', project: 'Agent Hub', tool: 'codex' })).toBe(
      'Agent Hub · Codex',
    )
  })

  it('finds an A-Term session created after Aico first loaded', async () => {
    let sessions: {
      owner: 'a-term'
      id: string
      label: string
      project: string | null
      tool: string | null
      status: 'running'
      locallyOpen: boolean
    }[] = []
    const listOpenableSessions = vi.fn(async () => sessions)
    vi.stubGlobal('window', { aico: { actions: { listOpenableSessions } } })

    expect(await refreshSessions()).toEqual({ status: 'empty' })
    expect(allActions().some((action) => action.id === 'tmux:default:a-term-new')).toBe(false)

    sessions = [
      {
        owner: 'a-term',
        id: 'default:a-term-new',
        label: 'A-Term new',
        project: null,
        tool: null,
        status: 'running',
        locallyOpen: false,
      },
    ]
    expect(await refreshSessions()).toEqual({ status: 'ready' })
    expect(allActions().some((action) => action.id === 'tmux:default:a-term-new')).toBe(true)
    expect(listOpenableSessions).toHaveBeenCalledTimes(2)
  })

  it('distinguishes a failed query from a successful empty catalog', async () => {
    vi.stubGlobal('window', {
      aico: {
        actions: {
          listOpenableSessions: vi.fn().mockRejectedValue(new Error('sessions unavailable')),
        },
      },
    })

    expect(await refreshSessions()).toEqual({ status: 'unavailable' })
    expect(allActions().some((action) => action.id.startsWith('tmux:'))).toBe(false)
  })
})
