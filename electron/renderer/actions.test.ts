import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIONS,
  AICO_TOAST_EVENT,
  copySessionDiagnostics,
  DEFAULT_PINS,
  findAction,
  isPinnable,
  pinnedActions,
  reorderPins,
  sanitizePins,
  setTmuxSessionActions,
  setTuiActions,
  togglePin,
} from './actions'

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

  it('gives every action a non-empty label and icon', () => {
    for (const a of ACTIONS) {
      expect(a.label.length).toBeGreaterThan(0)
      expect(a.icon.length).toBeGreaterThan(0)
    }
  })

  it('treats click-capable actions as pinnable', () => {
    expect(isPinnable(findAction('voice') as never)).toBe(true)
    // Grabs run directly; top-level flyout hosts open dropdowns; copy stays a
    // terminal chord reference, so it is not pinnable.
    expect(isPinnable(findAction('grab-image') as never)).toBe(true)
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

  it('keeps "New widget" as a flyout host with no default launch', () => {
    const a = findAction('new-widget')
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

  it('treats discovered tmux sessions as pinnable attach actions', () => {
    setTmuxSessionActions([{ id: 'default:a-term-demo', label: 'A-Term demo', source: 'A-Term' }])
    const a = findAction('tmux:default:a-term-demo')
    expect(typeof a?.run).toBe('function')
    expect(a && isPinnable(a)).toBe(true)
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

describe('sanitizePins', () => {
  it('drops unknown and un-pinnable ids and de-dupes, preserving order', () => {
    expect(sanitizePins(['hub', 'copy', 'new-widget', 'nope', 'voice', 'voice'])).toEqual([
      'hub',
      'new-widget',
      'voice',
    ])
  })
})

describe('pinnedActions', () => {
  it('resolves ids to actions in pin order', () => {
    expect(pinnedActions(['hub', 'voice']).map((a) => a.id)).toEqual(['hub', 'voice'])
  })
})

describe('togglePin', () => {
  it('adds when absent and removes when present', () => {
    expect(togglePin(['voice'], 'hub')).toEqual(['voice', 'hub'])
    expect(togglePin(['voice', 'hub'], 'voice')).toEqual(['hub'])
  })
})

describe('reorderPins', () => {
  it('moves an item to a new index', () => {
    expect(reorderPins(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(reorderPins(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('returns the input unchanged when out of range or a no-op', () => {
    expect(reorderPins(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
    expect(reorderPins(['a', 'b'], 0, 5)).toEqual(['a', 'b'])
    expect(reorderPins(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
  })
})
