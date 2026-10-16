import { describe, expect, it } from 'vitest'
import type { ATermPane } from '@/lib/hooks/use-a-term-panes'
import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'
import {
  LEGACY_CAN,
  OWN_TMUX_CAN,
  ROOT_CAN,
  SESSION_BASE,
  SLOT_BASE,
  TETHER_CAN,
} from '@/test-stubs/session-fixtures'
import type { AdHocSlot, ProjectSlot } from './slot'
import {
  getPaneId,
  getSlotBaseName,
  getSlotName,
  getSlotPanelId,
  getSlotSessionId,
  getSlotWorkingDir,
  isPaneSlot,
  type PaneSlot,
  paneSessionsAsSessions,
  paneToSlot,
  sessionTitle,
  sessionToSlot,
} from './slot'

const makeProjectSlot = (overrides?: Partial<ProjectSlot>): ProjectSlot => ({
  type: 'project',
  ...SLOT_BASE,
  projectId: 'proj-1',
  projectName: 'My Project',
  rootPath: '/home/user/project',
  activeMode: 'shell',
  activeSessionId: 'session-abc',
  sessionBadge: null,
  ...overrides,
})

const makeAdHocSlot = (overrides?: Partial<AdHocSlot>): AdHocSlot => ({
  type: 'adhoc',
  ...SLOT_BASE,
  sessionId: 'adhoc-123',
  name: 'Ad Hoc A-Term',
  workingDir: '/tmp',
  ...overrides,
})

describe('getSlotSessionId', () => {
  it('returns activeSessionId for project slot', () => {
    const slot = makeProjectSlot({ activeSessionId: 'sess-42' })
    expect(getSlotSessionId(slot)).toBe('sess-42')
  })

  it('returns null when project slot has no active session', () => {
    const slot = makeProjectSlot({ activeSessionId: null })
    expect(getSlotSessionId(slot)).toBeNull()
  })

  it('returns sessionId for adhoc slot', () => {
    const slot = makeAdHocSlot({ sessionId: 'adhoc-99' })
    expect(getSlotSessionId(slot)).toBe('adhoc-99')
  })
})

describe('getSlotPanelId', () => {
  it('returns project-prefixed id for project slot', () => {
    const slot = makeProjectSlot({ projectId: 'p-1' })
    expect(getSlotPanelId(slot)).toBe('project-p-1')
  })

  it('returns adhoc-prefixed id for adhoc slot', () => {
    const slot = makeAdHocSlot({ sessionId: 's-2' })
    expect(getSlotPanelId(slot)).toBe('adhoc-s-2')
  })

  it('returns pane-prefixed id for pane-based slots', () => {
    const slot: PaneSlot = {
      ...makeProjectSlot({ projectId: 'p-1' }),
      paneId: 'pane-123',
    }
    expect(getSlotPanelId(slot)).toBe('pane-pane-123')
  })
})

describe('getSlotName', () => {
  it('returns project name when badge is null', () => {
    const slot = makeProjectSlot({ projectName: 'Foo', sessionBadge: null })
    expect(getSlotName(slot)).toBe('Foo')
  })

  it('returns project name when badge is 1', () => {
    const slot = makeProjectSlot({ projectName: 'Foo', sessionBadge: 1 })
    expect(getSlotName(slot)).toBe('Foo')
  })

  it('returns project name with badge when badge > 1', () => {
    const slot = makeProjectSlot({ projectName: 'Foo', sessionBadge: 3 })
    expect(getSlotName(slot)).toBe('Foo [3]')
  })

  it('returns name for adhoc slot', () => {
    const slot = makeAdHocSlot({ name: 'My A-Term' })
    expect(getSlotName(slot)).toBe('My A-Term')
  })
})

describe('getSlotBaseName', () => {
  it('returns project name without badge for project slot', () => {
    const slot = makeProjectSlot({ projectName: 'Bar', sessionBadge: 5 })
    expect(getSlotBaseName(slot)).toBe('Bar')
  })

  it('returns name for adhoc slot', () => {
    const slot = makeAdHocSlot({ name: 'A-Term X' })
    expect(getSlotBaseName(slot)).toBe('A-Term X')
  })
})

describe('getSlotWorkingDir', () => {
  it('returns rootPath for project slot', () => {
    const slot = makeProjectSlot({ rootPath: '/home/user/code' })
    expect(getSlotWorkingDir(slot)).toBe('/home/user/code')
  })

  it('returns null when project slot has no rootPath', () => {
    const slot = makeProjectSlot({ rootPath: null })
    expect(getSlotWorkingDir(slot)).toBeNull()
  })

  it('returns workingDir for adhoc slot', () => {
    const slot = makeAdHocSlot({ workingDir: '/var/log' })
    expect(getSlotWorkingDir(slot)).toBe('/var/log')
  })
})

describe('isPaneSlot', () => {
  it('returns true for slot with paneId', () => {
    const paneSlot: PaneSlot = {
      ...makeProjectSlot(),
      paneId: 'pane-1',
    }
    expect(isPaneSlot(paneSlot)).toBe(true)
  })

  it('returns false for slot without paneId', () => {
    const slot = makeProjectSlot()
    expect(isPaneSlot(slot)).toBe(false)
  })
})

describe('getPaneId', () => {
  it('returns the pane ID from a PaneSlot', () => {
    const paneSlot: PaneSlot = {
      ...makeProjectSlot(),
      paneId: 'pane-42',
    }
    expect(getPaneId(paneSlot)).toBe('pane-42')
  })
})

// One session per kind, as the backend lists it: `source`, the informational
// flags and the capability flags (a_term/services/session_capabilities.py).
const KINDS = {
  tether: { source: 'tether', ...TETHER_CAN },
  root: { source: 'tether', is_root: true, ...ROOT_CAN },
  legacy: { source: 'legacy', is_legacy: true, ...LEGACY_CAN },
  ownTmux: { source: 'tmux_external', ...OWN_TMUX_CAN },
} satisfies Record<string, Partial<ATermSession>>
type Kind = keyof typeof KINDS

function makeSession(
  kind: Kind,
  overrides: Partial<ATermSession> = {},
): ATermSession {
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
  paneType: ATermPane['pane_type'],
  sessions: ATermSession[],
  overrides: Partial<ATermPane> = {},
): ATermPane {
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
    width_percent: 100,
    height_percent: 100,
    grid_row: 0,
    grid_col: 0,
    ...overrides,
  }
}

describe('sessionTitle', () => {
  it.each([
    // kind, pane, free-standing, linked to a pane not loaded here
    ['tether', 'Incident review', 'Incident review', 'Incident review'],
    ['root', 'Incident review', 'Incident review', 'Incident review'],
    ['legacy', 'Pane name', 'Neri · Incident review', 'Neri'],
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
    expect(sessionTitle(makeSession('legacy'), { place: 'unloaded' })).toBe(
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
    ['legacy', 'free', false, false, true],
    ['legacy', 'unloaded', false, false, true],
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
    ['legacy', 'project', 'Focus', false],
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

  it('shows the session title for a Tether session with a coordinator chip', () => {
    const session = makeSession('tether', {
      badge: { kind: 'coordinator', text: 'Coordinator', color: '#f0a35e' },
    })
    const slot = sessionToSlot(session, { as: 'adhoc', place: 'unloaded' })
    expect(slot.showsSessionTitle).toBe(true)
    expect(slot.badge).toEqual({ label: 'Coordinator', color: '#f0a35e' })
  })

  it('builds a project slot for a linked session whose pane is not loaded here', () => {
    const slot = sessionToSlot(makeSession('legacy', { mode: 'shell' }), {
      as: 'project',
      place: 'unloaded',
      projectName: 'Neri',
      slotId: 'session-legacy-session',
    })
    expect(slot).toEqual({
      slotId: 'session-legacy-session',
      type: 'project',
      projectId: 'neri',
      projectName: 'Neri',
      rootPath: '/workspace/neri',
      activeMode: 'shell',
      activeSessionId: 'legacy-session',
      sessionBadge: null,
      claudeState: 'running',
      task: undefined,
      badge: null,
      can: { rename: false, reset: false, end: true },
      showsSessionTitle: false,
    })
  })

  it('builds a free-standing ad hoc View', () => {
    const slot = sessionToSlot(makeSession('ownTmux', { is_external: true }), {
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
      badge: null,
      can: { rename: false, reset: false, end: false },
      showsSessionTitle: false,
    })
    expect(getSlotPanelId(slot)).toBe('adhoc-ownTmux-session')
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
    const legacy = makeSession('legacy', { mode: 'shell' })
    const sessions = paneSessionsAsSessions(
      makePane('project', [tether, legacy]),
    )
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
        ...legacy,
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
    const pane = makePane('project', [makeSession('legacy')], {
      pane_name: 'Root: exact-request',
    })
    expect(paneToSlot(pane)).toMatchObject({
      projectName: 'Root: exact-request',
      can: { rename: false, reset: false, end: true },
      showsSessionTitle: false,
    })
  })

  it('converts a project pane to a PaneBasedSlot with agent state', () => {
    const slot = paneToSlot({
      id: 'pane-1',
      pane_type: 'project',
      project_id: 'proj-x',
      pane_order: 0,
      pane_name: 'A-Term',
      active_mode: 'shell',
      is_detached: false,
      created_at: null,
      width_percent: 50,
      height_percent: 100,
      grid_row: 0,
      grid_col: 0,
      sessions: [
        {
          ...SESSION_BASE,
          id: 's1',
          name: 'Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/ws',
          claude_state: 'not_started',
        },
        {
          ...SESSION_BASE,
          id: 's2',
          name: 'Agent',
          mode: 'claude',
          session_number: 2,
          is_alive: true,
          working_dir: '/ws',
          claude_state: 'running',
        },
      ],
    })

    expect(slot.type).toBe('project')
    expect(slot.paneId).toBe('pane-1')
    if (slot.type === 'project') {
      expect(slot.projectId).toBe('proj-x')
      expect(slot.activeSessionId).toBe('s1')
      expect(slot.claudeState).toBe('running')
    }
  })

  it('falls back to a live shell session when project active_mode is stale', () => {
    const slot = paneToSlot({
      id: 'pane-1',
      pane_type: 'project',
      project_id: 'proj-x',
      pane_order: 0,
      pane_name: 'A-Term',
      active_mode: 'codex',
      is_detached: false,
      created_at: null,
      width_percent: 50,
      height_percent: 100,
      grid_row: 0,
      grid_col: 0,
      sessions: [
        {
          ...SESSION_BASE,
          id: 's1',
          name: 'Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/ws',
          claude_state: 'not_started',
        },
      ],
    })

    expect(slot.type).toBe('project')
    if (slot.type === 'project') {
      expect(slot.activeMode).toBe('shell')
      expect(slot.activeSessionId).toBe('s1')
    }
  })

  it('converts an adhoc pane to an AdHocPaneSlot', () => {
    const slot = paneToSlot({
      id: 'pane-2',
      pane_type: 'adhoc',
      project_id: null,
      pane_order: 1,
      pane_name: 'Ad-Hoc',
      active_mode: 'shell',
      is_detached: false,
      created_at: null,
      width_percent: 100,
      height_percent: 100,
      grid_row: 0,
      grid_col: 0,
      sessions: [
        {
          ...SESSION_BASE,
          id: 's3',
          name: 'Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/tmp',
          claude_state: 'not_started',
        },
      ],
    })

    expect(slot.type).toBe('adhoc')
    expect(slot.paneId).toBe('pane-2')
    if (slot.type === 'adhoc') {
      expect(slot.sessionId).toBe('s3')
      expect(slot.name).toBe('Ad-Hoc')
      expect(slot.workingDir).toBe('/tmp')
      expect(slot.sessionMode).toBe('shell')
    }
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
      const slot = paneToSlot({
        id: 'pane-3',
        pane_type: paneType,
        project_id: projectId,
        pane_order: 0,
        pane_name: 'Old pane name',
        active_mode: 'shell',
        is_detached: false,
        created_at: null,
        width_percent: 100,
        height_percent: 100,
        grid_row: 0,
        grid_col: 0,
        sessions: [
          {
            ...SESSION_BASE,
            id: 's4',
            name: 'Coordinator',
            task: 'Coordinator',
            is_coordinator: true,
            badge: {
              kind: 'coordinator',
              text: 'Coordinator',
              color: '#f0a35e',
            },
            mode: 'shell',
            session_number: 1,
            is_alive: true,
            source: 'tether',
            working_dir: '/tmp',
            claude_state: 'not_started',
          },
        ],
      })

      expect(getSlotName(slot)).toBe('Coordinator')
      expect(slot.can).toEqual({ rename: true, reset: true, end: true })
      expect(slot.showsSessionTitle).toBe(true)
      expect(slot.task).toBe('Coordinator')
      expect(slot.badge).toEqual({ label: 'Coordinator', color: '#f0a35e' })
    },
  )
})
