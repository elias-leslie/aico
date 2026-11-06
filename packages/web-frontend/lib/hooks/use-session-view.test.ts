import { describe, expect, it } from 'vitest'
import { SESSION_BASE } from '@/test-stubs/session-fixtures'
import {
  afterSessionEnds,
  agentNeedsStart,
  buildSessionSlots,
  deriveActiveSessionId,
  modeSwitchFailure,
  needsAgentSwitch,
  newPaneSessionId,
  parsePersistedSessionId,
  projectLinkSessionId,
  projectLinkStartMode,
  projectPaneName,
} from './use-session-view'
import type { TerminalPane } from './use-terminal-panes'
import type { TerminalSession } from './use-terminal-sessions'

const session = (
  id: string,
  overrides: Partial<TerminalSession> = {},
): TerminalSession => ({
  ...SESSION_BASE,
  id,
  name: id,
  working_dir: null,
  mode: 'shell',
  is_alive: true,
  ...overrides,
})

const pane = (
  id: string,
  sessions: TerminalSession[],
  overrides: Partial<TerminalPane> = {},
): TerminalPane => ({
  id,
  pane_type: 'project',
  project_id: 'aico',
  pane_order: 0,
  pane_name: 'Aico',
  active_mode: 'shell',
  is_detached: true,
  created_at: null,
  sessions,
  ...overrides,
})

describe('the session a link or this browser opens', () => {
  const own = session('own', { project_id: 'aico' })
  const other = session('other', { project_id: 'aico', is_external: true })
  const all = [other, own]

  it('opens the linked session, or nothing when it is gone', () => {
    expect(deriveActiveSessionId(all, 'other', null)).toBe('other')
    expect(deriveActiveSessionId(all, 'gone', 'aico', 'own')).toBeNull()
  })

  it("opens the user's own session for a project link, else the remembered one", () => {
    expect(deriveActiveSessionId(all, null, 'aico')).toBe('own')
    expect(deriveActiveSessionId(all, null, null, 'own')).toBe('own')
  })

  it("never picks a session on its own, nor reopens another agent's remembered View", () => {
    expect(deriveActiveSessionId(all, null, null)).toBeNull()
    expect(deriveActiveSessionId(all, null, null, 'other')).toBeNull()
    expect(deriveActiveSessionId([], 'own', null)).toBeNull()
  })

  it('reads the remembered id in the current and the older format', () => {
    expect(parsePersistedSessionId('"own"')).toBe('own')
    expect(parsePersistedSessionId('own')).toBe('own')
    expect(parsePersistedSessionId('{"id":1}')).toBeNull()
    expect(parsePersistedSessionId(null)).toBeNull()
  })
})

describe('the switcher list', () => {
  it('lists panes first, then each session no pane shows, once', () => {
    const shell = session('shell', { project_id: 'aico' })
    const agent = session('agent', { project_id: 'aico', mode: 'claude' })
    const view = session('view', { project_id: 'aico', is_external: true })
    const loose = session('loose')
    const slots = buildSessionSlots(
      [pane('p1', [shell, agent])],
      [shell, agent, view, loose],
      new Map([['aico', 'Aico']]),
    )
    expect(
      slots.map((slot) => slot.slotId ?? `pane:${'paneId' in slot}`),
    ).toEqual(['pane:true', 'session-view', 'session-loose'])
    // Another agent's View: listed, but never offers Reset.
    expect(slots[1]).toMatchObject({ type: 'project', can: { reset: false } })
    expect(slots[2]).toMatchObject({ type: 'adhoc', isExternal: false })
  })
})

describe('opening a project link', () => {
  const project = { id: 'aico', mode: 'claude' }
  const at = (iso: string) => ({ created_at: iso, project_id: 'aico' })

  it("opens the project's own session in its mode, else its shell, else its oldest", () => {
    const oldShell = session('old-shell', at('2026-01-01T00:00:00Z'))
    const newShell = session('new-shell', at('2026-02-01T00:00:00Z'))
    const agent = session('agent', {
      ...at('2026-03-01T00:00:00Z'),
      mode: 'claude',
    })
    const codex = session('codex', {
      ...at('2026-01-01T00:00:00Z'),
      mode: 'codex',
    })
    expect(projectLinkSessionId(project, [newShell, agent, oldShell])).toBe(
      'agent',
    )
    expect(projectLinkSessionId(project, [newShell, oldShell])).toBe(
      'old-shell',
    )
    expect(projectLinkSessionId(project, [codex])).toBe('codex')
  })

  it("starts a new session rather than open another agent's, or for a project not enabled", () => {
    const view = session('view', { project_id: 'aico', is_external: true })
    expect(projectLinkSessionId(project, [view])).toBeNull()
    expect(
      projectLinkSessionId(undefined, [session('x', at('2026-01-01'))]),
    ).toBeNull()
  })

  it('starts only what the project is in: a shell alone, or its agent', () => {
    expect(projectLinkStartMode({ mode: 'shell' })).toBe('shell')
    expect(projectLinkStartMode({ mode: 'claude-code' })).toBe('claude-code')
    expect(projectLinkStartMode(undefined)).toBeUndefined()
  })

  it('numbers a new pane after the project panes it already has', () => {
    expect(projectPaneName('aico', [])).toBe('Aico')
    expect(projectPaneName('aico', [pane('a', []), pane('b', [])])).toBe(
      'Aico [3]',
    )
  })

  it("opens a new pane on its mode's session, else its shell", () => {
    const shell = session('shell')
    const agent = session('agent', { mode: 'claude' })
    expect(
      newPaneSessionId(pane('p', [shell, agent], { active_mode: 'claude' })),
    ).toBe('agent')
    expect(newPaneSessionId(pane('p', [shell], { active_mode: 'codex' }))).toBe(
      'shell',
    )
  })
})

describe('session actions', () => {
  it('starts or replaces the agent unless the pane already runs it; shell only toggles', () => {
    const p = pane('p', [session('s'), session('a', { mode: 'claude' })])
    expect(needsAgentSwitch(p, 'codex')).toBe(true)
    expect(needsAgentSwitch(p, 'claude')).toBe(false)
    expect(needsAgentSwitch(p, 'shell')).toBe(false)
    // A shell-only pane has no agent session to toggle to: it gets one.
    expect(needsAgentSwitch(pane('p', [session('s')]), 'codex')).toBe(true)
  })

  it('says plainly what failed when the shell/agent switch is refused', () => {
    expect(
      modeSwitchFailure('Codex', new Error("Mode 'codex' not available.")),
    ).toEqual({
      message: "Couldn’t switch to Codex. Mode 'codex' not available.",
    })
    expect(modeSwitchFailure('Codex', 'boom')).toEqual({
      message: 'Couldn’t switch to Codex.',
    })
  })

  it('starts an agent unless it runs or is starting', () => {
    expect(agentNeedsStart('running')).toBe(false)
    expect(agentNeedsStart('starting')).toBe(false)
    expect(agentNeedsStart('stopped')).toBe(true)
    expect(agentNeedsStart(undefined)).toBe(true)
  })

  it("after ending a session, opens its pane's other session, else shows none, never another pane", () => {
    expect(afterSessionEnds({ next_session_id: 'mate' }, 'a', 'a')).toEqual({
      open: 'mate',
    })
    expect(afterSessionEnds({ next_session_id: null }, 'a', 'a')).toBe('clear')
    expect(afterSessionEnds({ next_session_id: null }, 'a', 'b')).toBe('stay')
  })
})
