import { afterEach, describe, expect, it, vi } from 'vitest'
import { allActions, setTmuxSessionActions } from './actions'
import { refreshTmuxSessions } from './control-surface'

afterEach(() => {
  setTmuxSessionActions([])
  vi.unstubAllGlobals()
})

describe('attachable tmux session discovery', () => {
  it('finds an A-Term session created after Aico first loaded', async () => {
    let sessions: { id: string; label: string; source: string }[] = []
    const listTmuxSessions = vi.fn(async () => sessions)
    vi.stubGlobal('window', { aico: { actions: { listTmuxSessions } } })

    expect(await refreshTmuxSessions()).toEqual({ status: 'empty' })
    expect(allActions().some((action) => action.id === 'tmux:default:a-term-new')).toBe(false)

    sessions = [{ id: 'default:a-term-new', label: 'A-Term new', source: 'A-Term' }]
    expect(await refreshTmuxSessions()).toEqual({ status: 'ready' })
    expect(allActions().some((action) => action.id === 'tmux:default:a-term-new')).toBe(true)
    expect(listTmuxSessions).toHaveBeenCalledTimes(2)
  })

  it('distinguishes a failed query from a successful empty catalog', async () => {
    vi.stubGlobal('window', {
      aico: {
        actions: { listTmuxSessions: vi.fn().mockRejectedValue(new Error('tmux unavailable')) },
      },
    })

    expect(await refreshTmuxSessions()).toEqual({ status: 'unavailable' })
    expect(allActions().some((action) => action.id.startsWith('tmux:'))).toBe(false)
  })
})
