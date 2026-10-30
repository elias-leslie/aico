import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIONS,
  AICO_TOAST_EVENT,
  copySessionDiagnostics,
  DEFAULT_PINS,
  findAction,
  isPinnable,
  listGames,
  movePin,
  pinnedActions,
  prunePins,
  setGameActions,
  setTuiActions,
  togglePin,
} from './actions'
import { chordLabel } from './chords'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('action registry', () => {
  it('has unique ids and shortcuts', () => {
    const ids = ACTIONS.map((a) => a.id)
    // Only actions that actually bind a chord must be unique; reference/no-chord
    // entries (e.g. the Replace-TUI flyout host, Retire) legitimately have none.
    const shortcuts = ACTIONS.map((a) => a.shortcut).filter((s) => s.length > 0)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(shortcuts).size).toBe(shortcuts.length)
  })

  it('labels each chord action with the key its handler listens for', () => {
    for (const id of ['palette', 'hub', 'refresh', 'copy', 'paste'] as const) {
      expect(findAction(id)?.shortcut).toBe(chordLabel(id))
    }
  })

  it('gives every action a non-empty label and icon', () => {
    for (const a of ACTIONS) {
      expect(a.label.length).toBeGreaterThan(0)
      expect(a.icon.length).toBeGreaterThan(0)
    }
  })

  it('treats click-capable actions as pinnable', () => {
    // Runnable actions and top-level flyout hosts are pinnable; copy stays a
    // terminal chord reference, so it is not pinnable.
    expect(isPinnable(findAction('hub') as never)).toBe(true)
    expect(isPinnable(findAction('new-widget') as never)).toBe(true)
    expect(isPinnable(findAction('switch-project') as never)).toBe(true)
    expect(isPinnable(findAction('attach-tmux') as never)).toBe(true)
    expect(isPinnable(findAction('copy-session-diagnostics') as never)).toBe(true)
    expect(isPinnable(findAction('copy') as never)).toBe(false)
  })

  it('registers session diagnostics as a runnable, discoverable action', () => {
    const action = findAction('copy-session-diagnostics')

    expect(action?.label).toBe('Copy session diagnostics')
    expect(typeof action?.run).toBe('function')
  })

  it('seeds defaults that are all pinnable', () => {
    for (const id of DEFAULT_PINS) {
      const a = findAction(id)
      expect(a && isPinnable(a)).toBe(true)
    }
  })

  it('makes top-level flyouts pinnable dropdown hosts with no direct run', () => {
    for (const id of ['new-widget', 'replace-tui', 'switch-project', 'attach-tmux']) {
      const a = findAction(id)
      expect(a?.shortcut).toBe('')
      expect(a?.run).toBeUndefined()
      expect(a?.opensFlyout).toBe(true)
      expect(a && isPinnable(a)).toBe(true)
    }
  })

  it('keeps "New session" as a flyout host with no default launch', () => {
    const a = findAction('new-widget')
    expect(a?.label).toBe('New session')
    expect(a?.shortcut).toBe('')
    expect(a?.run).toBeUndefined()
  })

  it('treats per-TUI "New <TUI>" launchers as project-picking: pinnable, no run', () => {
    setTuiActions([{ slug: 'claude', displayName: 'Claude', accent: '#fff' }])
    const a = findAction('new:claude')
    expect(a?.run).toBeUndefined() // clicking pops the workspace picker, not a direct launch
    expect(a?.picksProject).toBe(true)
    expect(a && isPinnable(a)).toBe(true) // still pinnable + palette-searchable
    // The matching "Replace with <TUI>" launcher keeps its direct run.
    expect(typeof findAction('replace:claude')?.run).toBe('function')
  })

  it('lists the titlebar games as pinnable Play actions that ask for that game', () => {
    const games = [{ key: 'runandgun', name: 'Run and gun' }]
    setGameActions(games)
    expect(listGames()).toEqual(games)
    const a = findAction('game:runandgun')
    expect(a?.label).toBe('Play Run and gun')
    expect(a && isPinnable(a)).toBe(true)
    const picked = vi.fn()
    vi.stubGlobal('window', { dispatchEvent: (e: CustomEvent<string>) => picked(e.type, e.detail) })
    a?.run?.()
    expect(picked).toHaveBeenCalledWith('aico:arcade-pick', 'runandgun')
    expect(findAction('arcade-pick')?.opensFlyout).toBe(true)
    expect(typeof findAction('arcade-toggle')?.run).toBe('function')
  })

  it('gives each glyph to one action only', () => {
    const icons = ACTIONS.map((a) => a.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })

  it('opens sessions only through the "Open session" flyout, never as separate actions', () => {
    expect(findAction('attach-tmux')?.label).toBe('Open session')
    expect(ACTIONS.filter((a) => a.label.startsWith('Open '))).toHaveLength(1)
  })
})

describe('copySessionDiagnostics', () => {
  it('copies pretty JSON and publishes a confirmation event', async () => {
    const diagnostics = {
      capturedAt: '2026-07-13T12:00:00.000Z',
      ownership: { widgetId: 'w-1', scopeUnit: 'aico-pane-w-1.scope' },
      warnings: [],
    }
    const sessionDiagnostics = vi.fn().mockResolvedValue(diagnostics)
    const write = vi.fn()
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', {
      aico: { actions: { sessionDiagnostics }, clipboard: { write } },
      dispatchEvent,
    })

    await copySessionDiagnostics()

    expect(sessionDiagnostics).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith(JSON.stringify(diagnostics, null, 2))
    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent
    expect(event.type).toBe(AICO_TOAST_EVENT)
    expect(event.detail).toEqual({ kind: 'Copied', snippet: 'Session diagnostics' })
  })

  it('does not overwrite the clipboard when diagnostics fail', async () => {
    const error = new Error('IPC failed')
    const write = vi.fn()
    const dispatchEvent = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('window', {
      aico: {
        actions: { sessionDiagnostics: vi.fn().mockRejectedValue(error) },
        clipboard: { write },
      },
      dispatchEvent,
    })

    await copySessionDiagnostics()

    expect(write).not.toHaveBeenCalled()
    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent
    expect(event.type).toBe(AICO_TOAST_EVENT)
    expect(event.detail).toEqual({ kind: 'Error', snippet: 'Could not copy session diagnostics' })
  })
})

describe('End session', () => {
  it('shows a failure without claiming the session ended', async () => {
    const dispatchEvent = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('window', {
      aico: { actions: { endSession: vi.fn().mockRejectedValue(new Error('owner unavailable')) } },
      dispatchEvent,
    })

    findAction('retire-widget')?.run?.()
    await vi.waitFor(() => expect(dispatchEvent).toHaveBeenCalledOnce())

    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent
    expect(event.type).toBe(AICO_TOAST_EVENT)
    expect(event.detail).toEqual({
      kind: 'Error',
      snippet: 'Could not confirm End; check the session list',
    })
  })
})

describe('pinnedActions', () => {
  it('resolves ids to actions in pin order', () => {
    expect(pinnedActions(['hub', 'new-widget']).map((a) => a.id)).toEqual(['hub', 'new-widget'])
  })

  it('skips unavailable, un-pinnable and repeated ids without changing the list', () => {
    const stored = ['hub', 'copy', 'new-widget', 'voice', 'new:gone', 'hub']
    const before = [...stored]
    expect(pinnedActions(stored).map((a) => a.id)).toEqual(['hub', 'new-widget'])
    expect(stored).toEqual(before)
  })

  it('shows a hidden launcher pin again once its catalog lists it', () => {
    setTuiActions([])
    expect(pinnedActions(['new:claude']).map((a) => a.id)).toEqual([])
    setTuiActions([{ slug: 'claude', displayName: 'Claude', accent: '#fff' }])
    expect(pinnedActions(['new:claude']).map((a) => a.id)).toEqual(['new:claude'])
    setTuiActions([])
  })
})

describe('prunePins', () => {
  it('drops retired ids and repeats but keeps launcher pins that may come back', () => {
    setTuiActions([])
    setGameActions([])
    const stored = [
      'hub',
      'voice',
      'grab-region',
      'session:aico:abc',
      'copy',
      'new:claude',
      'replace:codex',
      'project:tether',
      'game:snake',
      'arcade-next',
      'hub',
    ]
    expect(prunePins(stored)).toEqual([
      'hub',
      'new:claude',
      'replace:codex',
      'project:tether',
      'game:snake',
      'arcade-next',
    ])
  })
})

describe('togglePin', () => {
  it('adds when absent and removes when present', () => {
    expect(togglePin(['new-widget'], 'hub')).toEqual(['new-widget', 'hub'])
    expect(togglePin(['new-widget', 'hub'], 'new-widget')).toEqual(['hub'])
  })
})

describe('movePin', () => {
  it('moves a pin to where another sits, by id', () => {
    expect(movePin(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
    expect(movePin(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })

  it('keeps hidden pins in the stored list when dragging past them', () => {
    expect(movePin(['hub', 'arcade-next', 'new-widget'], 'new-widget', 'hub')).toEqual([
      'new-widget',
      'hub',
      'arcade-next',
    ])
  })

  it('returns the input unchanged when an id is missing or it is a no-op', () => {
    const pins = ['a', 'b']
    expect(movePin(pins, 'b', 'b')).toBe(pins)
    expect(movePin(pins, 'a', 'z')).toBe(pins)
    expect(movePin(pins, 'z', 'a')).toBe(pins)
  })
})
