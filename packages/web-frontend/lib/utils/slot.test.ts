import { describe, expect, it } from 'vitest'
import type { TerminalPane } from '@/lib/hooks/use-terminal-panes'
import type { TerminalSession } from '@/lib/hooks/use-terminal-sessions'
import {
  OWN_TMUX_CAN,
  ROOT_CAN,
  SESSION_BASE,
  TETHER_CAN,
} from '@/test-stubs/session-fixtures'
import {
  paneSessionsAsSessions,
  paneToSlot,
  sessionTitle,
  sessionToSlot,
} from './slot'

// One session per kind, as the backend lists it: `source`, the informational
// flags and the capability flags (packages/web-server/src/sessions.ts).
const KINDS = {
  tether: { source: 'tether', ...TETHER_CAN },
  root: { source: 'tether', is_root: true, ...ROOT_CAN },
  ownTmux: { source: 'tmux_external', ...OWN_TMUX_CAN },
} satisfies Record<string, Partial<TerminalSession>>
type Kind = keyof typeof KINDS

function makeSession(
  kind: Kind,
  overrides: Partial<TerminalSession> = {},
): TerminalSession {
  return {
    ...SESSION_BASE,
    id: `${kind}-session`,
    name: 'Incident review',
    project_id: 'neri',
    working_dir: '/workspace/neri',
    mode: 'codex',
    session_number: 1,
    is_alive: true,
    is_external: false,
    agent_state: 'running',
    claude_state: 'running',
    ...KINDS[kind],
    ...overrides,
  }
}

function makePane(
  paneType: TerminalPane['pane_type'],
  sessions: TerminalSession[],
  overrides: Partial<TerminalPane> = {},
): TerminalPane {
  return {
    id: 'pane-1',
    pane_type: paneType,
    project_id: paneType === 'project' ? 'neri' : null,
    pane_order: 0,
    pane_name: 'Pane name',
    active_mode: sessions[0]?.mode ?? 'shell',
    is_detached: false,
    created_at: '2026-10-01T00:00:00Z',
    sessions,
    ...overrides,
  }
}

describe('sessionTitle', () => {
  it.each([
    // kind, pane, free-standing, linked to a pane not loaded here
    ['tether', 'Incident review', 'Incident review', 'Incident review'],
    ['root', 'Incident review', 'Incident review', 'Incident review'],
    ['ownTmux', 'Pane name', 'Neri · Incident review', 'Neri'],
  ] as const)('titles a %s session by place', (kind, pane, free, unloaded) => {
    const session = makeSession(kind)
    expect(
      sessionTitle(session, { place: 'pane', paneName: 'Pane name' }),
    ).toBe(pane)
    expect(sessionTitle(session, { place: 'free', projectName: 'Neri' })).toBe(
      free,
    )
    expect(
      sessionTitle(session, { place: 'unloaded', projectName: 'Neri' }),
    ).toBe(unloaded)
  })

  it('falls back to the session name for a linked session whose project name is unknown', () => {
    expect(sessionTitle(makeSession('ownTmux'), { place: 'unloaded' })).toBe(
      'Incident review',
    )
  })

  it.each([
    ['Neri - Label/description', 'Neri - Label/description'],
    ['Neri · Label/description', 'Neri · Label/description'],
    ['Label/description', 'Neri · Label/description'],
    ['Nerium - Label', 'Neri · Nerium - Label'],
    ['Neri -Label', 'Neri · Neri -Label'],
    ['Neri', 'Neri'],
    ['neri', 'Neri'],
  ])(
    'prefixes the project on a free-standing session %s as %s',
    (name, expected) => {
      expect(
        sessionTitle(makeSession('ownTmux', { name }), {
          place: 'free',
          projectName: 'Neri',
        }),
      ).toBe(expected)
    },
  )

  it('keeps a free-standing name when there is no project', () => {
    expect(
      sessionTitle(makeSession('ownTmux', { project_id: null }), {
        place: 'free',
        projectName: 'Neri',
      }),
    ).toBe('Incident review')
  })

  it('keeps a free-standing name when the project display name is unavailable', () => {
    expect(sessionTitle(makeSession('ownTmux'), { place: 'free' })).toBe(
      'Incident review',
    )
  })
})

describe('sessionToSlot', () => {
  it.each([
    // kind, place, rename, reset, end
    ['tether', 'free', true, false, true],
    ['tether', 'unloaded', true, true, true],
    ['root', 'free', true, false, true],
    ['root', 'unloaded', true, false, true],
    ['ownTmux', 'free', false, false, false],
  ] as const)(
    'maps a %s session shown %s to the backend capabilities',
    (kind, place, rename, reset, end) => {
      const session = makeSession(kind, { is_external: place === 'free' })
      for (const as of ['project', 'adhoc'] as const) {
        expect(
          sessionToSlot(session, { as, place, projectName: 'Neri' }).can,
        ).toEqual({ rename, reset, end })
      }
    },
  )

  it('never offers Reset on a free-standing View, even when the session can be respawned', () => {
    const session = makeSession('tether', { is_external: true })
    expect(session.can_respawn).toBe(true)
    expect(
      sessionToSlot(session, { as: 'adhoc', place: 'free' }).can.reset,
    ).toBe(false)
  })

  it.each([
    // kind, as, task, shows the session title
    ['root', 'project', null, true],
    ['root', 'adhoc', null, false],
    ['root', 'adhoc', 'Focus', true],
    ['tether', 'project', null, false],
    ['tether', 'project', 'Focus', true],
    ['tether', 'adhoc', 'Focus', true],
    ['ownTmux', 'adhoc', 'Focus', false],
  ] as const)(
    'shows the session title for a %s %s slot with task %s: %s',
    (kind, as, task, shows) => {
      const session = makeSession(kind, { task, is_external: true })
      expect(
        sessionToSlot(session, { as, place: 'free' }).showsSessionTitle,
      ).toBe(shows)
    },
  )

  it('carries the model switch to the session window', () => {
    const change = {
      key: 'k1',
      kind: 'changed',
      from: 'claude-opus-5-5',
      to: 'claude-sonnet-5',
      category: null,
      at: 1,
      stopped: false,
      commit: null,
      worktree_changed: null,
      checked: true,
      rewind_to: null,
    } as const
    const session = makeSession('tether', { model_switch: change })
    expect(
      sessionToSlot(session, { as: 'adhoc', place: 'unloaded' }).modelSwitch,
    ).toEqual(change)
    expect(
      sessionToSlot(makeSession('tether', { model_switch: null }), {
        as: 'adhoc',
        place: 'unloaded',
      }).modelSwitch,
    ).toBeUndefined()
  })

  it('shows the session title for a Tether session with a coordinator chip', () => {
    const session = makeSession('tether', {
      badge: { kind: 'coordinator', text: 'Coordinator', color: '#f0a35e' },
    })
    const slot = sessionToSlot(session, { as: 'adhoc', place: 'unloaded' })
    expect(slot.showsSessionTitle).toBe(true)
    expect(slot.badge).toEqual({ label: 'Coordinator', color: '#f0a35e' })
  })

  it('builds a project slot for a linked session whose pane is not loaded here', () => {
    const session = makeSession('ownTmux', { mode: 'shell' })
    const slot = sessionToSlot(session, {
      as: 'project',
      place: 'unloaded',
      projectName: 'Neri',
      slotId: 'session-ownTmux-session',
    })
    expect(slot).toEqual({
      slotId: 'session-ownTmux-session',
      type: 'project',
      projectId: 'neri',
      projectName: 'Neri',
      rootPath: '/workspace/neri',
      activeMode: 'shell',
      activeSessionId: 'ownTmux-session',
      task: undefined,
      projectLabel: null,
      badge: null,
      checkIns: [],
      coordinator: false,
      coordinatorId: null,
      parentId: null,
      createdAt: session.created_at,
      can: { rename: false, reset: false, end: false },
      showsSessionTitle: false,
    })
  })

  it('builds a free-standing ad hoc View', () => {
    const session = makeSession('ownTmux', { is_external: true })
    const slot = sessionToSlot(session, {
      as: 'adhoc',
      place: 'free',
      projectName: 'Neri',
    })
    expect(slot).toEqual({
      type: 'adhoc',
      sessionId: 'ownTmux-session',
      name: 'Neri · Incident review',
      workingDir: '/workspace/neri',
      sessionMode: 'codex',
      isExternal: true,
      task: undefined,
      projectLabel: null,
      badge: null,
      checkIns: [],
      coordinator: false,
      coordinatorId: null,
      parentId: null,
      createdAt: session.created_at,
      can: { rename: false, reset: false, end: false },
      showsSessionTitle: false,
    })
  })

  it('builds an ad hoc slot for a session without a project even when asked for a project slot', () => {
    const slot = sessionToSlot(makeSession('tether', { project_id: null }), {
      as: 'project',
      place: 'unloaded',
    })
    expect(slot).toMatchObject({ type: 'adhoc', isExternal: false })
  })
})

describe('paneSessionsAsSessions', () => {
  it('places pane sessions in the pane project and order and keeps every session field', () => {
    const tether = makeSession('tether', {
      project_id: null,
      display_order: 7,
      task: 'Focus',
    })
    const own = makeSession('ownTmux', { mode: 'shell' })
    const sessions = paneSessionsAsSessions(makePane('project', [tether, own]))
    expect(sessions).toEqual([
      {
        ...tether,
        user_id: null,
        project_id: 'neri',
        display_order: 0,
        created_at: '2026-10-01T00:00:00Z',
        last_accessed_at: '2026-10-01T00:00:00Z',
      },
      {
        ...own,
        user_id: null,
        project_id: 'neri',
        display_order: 1,
        created_at: '2026-10-01T00:00:00Z',
        last_accessed_at: '2026-10-01T00:00:00Z',
      },
    ])
  })
})

describe('paneToSlot', () => {
  it.each(['Focus', 'Project X — Focus'])(
    'shows a root pane under the title Tether gives it: %s',
    (name) => {
      const root = makeSession('root', { name, project_id: 'project-x' })
      const pane = makePane('project', [root], {
        project_id: 'project-x',
        pane_name: 'Root: exact-request',
      })
      expect(paneToSlot(pane)).toMatchObject({
        projectName: name,
        activeSessionId: 'root-session',
        can: { rename: true, reset: false, end: true },
        showsSessionTitle: true,
      })
    },
  )

  it('keeps the pane name for a session Tether does not own', () => {
    const pane = makePane('project', [makeSession('ownTmux')], {
      pane_name: 'Root: exact-request',
    })
    expect(paneToSlot(pane)).toMatchObject({
      projectName: 'Root: exact-request',
      can: { rename: false, reset: false, end: false },
      showsSessionTitle: false,
    })
  })

  it("opens a project pane on its mode's session, else its shell", () => {
    const shell = makeSession('tether', { id: 's1', mode: 'shell' })
    const agent = makeSession('tether', { id: 's2', mode: 'claude' })
    const pane = makePane('project', [shell, agent], { active_mode: 'claude' })
    expect(paneToSlot(pane)).toMatchObject({
      paneId: 'pane-1',
      activeMode: 'claude',
      activeSessionId: 's2',
    })
    // A stale mode (no codex session here) falls back to the shell.
    expect(
      paneToSlot({ ...pane, active_mode: 'codex', sessions: [shell] }),
    ).toMatchObject({ activeMode: 'shell', activeSessionId: 's1' })
  })

  it('maps an adhoc pane to its one session', () => {
    const shell = makeSession('ownTmux', { id: 's3', mode: 'shell' })
    expect(
      paneToSlot(makePane('adhoc', [shell], { pane_name: 'Ad-Hoc' })),
    ).toMatchObject({
      type: 'adhoc',
      paneId: 'pane-1',
      sessionId: 's3',
      name: 'Ad-Hoc',
      workingDir: '/workspace/neri',
      sessionMode: 'shell',
    })
  })

  it('offers no Reset on an adhoc pane holding a root session, nor its title without a task', () => {
    const slot = paneToSlot(
      makePane('adhoc', [makeSession('root', { project_id: null })]),
    )

    expect(slot).toMatchObject({
      type: 'adhoc',
      can: { rename: true, reset: false, end: true },
      showsSessionTitle: false,
    })
  })

  it('offers nothing on a pane without a session', () => {
    expect(paneToSlot(makePane('project', []))).toMatchObject({
      projectName: 'Pane name',
      activeSessionId: null,
      can: { rename: false, reset: false, end: false },
      showsSessionTitle: false,
    })
    expect(paneToSlot(makePane('adhoc', []))).toMatchObject({
      sessionId: '',
      name: 'Pane name',
      can: { rename: false, reset: false, end: false },
    })
  })

  it.each([
    ['adhoc', null],
    ['project', 'proj'],
  ] as const)(
    'names a %s pane after its Tether session',
    (paneType, projectId) => {
      const coordinator = makeSession('tether', {
        name: 'Coordinator',
        task: 'Coordinator',
        is_coordinator: true,
        badge: { kind: 'coordinator', text: 'Coordinator', color: '#f0a35e' },
        mode: 'shell',
      })
      const slot = paneToSlot(
        makePane(paneType, [coordinator], {
          project_id: projectId,
          pane_name: 'Old pane name',
        }),
      )

      expect(slot.type === 'project' ? slot.projectName : slot.name).toBe(
        'Coordinator',
      )
      expect(slot.can).toEqual({ rename: true, reset: true, end: true })
      expect(slot.showsSessionTitle).toBe(true)
      expect(slot.task).toBe('Coordinator')
      expect(slot.badge).toEqual({ label: 'Coordinator', color: '#f0a35e' })
    },
  )
})
